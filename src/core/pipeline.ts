import { exec, execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type { PlatformAdapter, NormalizedMessage } from "../im/types.js";
import type { AgentBackend, AgentSession } from "../agent/types.js";
import { MessageQueue } from "./queue.js";
import {
  ensureUser, ensureChat, storeMessage, updateChatName,
  getUserShortLabel, getChatShortLabel, getMessageByPlatformId, updateMessageContent, updateMessagePlatformId,
} from "../database/schema.js";
import { buildImportantContext, buildNormalContext, type SceneInfo } from "../memory/inject.js";
import { loadPersona } from "../persona.js";
import { ARCHIVE_SUMMARY_PROMPT } from "./prompts.js";
import { decideRoute, type RouteDecision } from "./routing.js";
import { createLogger } from "../logger.js";

const execAsync = promisify(exec);

const PROCESSING_EMOJI = "Get";
const MERGED_EMOJI = "Pin";

/** 过期消息阈值（ms）：超过 2 分钟的消息丢弃 */
const STALE_MESSAGE_THRESHOLD_MS = 2 * 60 * 1000;

/** 短词打断关键词 */
const INTERRUPT_WORDS = new Set(["停", "算了", "取消", "stop", "cancel", "abort"]);

/** Bot 身份信息，由外部传入 */
export interface BotIdentity {
  /** Bot 显示名称（如 "CowBot"，从平台 API 获取或 config 指定） */
  name: string;
  /** IM 平台标识（如 "feishu"） */
  platform: string;
  /** Bot 在平台上的唯一标识（用于 DB 中的 bot 用户记录） */
  platformBotId: string;
  /** 轻量模型 ID（可选，覆盖 backend 默认值） */
  liteModel?: string;
  /** Admin 用户的 platform ID 列表 */
  adminPlatformIds?: string[];
  /** 人设文件路径（注入到 admin 的场景信息中） */
  personaPath?: string;
}

interface ChatSession {
  agentSession: AgentSession;
  sessionKey: string;
  platformChatId: string;
  userId: string;
  /** 触发消息的 platform msg ID（用于首条回复时引用） */
  triggerPlatformMsgId?: string;
  /** 是否已发送过回复（首条用 reply，后续用普通 send） */
  hasReplied: boolean;
}

export class Pipeline {
  private db: Database.Database;
  private im: PlatformAdapter;
  private agent: AgentBackend;
  private queue: MessageQueue;
  private botIdentity: BotIdentity;
  private log: ReturnType<typeof createLogger>;

  /** 每个 chat 的当前 agent session */
  private chatSessions = new Map<string, ChatSession>();

  /** chatId → platformChatId 映射 */
  private platformChatIds = new Map<string, string>();

  /** chatId → userId 映射 */
  private chatUserIds = new Map<string, string>();

  /** bot 的内部用户 ID */
  private botUserId: string | null = null;

  /** admin 内部用户 ID 集合 */
  private adminUserIds = new Set<string>();

  /** agent 工作目录 */
  private workingDirectory: string;

  /** 数据库路径（传递给 agent 子进程） */
  private dbPath: string;

  /** 启动时间戳，用于 /status 计算 uptime */
  private startedAt = Date.now();

  /** 已处理的消息 ID 去重集合（有上限防内存泄漏） */
  private processedMsgIds = new Set<string>();
  private static readonly MAX_PROCESSED_IDS = 10000;

  /** 正在归档的 chatId 集合，期间 cancel 不发送到 agent（保护摘要 prompt） */
  private archivingChats = new Set<string>();

  /** chatId → triggerPlatformMsgId，暂存触发消息 ID */
  private triggerMsgIds = new Map<string, string>();

  constructor(
    db: Database.Database,
    im: PlatformAdapter,
    agent: AgentBackend,
    botIdentity: BotIdentity,
    workingDirectory: string,
    dbPath: string,
    bufferMs: number,
    cancelThresholdMs: number,
  ) {
    this.db = db;
    this.im = im;
    this.agent = agent;
    this.botIdentity = botIdentity;
    this.workingDirectory = workingDirectory;
    this.dbPath = dbPath;
    this.log = createLogger("pipeline", botIdentity.name);
    this.queue = new MessageQueue(bufferMs, cancelThresholdMs);

    this.queue.onProcess((chatId, mergedText, messages) => this.process(chatId, mergedText, messages));
    this.queue.onCancel((chatId) => this.cancelChat(chatId));
    this.queue.onPending((msg) => {
      const platformChatId = this.platformChatIds.get(msg.chatId);
      if (platformChatId && msg.platformMsgId) {
        this.im.addReaction(platformChatId, msg.platformMsgId, MERGED_EMOJI).catch(() => {});
      }
    });
  }

  /** 启动管道：注册 IM 消息回调 */
  async start(): Promise<void> {
    // Resolve bot's real open_id and name from platform
    try {
      const [realBotId, platformBotName] = await Promise.all([
        this.im.getBotOpenId(),
        this.im.getBotName(),
      ]);
      if (realBotId) {
        this.botIdentity.platformBotId = realBotId;
      }
      if (platformBotName) {
        this.botIdentity.name = platformBotName;
        this.log.info("bot name updated from platform", { name: platformBotName });
      }
    } catch (err) {
      this.log.warn("failed to fetch bot identity", { error: String(err) });
    }

    this.botUserId = ensureUser(
      this.db,
      this.botIdentity.platform,
      this.botIdentity.platformBotId,
      this.botIdentity.name,
      "bot_info",
    );

    // Detect admin users
    await this.detectAdmins();

    this.im.onMessage((msg) => this.handleMessage(msg));
    this.log.info("pipeline started", {
      botUserId: this.botUserId,
      botPlatformId: this.botIdentity.platformBotId,
      adminCount: this.adminUserIds.size,
    });
  }

  /** 停止管道：清除队列计时器 */
  stop(): void {
    this.queue.stop();
    this.log.info("pipeline stopped");
  }

  /** 优雅关闭：cancel 所有活跃 session，清理资源（DB 中 session 保持 active，下次启动恢复） */
  async shutdown(): Promise<void> {
    for (const [chatId, session] of this.chatSessions) {
      try {
        // 更新 DB 最后活跃时间
        this.db.prepare("UPDATE sessions SET last_active_at = datetime('now') WHERE id = ?")
          .run(session.sessionKey);
        await this.agent.cancelSession(session.agentSession);
        await this.agent.closeSession(session.agentSession);
      } catch (err) {
        this.log.warn("failed to close session during shutdown", { chatId, error: String(err) });
      }
    }
    this.chatSessions.clear();
  }

  /** 是否有正在处理的 chat */
  hasBusyChats(): boolean {
    return this.queue.hasBusyChats();
  }

  /** 检查用户是否为 admin */
  isAdmin(userId: string): boolean {
    return this.adminUserIds.has(userId);
  }

  /** 获取 bot 用户 ID */
  getBotUserId(): string | null {
    return this.botUserId;
  }

  /** 通过 IPC 发送消息到指定 chat */
  async sendToChat(platformChatId: string, text: string): Promise<void> {
    const platformMsgId = await this.im.sendText(platformChatId, text);
    const chatRow = this.db.prepare("SELECT id FROM chats WHERE platform_id = ?")
      .get(platformChatId) as { id: string } | undefined;
    if (chatRow) {
      this.storeBotResponse(chatRow.id, text, platformMsgId);
    }
  }

  /** 通过 IPC 发送文件到指定 chat */
  async sendFileToChat(platformChatId: string, filePath: string): Promise<void> {
    const platformMsgId = await this.im.sendFile(platformChatId, filePath);
    const chatRow = this.db.prepare("SELECT id FROM chats WHERE platform_id = ?")
      .get(platformChatId) as { id: string } | undefined;
    if (chatRow) {
      this.storeBotResponse(chatRow.id, `[文件] ${filePath}`, platformMsgId, "file");
    }
  }

  /**
   * 注入 prompt 到 agent pipeline（用于 cron 等内部触发场景）。
   * 和用户消息走相同的 queue → process → agent 链路。
   */
  injectPrompt(chatId: string, userId: string, text: string): void {
    // Ensure maps are populated so getOrCreateSession can find the chat
    if (!this.platformChatIds.has(chatId)) {
      const row = this.db.prepare("SELECT platform_id FROM chats WHERE id = ?")
        .get(chatId) as { platform_id: string } | undefined;
      if (!row) {
        this.log.warn("injectPrompt: chat not found", { chatId });
        return;
      }
      this.platformChatIds.set(chatId, row.platform_id);
    }
    if (!this.chatUserIds.has(chatId)) {
      this.chatUserIds.set(chatId, userId);
    }

    this.queue.push({ chatId, text, timestamp: Date.now() });
  }

  /** 进程恢复：从 DB 恢复 active sessions，重建 backend session */
  async recover(): Promise<void> {
    const rows = this.db.prepare(`
      SELECT s.id, s.chat_id, s.user_id, s.agent_session_id, c.platform_id, c.type
      FROM sessions s
      JOIN chats c ON s.chat_id = c.id
      WHERE s.status = 'active'
      ORDER BY s.last_active_at DESC
    `).all() as Array<{
      id: string;
      chat_id: string;
      user_id: string | null;
      agent_session_id: string | null;
      platform_id: string;
      type: string;
    }>;

    if (rows.length === 0) return;

    // 每个 chat 只恢复最近的一个 session，跳过重复
    const seen = new Set<string>();
    const uniqueRows = rows.filter((r) => {
      if (seen.has(r.chat_id)) return false;
      seen.add(r.chat_id);
      return true;
    });

    this.log.info("recovering active sessions", { count: uniqueRows.length });

    for (const row of uniqueRows) {
      const chatType = (row.type ?? "p2p") as "p2p" | "group";

      // 重建 important 上下文
      const userRow = row.user_id
        ? this.db.prepare("SELECT name FROM users WHERE id = ?").get(row.user_id) as { name: string | null } | undefined
        : undefined;
      const isAdmin = row.user_id ? this.adminUserIds.has(row.user_id) : false;
      const persona = this.botIdentity.personaPath ? loadPersona(this.botIdentity.personaPath) : undefined;
      const importantContext = row.user_id
        ? buildImportantContext(this.db, {
            botName: this.botIdentity.name,
            botLabel: this.botUserId ? getUserShortLabel(this.db, this.botUserId) : undefined,
            userName: userRow?.name ?? undefined,
            userId: row.user_id,
            chatId: row.chat_id,
            chatLabel: getChatShortLabel(this.db, row.chat_id),
            chatType,
            isAdmin,
            personaPath: isAdmin ? this.botIdentity.personaPath : undefined,
            personaContent: persona,
          })
        : undefined;

      try {
        const supportsSystemPrompt = this.agent.supportsSystemPrompt !== false;

        const agentSession = await this.agent.createSession({
          workingDirectory: this.workingDirectory,
          importantContext: supportsSystemPrompt ? (importantContext || undefined) : undefined,
          userId: row.user_id ?? undefined,
          chatId: row.chat_id,
          chatType,
          dbPath: this.dbPath,
          botId: this.botIdentity.platformBotId,
          botName: this.botIdentity.name,
          liteModel: this.botIdentity.liteModel,
          isAdmin,
          agentSessionId: row.agent_session_id ?? undefined,
        });

        // fallback 模式下 recover 也需要注入 important context（agent session 是全新的）
        if (!supportsSystemPrompt && importantContext) {
          this.pendingImportantContext.set(row.chat_id, importantContext);
        }

        this.chatSessions.set(row.chat_id, {
          agentSession,
          sessionKey: row.id,
          platformChatId: row.platform_id,
          userId: row.user_id ?? "",
          hasReplied: true, // recovered sessions skip reply-to
        });
        this.platformChatIds.set(row.chat_id, row.platform_id);
        if (row.user_id) this.chatUserIds.set(row.chat_id, row.user_id);

        this.log.info("session recovered", { chatId: row.chat_id, sessionKey: row.id });
      } catch (err) {
        this.log.error("failed to recover session", {
          chatId: row.chat_id,
          sessionKey: row.id,
          error: String(err),
        });
      }
    }
  }

  private handleMessage(msg: NormalizedMessage): void {
    const platform = this.botIdentity.platform;

    // 消息去重（飞书 WebSocket 可能重复推送）
    if (msg.platformMsgId && this.processedMsgIds.has(msg.platformMsgId)) {
      this.log.debug("duplicate message, skipping", { platformMsgId: msg.platformMsgId });
      return;
    }
    if (msg.platformMsgId) {
      this.processedMsgIds.add(msg.platformMsgId);
      if (this.processedMsgIds.size > Pipeline.MAX_PROCESSED_IDS) {
        this.processedMsgIds.clear();
      }
    }

    // 过期消息检测（>2min 丢弃）
    if (msg.platformTs) {
      const delay = Date.now() - msg.platformTs;
      if (delay > STALE_MESSAGE_THRESHOLD_MS) {
        this.log.warn("stale message, dropping", {
          chatId: msg.chatPlatformId,
          delayMs: delay,
          msgId: msg.platformMsgId,
        });
        if (msg.platformMsgId) {
          this.im.addReaction(msg.chatPlatformId, msg.platformMsgId, "Alarm").catch(() => {});
        }
        return;
      }
    }

    // 群聊触发检测：需要 @bot 或 reply-to-bot
    if (msg.chatType === "group" && !msg.botMentioned) {
      // Check if it's a reply to bot's message
      const isReplyToBot = msg.parentPlatformMsgId
        ? this.isMessageFromBot(platform, msg.parentPlatformMsgId)
        : false;

      if (!isReplyToBot) {
        // 群聊中未 @ bot 也未回复 bot，只存消息不触发
        this.storeMessageOnly(msg, platform);
        return;
      }
    }

    // Collect user info from mentions
    if (msg.mentions) {
      for (const m of msg.mentions) {
        if (!m.isBot && m.platformUserId && m.name) {
          ensureUser(this.db, platform, m.platformUserId, m.name, "mention");
        }
      }
    }

    const userId = ensureUser(this.db, platform, msg.senderPlatformId, msg.senderName, "bot_sender");

    // For p2p chats, link user_id
    const chatUserId = msg.chatType === "p2p" ? msg.senderPlatformId : undefined;
    const chatId = ensureChat(this.db, platform, msg.chatPlatformId, msg.chatType, msg.chatName, chatUserId);

    // Fetch group chat name if not known
    if (msg.chatType === "group") {
      const chatRow = this.db.prepare("SELECT name FROM chats WHERE id = ?").get(chatId) as { name: string | null } | undefined;
      if (!chatRow?.name) {
        this.im.getChatName(msg.chatPlatformId).then((name) => {
          if (name) updateChatName(this.db, chatId, name);
        }).catch(() => {});
      }
    }

    // Build display text with group sender annotation
    let displayText = msg.contentText;
    if (msg.chatType === "group") {
      const label = getUserShortLabel(this.db, userId);
      displayText = `[${label}]: ${msg.contentText}`;
    }

    // Build reply context
    let replyContext = "";
    if (msg.parentPlatformMsgId) {
      replyContext = this.buildReplyContext(platform, msg.parentPlatformMsgId);
    }

    // Store platform_ts as ISO string
    const platformTsStr = msg.platformTs
      ? new Date(msg.platformTs).toISOString().slice(0, 19).replace("T", " ")
      : undefined;

    const sessionKey = this.chatSessions.get(chatId)?.sessionKey;
    storeMessage(this.db, {
      chatId,
      senderId: userId,
      sessionKey,
      role: "user",
      contentText: msg.contentText,
      contentType: msg.contentType,
      platform,
      platformMsgId: msg.platformMsgId,
      platformTs: platformTsStr,
      platformRaw: JSON.stringify(msg.raw),
    });

    this.log.info("message received", {
      chatId, userId,
      type: msg.contentType,
      textLength: msg.contentText.length,
      mentions: msg.mentions?.length ?? 0,
      hasParent: !!msg.parentPlatformMsgId,
    });

    // 缓存映射
    this.platformChatIds.set(chatId, msg.chatPlatformId);
    this.chatUserIds.set(chatId, userId);

    // Prepare text to send to agent (with reply context and sender annotation)
    let agentText = displayText;
    if (replyContext) {
      agentText = `${replyContext}\n${displayText}`;
    }

    // Save trigger msg ID for reply-to-message（process() 会快照并清除）
    if (msg.platformMsgId) {
      this.triggerMsgIds.set(chatId, msg.platformMsgId);
    }

    // 短词打断检测
    const trimmedText = msg.contentText.trim().toLowerCase();
    if (INTERRUPT_WORDS.has(trimmedText) && this.chatSessions.has(chatId)) {
      this.log.info("interrupt word detected", { chatId, word: trimmedText });
      this.cancelChat(chatId).catch(() => {});
      const interruptText = "好的，已停止。";
      this.im.sendText(msg.chatPlatformId, interruptText).then((pmid) => {
        this.storeBotResponse(chatId, interruptText, pmid);
      }).catch(() => {});
      return;
    }

    // 内置命令拦截：/xxx 开头的消息先匹配内置命令，命中则不传给 agent
    if (this.handleBuiltinCommand(msg.contentText.trim(), userId, chatId, msg.chatPlatformId, msg.platformMsgId)) {
      return;
    }

    // Reaction 策略：Get = 正在处理，Pin = 排队等待，互斥
    const isPending = this.queue.push({
      chatId,
      text: agentText,
      timestamp: Date.now(),
      platformMsgId: msg.platformMsgId,
    });
    if (!isPending && msg.platformMsgId) {
      this.im.addReaction(msg.chatPlatformId, msg.platformMsgId, PROCESSING_EMOJI).catch(() => {});
    }
  }

  /** Store a bot-sent message in DB */
  private storeBotResponse(chatId: string, text: string, platformMsgId?: string, contentType?: string): void {
    if (!this.botUserId) return;
    storeMessage(this.db, {
      chatId,
      senderId: this.botUserId,
      sessionKey: this.chatSessions.get(chatId)?.sessionKey,
      role: "assistant",
      contentText: text,
      contentType,
      platform: this.botIdentity.platform,
      platformMsgId,
    });
  }

  /** Store message without triggering agent (for group chat non-targeted messages) */
  private storeMessageOnly(msg: NormalizedMessage, platform: string): void {
    const userId = ensureUser(this.db, platform, msg.senderPlatformId, msg.senderName, "bot_sender");
    const chatId = ensureChat(this.db, platform, msg.chatPlatformId, msg.chatType, msg.chatName);

    const platformTsStr = msg.platformTs
      ? new Date(msg.platformTs).toISOString().slice(0, 19).replace("T", " ")
      : undefined;

    storeMessage(this.db, {
      chatId,
      senderId: userId,
      role: "user",
      contentText: msg.contentText,
      contentType: msg.contentType,
      platform,
      platformMsgId: msg.platformMsgId,
      platformTs: platformTsStr,
      platformRaw: JSON.stringify(msg.raw),
    });

    // Collect mentions
    if (msg.mentions) {
      for (const m of msg.mentions) {
        if (!m.isBot && m.platformUserId && m.name) {
          ensureUser(this.db, platform, m.platformUserId, m.name, "mention");
        }
      }
    }
  }

  /** Check if a platform message was sent by the bot */
  private isMessageFromBot(platform: string, platformMsgId: string): boolean {
    const msg = getMessageByPlatformId(this.db, platform, platformMsgId);
    return msg?.senderId === this.botUserId;
  }

  /** Build reply context string from a parent message using unified rendering */
  private buildReplyContext(platform: string, parentPlatformMsgId: string): string {
    // First try DB
    const dbMsg = getMessageByPlatformId(this.db, platform, parentPlatformMsgId);
    if (dbMsg?.contentText) {
      const label = getUserShortLabel(this.db, dbMsg.senderId);
      const escaped = dbMsg.contentText.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
      return `quoted:\n  msg: "${label}: ${escaped}"`;
    }

    // Fallback: try API (async — cache result for next time)
    this.im.getMessageContent(parentPlatformMsgId).then((content) => {
      if (content && dbMsg) {
        // Update the existing message's content for future lookups
        updateMessageContent(this.db, dbMsg.id, content);
        this.log.debug("fetched and cached reply context from API", { parentMsgId: parentPlatformMsgId });
      } else if (content) {
        this.log.debug("fetched reply context from API (no DB record to update)", { parentMsgId: parentPlatformMsgId });
      }
    }).catch(() => {});

    return "";
  }

  /** Detect admin users from platform + config */
  private async detectAdmins(): Promise<void> {
    const platform = this.botIdentity.platform;

    // 1. App creator
    try {
      const creatorId = await this.im.getAppCreatorId();
      if (creatorId) {
        const userId = ensureUser(this.db, platform, creatorId, undefined, undefined);
        this.adminUserIds.add(userId);
        this.log.info("admin detected (app creator)", { userId, platformId: creatorId });
      }
    } catch (err) {
      this.log.warn("failed to detect app creator", { error: String(err) });
    }

    // 2. Config adminUsers
    if (this.botIdentity.adminPlatformIds) {
      for (const pid of this.botIdentity.adminPlatformIds) {
        const userId = ensureUser(this.db, platform, pid, undefined, undefined);
        this.adminUserIds.add(userId);
        this.log.info("admin detected (config)", { userId, platformId: pid });
      }
    }
  }

  /**
   * 内置命令拦截：匹配 /xxx 格式的消息，命中则直接处理并返回 true。
   * 未命中返回 false，消息继续走 agent 流程。
   *
   * 分发顺序（对齐 cc-connect）：
   *   1. 内置命令 switch（/restart, /status）
   *   2. 管理员 shell 命令（tryShellCommand）
   *   3. return false → 转发给 agent
   */
  private handleBuiltinCommand(text: string, userId: string, chatId: string, platformChatId: string, msgId?: string): boolean {
    if (!text.startsWith("/")) return false;

    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const isAdmin = this.adminUserIds.has(userId);

    // 1. 内置命令
    switch (cmd) {
      case "/restart": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "restart 仅管理员可用。");
          return true;
        }
        this.log.info("builtin command: restart", { userId });
        this.replyText(chatId, platformChatId, msgId, "正在重启...");
        this.spawnRestart(platformChatId);
        return true;
      }
      case "/status": {
        this.log.info("builtin command: status", { userId });
        this.sendStatus(chatId, platformChatId, msgId);
        return true;
      }
    }

    // 2. 管理员 shell 命令：检查首个 token 是否在 PATH 中，是则执行，否则转发 agent
    if (isAdmin) {
      const shellCmd = text.slice(1); // 去掉 / 前缀
      const firstToken = shellCmd.split(/\s+/)[0];
      if (firstToken && commandExistsSync(firstToken)) {
        this.tryShellCommand(shellCmd, chatId, platformChatId, msgId);
        return true;
      }
    }

    // 3. 未识别的 / 命令，交给 agent 处理
    return false;
  }

  /** 回复文本：有 msgId 时引用回复，否则直接发送，并存入 DB */
  private replyText(chatId: string, platformChatId: string, msgId: string | undefined, text: string): void {
    const sendPromise = msgId
      ? this.im.sendReply(platformChatId, text, msgId)
      : this.im.sendText(platformChatId, text);
    sendPromise.then((pmid) => {
      this.storeBotResponse(chatId, text, pmid);
    }).catch(() => {});
  }

  /**
   * /status：输出 bot 运行状态信息。
   */
  private sendStatus(chatId: string, platformChatId: string, msgId?: string): void {
    const uptimeMs = Date.now() - this.startedAt;
    const uptimeStr = formatUptime(uptimeMs);

    const activeSessions = this.chatSessions.size;

    const cronRow = this.db.prepare(
      "SELECT COUNT(*) as count FROM cron_jobs WHERE status = 'active'",
    ).get() as { count: number } | undefined;
    const cronCount = cronRow?.count ?? 0;

    const content = [
      `**Bot:** ${this.botIdentity.name}`,
      `**Platform:** ${this.botIdentity.platform}`,
      `**Uptime:** ${uptimeStr}`,
      `**Active sessions:** ${activeSessions}`,
      `**Cron jobs:** ${cronCount}`,
      `**Working directory:** \`${this.workingDirectory}\``,
    ].join("\n");

    const send = msgId
      ? this.im.replyCard(msgId, "Status", content)
      : this.im.sendCard(platformChatId, "Status", content);
    send
      .then((pmid) => {
        this.storeBotResponse(chatId, content, pmid);
        this.log.info("status sent", { platformChatId });
      })
      .catch((err) => this.log.error("status send failed", { platformChatId, error: String(err) }));
  }

  /**
   * 管理员 shell 命令执行（对齐 cc-connect tryShellCommand）。
   * 通过 sh -c 执行，30s 超时。调用前已由 commandExistsSync 确认命令存在。
   */
  private tryShellCommand(cmd: string, chatId: string, platformChatId: string, msgId?: string): void {
    this.log.info("shell command", { cmd });

    const sendResult = (content: string) => {
      const sendPromise = msgId
        ? this.im.replyCard(msgId, "Shell", content)
        : this.im.sendCard(platformChatId, "Shell", content);
      sendPromise.then((pmid) => {
        this.storeBotResponse(chatId, content, pmid);
      }).catch(() => {});
    };

    execAsync(cmd, {
      timeout: 30_000,
      cwd: this.workingDirectory,
    }).then(({ stdout, stderr }) => {
      const output = (stdout + stderr).trim();
      sendResult(formatShellOutput(this.workingDirectory, cmd, output, 0));
    }).catch((err: unknown) => {
      const execErr = err as { stdout?: string; stderr?: string; code?: number };
      const output = ((execErr.stdout ?? "") + (execErr.stderr ?? "")).trim();
      const exitCode = execErr.code ?? 1;
      sendResult(formatShellOutput(this.workingDirectory, cmd, output, exitCode));
    });
  }

  /**
   * Spawn detached restart.sh（对齐 cc-connect cmdRestart）。
   * restart.sh 负责：sleep → kill old → start new → health check → notify result。
   */
  private spawnRestart(platformChatId: string): void {
    // restart.sh 位于项目根目录（和 package.json 同级）
    const projectRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    const restartScript = path.join(projectRoot, "restart.sh");

    // 找到 chatId（内部 ID）用于通知
    let chatId: string | undefined;
    for (const [cid, pid] of this.platformChatIds) {
      if (pid === platformChatId) { chatId = cid; break; }
    }

    const socketPath = path.join(path.dirname(this.dbPath), "api.sock");

    const child = spawn("nohup", ["bash", restartScript], {
      cwd: projectRoot,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        NIUBOT_BOT_NAME: this.botIdentity.name,
        NIUBOT_CHAT_ID: chatId ?? "",
        NIUBOT_API_SOCKET: socketPath,
      },
    });
    child.unref();

    // 立即停止接收新消息，避免窗口期内的消息被老进程接住后丢失
    this.stop();

    this.log.info("restart script spawned, pipeline stopped", { pid: child.pid, chatId, socketPath });
  }

  private async process(chatId: string, mergedText: string, messages: import("./queue.js").QueuedMessage[] = []): Promise<void> {
    const platformChatId = this.chatSessions.get(chatId)?.platformChatId
      ?? this.platformChatIds.get(chatId);

    // 从消息列表中取最后一条的 platformMsgId 作为 reply 目标
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : undefined;
    const triggerMsgId = lastMsg?.platformMsgId ?? this.triggerMsgIds.get(chatId);
    this.triggerMsgIds.delete(chatId);

    const isMerged = messages.length > 1;

    try {
      // M3: 路由决策 — 判断是否需要切换 session
      await this.maybeRouteSession(chatId, mergedText);

      const chatSession = await this.getOrCreateSession(chatId);

      // 拼接上下文前缀（新 session 的首条消息）
      let messageToSend = mergedText;
      const importantCtx = this.pendingImportantContext.get(chatId);
      const normalCtx = this.pendingNormalContext.get(chatId);
      if (importantCtx || normalCtx) {
        const parts: string[] = [];
        if (importantCtx) {
          parts.push(
            `<important-context preserve="true">\n` +
            `以下是关键场景信息，上下文压缩时必须保留。如果丢失，用 niubot whoami 重建。\n\n` +
            `${importantCtx}\n` +
            `</important-context>`,
          );
        }
        if (normalCtx) {
          parts.push(`<context>\n${normalCtx}\n</context>`);
        }
        this.pendingImportantContext.delete(chatId);
        this.pendingNormalContext.delete(chatId);
        messageToSend = `${parts.join("\n\n")}\n\n${mergedText}`;
      }

      this.log.info("sending to agent", {
        chatId,
        sessionKey: chatSession.sessionKey,
        textLength: messageToSend.length,
      });

      const response = await this.agent.sendMessage(chatSession.agentSession, messageToSend);

      // 被 cancel 的 prompt 不存储不发送（cancelled 后会有新的合并消息进来）
      if (response.cancelled) {
        this.log.info("prompt was cancelled, skipping response", { chatId });
        return;
      }

      // 存储 agent 回复
      const replyMsgId = storeMessage(this.db, {
        chatId,
        senderId: this.botUserId!,
        sessionKey: chatSession.sessionKey,
        role: "assistant",
        contentText: response.text,
        platform: this.botIdentity.platform,
      });

      // 更新 session 统计（COALESCE 保证 agent_session_id 只写一次，后续不覆盖）
      const cumulativeBytes = this.agent.getCumulativeBytes?.(chatSession.agentSession.id) ?? 0;
      const agentSessionId = this.agent.getAgentSessionId?.(chatSession.agentSession.id);
      this.db.prepare(`
        UPDATE sessions
        SET message_count = (SELECT COUNT(*) FROM messages WHERE session_key = ?),
            turn_count = turn_count + 1,
            cumulative_bytes = ?,
            last_active_at = datetime('now'),
            end_msg_id = ?,
            agent_session_id = COALESCE(agent_session_id, ?)
        WHERE id = ?
      `).run(chatSession.sessionKey, cumulativeBytes, replyMsgId, agentSessionId ?? null, chatSession.sessionKey);

      // 构建 footer（对齐 cc-connect：shortId · #turn · context · model）
      const stats = this.db.prepare(
        "SELECT turn_count FROM sessions WHERE id = ?",
      ).get(chatSession.sessionKey) as { turn_count: number } | undefined;
      const shortId = chatSession.sessionKey.slice(-8);
      const footerParts = [`${shortId} · #${stats?.turn_count ?? "?"}`];
      if (response.contextTokens && response.contextTokens > 0) {
        let contextStr = `${(response.contextTokens / 1000).toFixed(1)}k`;
        if (response.compactCount && response.compactCount > 0) {
          contextStr += ` 📦×${response.compactCount}`;
        }
        footerParts.push(contextStr);
      }
      if (response.model) {
        footerParts.push(formatModelName(response.model));
      }
      const footer = footerParts.join(" · ");

      // 合并消息提示头
      let displayText = response.text;
      if (isMerged) {
        const lines = messages.map((m) => {
          const brief = m.text.length > 10 ? m.text.slice(0, 10) + "…" : m.text;
          return `• ${brief}`;
        });
        displayText = `> 📌 回复 ${messages.length} 条消息：\n${lines.map((l) => `> ${l}`).join("\n")}\n\n${response.text}`;
      }

      // 发送到 IM（始终用卡片，footer 带 session 信息）
      let sentPlatformMsgId: string | undefined;
      try {
        const useReply = !!triggerMsgId;
        this.log.info("send decision", { chatId, useReply, merged: isMerged, messageCount: messages.length, triggerMsgId: triggerMsgId ?? "none" });
        if (useReply) {
          sentPlatformMsgId = await this.im.replyCard(triggerMsgId!, "", displayText, footer);
        } else {
          sentPlatformMsgId = await this.im.sendCard(chatSession.platformChatId, "", displayText, footer);
        }
      } catch (sendErr) {
        this.log.error("failed to send response to IM", {
          chatId,
          error: String(sendErr),
          responseLength: response.text.length,
        });
        // Fallback to plain text if card fails
        try {
          sentPlatformMsgId = await this.im.sendText(chatSession.platformChatId, response.text);
        } catch {
          // Give up
        }
      }

      // 回写 platform_msg_id（用于 merge_forward 等场景的内容缓存查找）
      if (sentPlatformMsgId) {
        updateMessagePlatformId(this.db, replyMsgId, sentPlatformMsgId);
      }

      this.log.info("response sent", {
        chatId,
        responseLength: response.text.length,
        filesChanged: response.filesChanged,
      });
    } catch (err) {
      this.log.error("pipeline error", { chatId, error: String(err) });

      if (platformChatId) {
        const errorText = "处理出错了，请稍后再试。";
        try {
          const pmid = await this.im.sendText(platformChatId, errorText);
          this.storeBotResponse(chatId, errorText, pmid);
        } catch { /* give up */ }
      }
    }
  }

  private async getOrCreateSession(chatId: string): Promise<ChatSession> {
    const existing = this.chatSessions.get(chatId);
    if (existing) return existing;

    const platformChatId = this.platformChatIds.get(chatId);
    if (!platformChatId) {
      throw new Error(`No platform chat ID for internal chat ${chatId}`);
    }

    const userId = this.chatUserIds.get(chatId);

    // 查 chatType 用于 memory 可见性控制
    const chatRow = this.db.prepare("SELECT type FROM chats WHERE id = ?").get(chatId) as { type: string } | undefined;
    const chatType = (chatRow?.type ?? "p2p") as "p2p" | "group";

    // 消费路由决策（如有）
    const routeDecision = this.pendingRouteDecisions.get(chatId);
    this.pendingRouteDecisions.delete(chatId);
    const recallSessionId = routeDecision?.action === "recall" ? routeDecision.recallSessionId : undefined;

    // 构建 important 上下文（当前场景 + 用户记忆）
    const userRow = userId
      ? this.db.prepare("SELECT name FROM users WHERE id = ?").get(userId) as { name: string | null } | undefined
      : undefined;
    const isAdmin = userId ? this.adminUserIds.has(userId) : false;
    const persona = this.botIdentity.personaPath ? loadPersona(this.botIdentity.personaPath) : undefined;
    const importantContext = userId
      ? buildImportantContext(this.db, {
          botName: this.botIdentity.name,
          botLabel: this.botUserId ? getUserShortLabel(this.db, this.botUserId) : undefined,
          userName: userRow?.name ?? undefined,
          userId,
          chatId,
          chatLabel: getChatShortLabel(this.db, chatId),
          chatType,
          isAdmin,
          personaPath: isAdmin ? this.botIdentity.personaPath : undefined,
          personaContent: persona,
        })
      : undefined;

    // 构建 normal 上下文（摘要 + 今日归档 + recall）— 后续拼到首条消息前缀
    const normalContext = buildNormalContext(this.db, chatId, chatType, recallSessionId);
    if (normalContext) {
      this.pendingNormalContext.set(chatId, normalContext);
    }

    // backend 不支持 system prompt 时，important 上下文 fallback 到首条消息前缀
    const supportsSystemPrompt = this.agent.supportsSystemPrompt !== false;

    const agentSession = await this.agent.createSession({
      workingDirectory: this.workingDirectory,
      importantContext: supportsSystemPrompt ? (importantContext || undefined) : undefined,
      userId: userId ?? undefined,
      chatId,
      chatType,
      dbPath: this.dbPath,
      botId: this.botIdentity.platformBotId,
      botName: this.botIdentity.name,
      liteModel: this.botIdentity.liteModel,
      isAdmin,
    });

    if (!supportsSystemPrompt && importantContext) {
      this.pendingImportantContext.set(chatId, importantContext);
    }

    const sessionKey = `s_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    try {
      const orphan = this.db.prepare(
        "SELECT MIN(id) as startId FROM messages WHERE chat_id = ? AND session_key IS NULL",
      ).get(chatId) as { startId: number | null } | undefined;
      const startMsgId = orphan?.startId ?? null;

      this.db.prepare(`
        INSERT INTO sessions (id, chat_id, user_id, status, start_msg_id, started_at, last_active_at)
        VALUES (?, ?, ?, 'active', ?, datetime('now'), datetime('now'))
      `).run(sessionKey, chatId, userId ?? null, startMsgId);

      this.db.prepare(
        "UPDATE messages SET session_key = ? WHERE chat_id = ? AND session_key IS NULL",
      ).run(sessionKey, chatId);
    } catch (dbErr) {
      await this.agent.closeSession(agentSession).catch(() => {});
      throw dbErr;
    }

    const chatSession: ChatSession = {
      agentSession,
      sessionKey,
      platformChatId,
      userId: userId ?? "",
      triggerPlatformMsgId: this.triggerMsgIds.get(chatId),
      hasReplied: false,
    };
    this.chatSessions.set(chatId, chatSession);

    this.log.info("session created", { chatId, sessionKey, userId, agentSessionId: agentSession.id });
    return chatSession;
  }

  /** 路由决策结果暂存 */
  private pendingRouteDecisions = new Map<string, RouteDecision>();

  /** normal 上下文暂存 */
  private pendingNormalContext = new Map<string, string>();

  /** important 上下文暂存（backend 不支持 system prompt 时 fallback） */
  private pendingImportantContext = new Map<string, string>();

  /** 路由判断的最小轮次门槛 */
  private static readonly ROUTE_MIN_TURNS = 10;

  private async maybeRouteSession(chatId: string, newMessage: string): Promise<void> {
    const existing = this.chatSessions.get(chatId);
    if (!existing) return;

    const sessionRow = this.db.prepare(
      "SELECT last_active_at, turn_count FROM sessions WHERE id = ?",
    ).get(existing.sessionKey) as { last_active_at: string | null; turn_count: number } | undefined;

    if (!sessionRow?.last_active_at) return;
    if (sessionRow.turn_count < Pipeline.ROUTE_MIN_TURNS) return;

    const decision = await decideRoute(
      this.agent,
      this.db,
      chatId,
      sessionRow.last_active_at,
      newMessage,
      existing.sessionKey,
    );

    if (decision.action === "continue") return;

    this.log.info("route decision: switching session", {
      chatId,
      action: decision.action,
      reason: decision.reason,
      recallSessionId: decision.recallSessionId,
    });

    await this.archiveSession(chatId);

    this.db.prepare(`
      UPDATE messages SET session_key = NULL
      WHERE chat_id = ? AND session_key = ?
        AND id > COALESCE((SELECT end_msg_id FROM sessions WHERE id = ?), 0)
    `).run(chatId, existing.sessionKey, existing.sessionKey);

    this.pendingRouteDecisions.set(chatId, decision);
  }

  private static readonly ARCHIVE_SUMMARY_MIN_TURNS = 5;

  private async archiveSession(chatId: string): Promise<void> {
    const session = this.chatSessions.get(chatId);
    if (!session) return;

    const { agentSession, sessionKey } = session;

    const sessionRow = this.db.prepare(
      "SELECT turn_count FROM sessions WHERE id = ?",
    ).get(sessionKey) as { turn_count: number } | undefined;

    const turnCount = sessionRow?.turn_count ?? 0;

    if (turnCount >= Pipeline.ARCHIVE_SUMMARY_MIN_TURNS) {
      this.archivingChats.add(chatId);
      try {
        const response = await this.agent.sendMessage(agentSession, ARCHIVE_SUMMARY_PROMPT);

        if (!response.cancelled) {
          const jsonMatch = response.text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            this.db.prepare(
              "UPDATE sessions SET summary = ?, topics = ? WHERE id = ?",
            ).run(JSON.stringify(parsed), JSON.stringify(parsed.topics ?? []), sessionKey);
            this.log.info("archive summary generated", { chatId, sessionKey });
          } else {
            this.log.warn("archive summary response has no JSON", { chatId, sessionKey });
          }
        }
      } catch (err) {
        this.log.warn("failed to generate archive summary", { chatId, sessionKey, error: String(err) });
      } finally {
        this.archivingChats.delete(chatId);
      }
    } else {
      this.log.info("skipping archive summary for short session", { chatId, sessionKey, turnCount });
    }

    this.db.prepare(`
      UPDATE sessions SET status = 'archived', ended_at = datetime('now'), last_active_at = datetime('now')
      WHERE id = ?
    `).run(sessionKey);

    this.chatSessions.delete(chatId);
    await this.agent.closeSession(agentSession).catch((err) => {
      this.log.warn("failed to close backend session during archive", { chatId, sessionKey, error: String(err) });
    });

    this.log.info("session archived", { chatId, sessionKey, turnCount });
  }

  private async cancelChat(chatId: string): Promise<void> {
    const session = this.chatSessions.get(chatId);
    if (!session) return;

    if (this.archivingChats.has(chatId)) {
      this.log.debug("cancel suppressed during archive", { chatId });
      return;
    }

    await this.agent.cancelSession(session.agentSession);
  }
}

/** 检查命令是否在 PATH 中（对齐 Go exec.LookPath） */
function commandExistsSync(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Shell 输出最大字符数（超出截断） */
const SHELL_MAX_OUTPUT_LEN = 4000;

/** 格式化 shell 命令输出（对齐 cc-connect FormatOutput） */
function formatShellOutput(cwd: string, cmd: string, output: string, exitCode: number): string {
  let body = "";
  if (!output && exitCode === 0) {
    body = "(no output)\n";
  } else {
    if (output.length > SHELL_MAX_OUTPUT_LEN) {
      body = output.slice(0, SHELL_MAX_OUTPUT_LEN);
      if (!body.endsWith("\n")) body += "\n";
      body += `... (output truncated, ${output.length} chars total)\n`;
    } else {
      body = output;
      if (body && !body.endsWith("\n")) body += "\n";
    }
  }
  if (exitCode !== 0) {
    body += `exit code: ${exitCode}\n`;
  }
  return `\`\`\`\n$ ${cwd}> ${cmd}\n${body}\`\`\``;
}

/** 格式化 uptime 毫秒为可读字符串 */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

/** "claude-opus-4-6" → "Opus 4.6", "claude-haiku-4-5-20251001" → "Haiku 4.5" */
function formatModelName(raw: string): string {
  const s = raw.replace(/^claude-/, "");
  // Remove date suffix like -20251001
  const parts = s.split("-").filter((p) => p.length > 0 && !(p.length === 8 && /^\d+$/.test(p)));
  if (parts.length === 0) return raw;
  // Capitalize first part, join rest with dots
  const name = parts[0]![0]!.toUpperCase() + parts[0]!.slice(1);
  return parts.length > 1 ? `${name} ${parts.slice(1).join(".")}` : name;
}
