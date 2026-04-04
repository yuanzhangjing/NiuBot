import { exec, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import type { PlatformAdapter, NormalizedMessage } from "../im/types.js";
import type { AgentBackend, AgentSession } from "../agent/types.js";
import { MessageQueue } from "./queue.js";
import {
  ensureUser, ensureChat, storeMessage, updateChatName,
  getUserShortLabel, getChatShortLabel, getMessageByPlatformId, updateMessageContent,
} from "../database/schema.js";
import { buildImportantContext, buildNormalContext, type SceneInfo } from "../memory/inject.js";
import { loadPersona } from "../persona.js";
import { ARCHIVE_SUMMARY_PROMPT } from "./prompts.js";
import { decideRoute, type RouteDecision } from "./routing.js";
import { containsMarkdown } from "../im/feishu/adapter.js";
import { createLogger } from "../logger.js";

const execAsync = promisify(exec);

const PROCESSING_EMOJI = "Get";

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

    this.queue.onProcess((chatId, mergedText) => this.process(chatId, mergedText));
    this.queue.onCancel((chatId) => this.cancelChat(chatId));
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
    await this.im.sendText(platformChatId, text);
  }

  /** 通过 IPC 发送文件到指定 chat */
  async sendFileToChat(platformChatId: string, filePath: string): Promise<void> {
    await this.im.sendFile(platformChatId, filePath);
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
      SELECT s.id, s.chat_id, s.user_id, c.platform_id, c.type
      FROM sessions s
      JOIN chats c ON s.chat_id = c.id
      WHERE s.status = 'active'
      ORDER BY s.last_active_at DESC
    `).all() as Array<{
      id: string;
      chat_id: string;
      user_id: string | null;
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
      agentText = `${replyContext}\n\n${displayText}`;
    }

    // Processing emoji: 标记已收到（永久保留，作为已读回执）
    if (msg.platformMsgId) {
      this.im.addReaction(msg.chatPlatformId, msg.platformMsgId, PROCESSING_EMOJI).catch(() => {});
    }

    // Save trigger msg ID for reply-to-message
    if (msg.platformMsgId) {
      this.triggerMsgIds.set(chatId, msg.platformMsgId);
    }

    // 短词打断检测
    const trimmedText = msg.contentText.trim().toLowerCase();
    if (INTERRUPT_WORDS.has(trimmedText) && this.chatSessions.has(chatId)) {
      this.log.info("interrupt word detected", { chatId, word: trimmedText });
      this.cancelChat(chatId).catch(() => {});
      this.im.sendText(msg.chatPlatformId, "好的，已停止。").catch(() => {});
      return;
    }

    // 内置命令拦截：/xxx 开头的消息先匹配内置命令，命中则不传给 agent
    if (this.handleBuiltinCommand(msg.contentText.trim(), userId, msg.chatPlatformId)) {
      return;
    }

    this.queue.push({
      chatId,
      text: agentText,
      timestamp: Date.now(),
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

  /** Build reply context string from a parent message */
  private buildReplyContext(platform: string, parentPlatformMsgId: string): string {
    // First try DB
    const dbMsg = getMessageByPlatformId(this.db, platform, parentPlatformMsgId);
    if (dbMsg?.contentText) {
      const label = getUserShortLabel(this.db, dbMsg.senderId);
      const truncated = dbMsg.contentText.length > 200
        ? dbMsg.contentText.slice(0, 200) + "..."
        : dbMsg.contentText;
      return `> 引用 ${label}：${truncated}`;
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
  private handleBuiltinCommand(text: string, userId: string, platformChatId: string): boolean {
    if (!text.startsWith("/")) return false;

    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const isAdmin = this.adminUserIds.has(userId);

    // 1. 内置命令
    switch (cmd) {
      case "/restart": {
        if (!isAdmin) {
          this.im.sendText(platformChatId, "restart 仅管理员可用。").catch(() => {});
          return true;
        }
        this.log.info("builtin command: restart", { userId });
        this.im.sendText(platformChatId, "正在重启...").catch(() => {});
        setTimeout(() => process.exit(0), 500);
        return true;
      }
      case "/status": {
        this.log.info("builtin command: status", { userId });
        this.sendStatus(platformChatId);
        return true;
      }
    }

    // 2. 管理员 shell 命令：检查首个 token 是否在 PATH 中，是则执行，否则转发 agent
    if (isAdmin) {
      const shellCmd = text.slice(1); // 去掉 / 前缀
      const firstToken = shellCmd.split(/\s+/)[0];
      if (firstToken && commandExistsSync(firstToken)) {
        this.tryShellCommand(shellCmd, platformChatId);
        return true;
      }
    }

    // 3. 未识别的 / 命令，交给 agent 处理
    return false;
  }

  /**
   * /status：输出 bot 运行状态信息。
   */
  private sendStatus(platformChatId: string): void {
    const uptimeMs = Date.now() - this.startedAt;
    const uptimeStr = formatUptime(uptimeMs);

    const activeSessions = this.chatSessions.size;

    // 统计活跃 cron 任务数
    const cronRow = this.db.prepare(
      "SELECT COUNT(*) as count FROM cron_jobs WHERE status = 'active'",
    ).get() as { count: number } | undefined;
    const cronCount = cronRow?.count ?? 0;

    const lines = [
      `Bot: ${this.botIdentity.name}`,
      `Platform: ${this.botIdentity.platform}`,
      `Uptime: ${uptimeStr}`,
      `Active sessions: ${activeSessions}`,
      `Cron jobs: ${cronCount}`,
      `Working directory: ${this.workingDirectory}`,
    ];

    this.im.sendText(platformChatId, lines.join("\n"))
      .then(() => this.log.info("status sent", { platformChatId }))
      .catch((err) => this.log.error("status send failed", { platformChatId, error: String(err) }));
  }

  /**
   * 管理员 shell 命令执行（对齐 cc-connect tryShellCommand）。
   * 通过 sh -c 执行，30s 超时。调用前已由 commandExistsSync 确认命令存在。
   */
  private tryShellCommand(cmd: string, platformChatId: string): void {
    this.log.info("shell command", { cmd });

    execAsync(cmd, {
      timeout: 30_000,
      cwd: this.workingDirectory,
    }).then(({ stdout, stderr }) => {
      const output = (stdout + stderr).trim();
      if (output) {
        this.im.sendText(platformChatId, output).catch(() => {});
      } else {
        this.im.sendText(platformChatId, "(命令执行完成，无输出)").catch(() => {});
      }
    }).catch((err: unknown) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.im.sendText(platformChatId, `命令执行失败: ${errMsg}`).catch(() => {});
    });
  }

  private async process(chatId: string, mergedText: string): Promise<void> {
    const platformChatId = this.chatSessions.get(chatId)?.platformChatId
      ?? this.platformChatIds.get(chatId);

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

      // 更新 session 统计
      const cumulativeBytes = this.agent.getCumulativeBytes?.(chatSession.agentSession.id) ?? 0;
      this.db.prepare(`
        UPDATE sessions
        SET message_count = (SELECT COUNT(*) FROM messages WHERE session_key = ?),
            turn_count = turn_count + 1,
            cumulative_bytes = ?,
            last_active_at = datetime('now'),
            end_msg_id = ?
        WHERE id = ?
      `).run(chatSession.sessionKey, cumulativeBytes, replyMsgId, chatSession.sessionKey);

      // 拼接 debug meta 信息
      let sendText = response.text;
      if (process.env["NIUBOT_DEBUG_META"] === "1") {
        const stats = this.db.prepare(
          "SELECT turn_count FROM sessions WHERE id = ?",
        ).get(chatSession.sessionKey) as { turn_count: number } | undefined;
        const shortId = chatSession.sessionKey.slice(-8);
        sendText += `\n\n---\n${shortId} #${stats?.turn_count ?? "?"}`;
      }

      // 发送到 IM
      try {
        // Reply-to-Message: first response quotes trigger, subsequent are normal
        const triggerMsgId = this.triggerMsgIds.get(chatId);
        if (!chatSession.hasReplied && triggerMsgId) {
          // Detect markdown and choose send method
          if (containsMarkdown(sendText)) {
            await this.im.sendMarkdownCard(chatSession.platformChatId, sendText);
          } else {
            await this.im.sendReply(chatSession.platformChatId, sendText, triggerMsgId);
          }
          chatSession.hasReplied = true;
        } else {
          if (containsMarkdown(sendText)) {
            await this.im.sendMarkdownCard(chatSession.platformChatId, sendText);
          } else {
            await this.im.sendText(chatSession.platformChatId, sendText);
          }
        }
      } catch (sendErr) {
        this.log.error("failed to send response to IM", {
          chatId,
          error: String(sendErr),
          responseLength: sendText.length,
        });
        // Fallback to plain text if markdown card fails
        try {
          await this.im.sendText(chatSession.platformChatId, sendText);
        } catch {
          // Give up
        }
      }

      this.log.info("response sent", {
        chatId,
        responseLength: response.text.length,
        filesChanged: response.filesChanged,
      });
    } catch (err) {
      this.log.error("pipeline error", { chatId, error: String(err) });

      if (platformChatId) {
        await this.im.sendText(platformChatId, "处理出错了，请稍后再试。").catch(() => {});
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
