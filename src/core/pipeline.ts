import { exec, execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type { PlatformAdapter, NormalizedMessage } from "../im/types.js";
import { escapeYamlContent, renderMessageNodes } from "../im/render.js";
import type { AgentBackend, AgentSession } from "../agent/types.js";
import { AGENT_BACKEND_DISPLAY, normalizeBackend, type AgentBackendType, VALID_BACKENDS } from "../config.js";
import { MessageQueue } from "./queue.js";
import {
  ensureUser, ensureChat, storeMessage, updateChatName,
  getUserShortLabel, getChatShortLabel, getMessageByPlatformId, updateMessageContent, updateMessagePlatformId,
  getUnseenMessages, markMessagesSeen,
} from "../database/schema.js";
import { buildImportantContext, buildNormalContext, type SceneInfo } from "../memory/inject.js";
import { loadPersona } from "../persona.js";
import { ARCHIVE_SUMMARY_PROMPT, buildStateSummaryPrompt } from "./prompts.js";
import { decideRoute, type RouteDecision } from "./routing.js";
import { listCronJobs, deleteCronJob, getCronJob } from "./cron.js";
import { createLogger } from "../logger.js";
import { buildResponseFooter } from "./footer.js";

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

interface PendingTransitionMessage {
  msg: NormalizedMessage;
}

export class Pipeline {
  private db: Database.Database;
  private im: PlatformAdapter;
  private agent: AgentBackend;
  private backendType: AgentBackendType;
  private backendResolver?: (type: AgentBackendType) => Promise<AgentBackend>;
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

  /** chatId → transition promise，session 切换期间后续消息先挂起 */
  private sessionTransitionLocks = new Map<string, Promise<void>>();

  /** chatId → transition 期间暂存的后续消息 */
  private pendingTransitionMessages = new Map<string, PendingTransitionMessage[]>();

  /** 已加过 Pin 的消息，避免重复加 reaction */
  private pinnedMsgIds = new Set<string>();

  /** 已加过 Get 的消息，避免重复加 reaction */
  private processingMsgIds = new Set<string>();

  constructor(
    db: Database.Database,
    im: PlatformAdapter,
    agent: AgentBackend,
    botIdentity: BotIdentity,
    workingDirectory: string,
    dbPath: string,
    bufferMs: number,
    cancelThresholdMs: number,
    backendType: AgentBackendType = "claude",
    backendResolver?: (type: AgentBackendType) => Promise<AgentBackend>,
  ) {
    this.db = db;
    this.im = im;
    this.agent = agent;
    this.backendType = backendType;
    this.backendResolver = backendResolver;
    this.botIdentity = botIdentity;
    this.workingDirectory = workingDirectory;
    this.dbPath = dbPath;
    this.log = createLogger("pipeline", botIdentity.name);
    this.queue = new MessageQueue(bufferMs, cancelThresholdMs);

    this.queue.onProcess((chatId, mergedText, messages) => this.process(chatId, mergedText, messages));
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

  private markQueuedMessage(chatPlatformId: string, msgId?: string): void {
    if (!msgId || this.pinnedMsgIds.has(msgId)) return;
    this.pinnedMsgIds.add(msgId);
    this.log.info("reaction request", { chatPlatformId, msgId, emoji: MERGED_EMOJI, phase: "queued" });
    this.im.addReaction(chatPlatformId, msgId, MERGED_EMOJI).catch(() => {});
  }

  private moveMessageToProcessing(chatPlatformId: string, msgId?: string): void {
    if (!msgId) return;
    this.pinnedMsgIds.delete(msgId);
    if (this.processingMsgIds.has(msgId)) return;
    this.processingMsgIds.add(msgId);
    this.log.info("reaction request", { chatPlatformId, msgId, emoji: PROCESSING_EMOJI, phase: "processing" });
    this.im.addReaction(chatPlatformId, msgId, PROCESSING_EMOJI).catch(() => {});
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
      SELECT s.id, s.chat_id, s.user_id, s.agent_session_id, s.backend_type, c.platform_id, c.type
      FROM sessions s
      JOIN chats c ON s.chat_id = c.id
      WHERE s.status = 'active'
      ORDER BY s.last_active_at DESC
    `).all() as Array<{
      id: string;
      chat_id: string;
      user_id: string | null;
      agent_session_id: string | null;
      backend_type: AgentBackendType | null;
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
      const storedBackendType = normalizeBackend(row.backend_type ?? undefined);
      const canResumeRecoveredSession = storedBackendType !== undefined && storedBackendType === this.backendType;

      if (!canResumeRecoveredSession && storedBackendType !== this.backendType) {
        this.db.prepare(`
          UPDATE sessions
          SET status = 'archived',
              ended_at = datetime('now'),
              last_active_at = datetime('now'),
              agent_session_id = NULL
          WHERE id = ?
        `).run(row.id);
        this.log.warn("resetting unrecoverable active session during startup", {
          chatId: row.chat_id,
          sessionKey: row.id,
          storedBackendType: storedBackendType ?? "unknown",
          activeBackendType: this.backendType,
        });
        continue;
      }

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
          agentSessionId: canResumeRecoveredSession ? (row.agent_session_id ?? undefined) : undefined,
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

        this.log.info("session recovered", {
          chatId: row.chat_id,
          sessionKey: row.id,
          resumed: canResumeRecoveredSession && !!row.agent_session_id,
          storedBackendType: storedBackendType ?? "unknown",
          activeBackendType: this.backendType,
        });
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

    if (this.sessionTransitionLocks.has(chatId)) {
      this.log.info("message deferred during session transition", {
        chatId,
        msgId: msg.platformMsgId,
        type: msg.contentType,
      });
      this.enqueuePendingTransitionMessage(chatId, msg);
      return;
    }

    // Fetch group chat name if not known
    if (msg.chatType === "group") {
      const chatRow = this.db.prepare("SELECT name FROM chats WHERE id = ?").get(chatId) as { name: string | null } | undefined;
      if (!chatRow?.name) {
        this.im.getChatName(msg.chatPlatformId).then((name) => {
          if (name) updateChatName(this.db, chatId, name);
        }).catch(() => {});
      }
    }

    // Build reply quoted block (sub-field of - msg: / - forward:)
    let replyQuoted = "";
    if (msg.parentPlatformMsgId) {
      replyQuoted = this.buildReplyQuoted(platform, msg.parentPlatformMsgId);
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
      agentSeen: true,
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

    // Prepare text to send to agent
    // 独立消息：纯文本（保持 skill 等模式匹配可用）
    // 结构化消息（reply / forward）：YAML 格式表达嵌套关系
    let agentText: string;
    const label = getUserShortLabel(this.db, userId);

    if (msg.contentType === "merge_forward" && msg.children?.length) {
      // 合并转发：- forward: sender + messages
      agentText = `- forward: ${label}\n  messages:\n${renderMessageNodes(msg.children, 2)}`;
      if (replyQuoted) agentText += `\n${replyQuoted}`;
    } else if (replyQuoted) {
      // 回复消息：- msg: "sender: content" + quoted
      const escaped = escapeYamlContent(msg.contentText);
      agentText = `- msg: "${escapeYamlContent(label)}: ${escaped}"\n${replyQuoted}`;
    } else {
      // 独立消息：纯文本
      agentText = this.normalizeUserTextForAgent(msg.contentText);
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

    // Reaction 策略：收到即二选一；pending 先 Pin，非 pending 先 Get；pending 开始处理后再补 Get
    const isPending = this.queue.push({
      chatId,
      text: agentText,
      senderLabel: label,
      timestamp: Date.now(),
      platformMsgId: msg.platformMsgId,
    });
    this.log.info("reaction decision", {
      chatId,
      msgId: msg.platformMsgId,
      isPending,
      initialEmoji: isPending ? MERGED_EMOJI : PROCESSING_EMOJI,
    });
    if (isPending) {
      this.markQueuedMessage(msg.chatPlatformId, msg.platformMsgId);
    } else {
      this.moveMessageToProcessing(msg.chatPlatformId, msg.platformMsgId);
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

  /**
   * Build reply quoted block (indented as sub-field of `- msg:`).
   * Returns `"  quoted:\n    msg: \"label: content\""` or empty string.
   */
  private buildReplyQuoted(platform: string, parentPlatformMsgId: string): string {
    // First try DB
    const dbMsg = getMessageByPlatformId(this.db, platform, parentPlatformMsgId);
    if (dbMsg?.contentText) {
      const label = getUserShortLabel(this.db, dbMsg.senderId);
      const escaped = escapeYamlContent(dbMsg.contentText);
      return `  quoted:\n    msg: "${label}: ${escaped}"`;
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
   * //xxx 视为强制透传给 agent，本地不拦截。
   * 未命中返回 false，消息继续走 agent 流程。
   *
   * 分发顺序（对齐 cc-connect）：
   *   1. 内置命令 switch（/restart, /status, /new, /clear, /cron）
   *   2. 管理员 shell 命令（tryShellCommand）
   *   3. return false → 转发给 agent
   */
  private handleBuiltinCommand(text: string, userId: string, chatId: string, platformChatId: string, msgId?: string): boolean {
    if (!text.startsWith("/") || text.startsWith("//")) return false;

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
      case "/new":
      case "/clear": {
        this.log.info("builtin command: reset-session", { userId, cmd, chatId });
        this.startSessionTransition(chatId, () => this.resetSession(chatId, platformChatId, msgId));
        return true;
      }
      case "/cron": {
        this.handleCronCommand(parts.slice(1), chatId, platformChatId, msgId);
        return true;
      }
      case "/agent": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "/agent 仅管理员可用。");
          return true;
        }
        this.handleAgentCommand(parts.slice(1), chatId, platformChatId, msgId);
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

  /** //xxx 表示强制透传给 agent，实际发送时去掉一个前缀 / */
  private normalizeUserTextForAgent(text: string): string {
    return text.startsWith("//") ? text.slice(1) : text;
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

  // ── /cron command ─────────────────────────────────────────────

  private handleCronCommand(args: string[], chatId: string, platformChatId: string, msgId?: string): void {
    const sub = (args[0] ?? "list").toLowerCase();

    switch (sub) {
      case "list": {
        this.sendCronList(chatId, platformChatId, msgId);
        break;
      }
      case "del":
      case "delete":
      case "rm": {
        const idStr = args[1];
        if (!idStr) {
          this.replyText(chatId, platformChatId, msgId, "用法: /cron del <id>");
          return;
        }
        const id = Number(idStr);
        if (Number.isNaN(id)) {
          this.replyText(chatId, platformChatId, msgId, `无效 ID: ${idStr}`);
          return;
        }
        const job = getCronJob(this.db, id);
        if (!job || job.chatId !== chatId) {
          this.replyText(chatId, platformChatId, msgId, `未找到定时任务 #${id}`);
          return;
        }
        deleteCronJob(this.db, id);
        this.replyText(chatId, platformChatId, msgId, `已删除定时任务 #${id}`);
        break;
      }
      case "help":
      default: {
        this.replyText(chatId, platformChatId, msgId, "用法: /cron [list | del <id>]");
        break;
      }
    }
  }

  private sendCronList(chatId: string, platformChatId: string, msgId?: string): void {
    const jobs = listCronJobs(this.db, chatId);
    if (jobs.length === 0) {
      this.replyText(chatId, platformChatId, msgId, "当前没有定时任务。");
      return;
    }

    const lines: string[] = [];
    for (const job of jobs) {
      if (job.description) {
        lines.push(`✅ **${job.description}**`);
      }
      lines.push(`Prompt: ${job.prompt}`);
      lines.push(`ID: ${job.id}`);
      if (job.runAt) {
        lines.push(`Schedule: ${job.runAt} (一次性)`);
      } else if (job.cronExpr) {
        lines.push(`Schedule: \`${job.cronExpr}\``);
      }
      if (job.maxTimes) {
        lines.push(`Progress: ${job.runCount}/${job.maxTimes}`);
      }
      if (job.untilTime) {
        lines.push(`Until: ${job.untilTime}`);
      }
      if (job.lastRunAt) {
        lines.push(`Last run: ${job.lastRunAt}`);
      }
      lines.push(""); // blank separator
    }

    const content = lines.join("\n");
    const send = msgId
      ? this.im.replyCard(msgId, "Cron", content)
      : this.im.sendCard(platformChatId, "Cron", content);
    send
      .then((pmid) => {
        this.storeBotResponse(chatId, content, pmid);
      })
      .catch((err) => this.log.error("cron list send failed", { platformChatId, error: String(err) }));
  }

  // ── Cron job execution（独立 session，对齐 cc-connect BackgroundSession） ──

  /**
   * 执行定时任务：创建独立 session，发送 prompt，结果用 ⏰ header 卡片发送，完成后归档。
   * 不走用户消息队列，不干扰当前对话 session。
   */
  async processCronJob(chatId: string, userId: string, prompt: string, description: string): Promise<void> {
    // Resolve platform chat ID
    let platformChatId = this.platformChatIds.get(chatId);
    if (!platformChatId) {
      const row = this.db.prepare("SELECT platform_id FROM chats WHERE id = ?")
        .get(chatId) as { platform_id: string } | undefined;
      if (!row) {
        this.log.warn("processCronJob: chat not found", { chatId });
        return;
      }
      platformChatId = row.platform_id;
      this.platformChatIds.set(chatId, platformChatId);
    }

    const chatRow = this.db.prepare("SELECT type FROM chats WHERE id = ?").get(chatId) as { type: string } | undefined;
    const chatType = (chatRow?.type ?? "p2p") as "p2p" | "group";

    // Build important context（场景 + 用户记忆）
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

    // Build normal context（全局摘要 + 最近 session summaries）
    const normalContext = buildNormalContext(this.db, chatId);

    // Create independent agent session
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

    // Create session record with source='cron'
    const sessionKey = `s_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    this.db.prepare(`
      INSERT INTO sessions (id, chat_id, user_id, source, status, started_at, last_active_at, backend_type)
      VALUES (?, ?, ?, 'cron', 'active', datetime('now'), datetime('now'), ?)
    `).run(sessionKey, chatId, userId, this.backendType);

    // Store cron prompt as user message
    storeMessage(this.db, {
      chatId,
      senderId: userId,
      sessionKey,
      role: "user",
      contentText: prompt,
      platform: this.botIdentity.platform,
    });

    // Inject context prefix
    let messageToSend = prompt;
    const contextParts: string[] = [];
    if (!supportsSystemPrompt && importantContext) {
      contextParts.push(
        `<important-context preserve="true">\n` +
        `以下是关键场景信息，上下文压缩时必须保留。如果丢失，用 niubot whoami 重建。\n\n` +
        `${importantContext}\n` +
        `</important-context>`,
      );
    }
    if (normalContext) {
      contextParts.push(`<context>\n${normalContext}\n</context>`);
    }
    if (contextParts.length > 0) {
      messageToSend = `${contextParts.join("\n\n")}\n\n${prompt}`;
    }

    this.log.info("executing cron job", { chatId, sessionKey, userId, description });

    try {
      const response = await this.agent.sendMessage(agentSession, messageToSend);

      if (response.cancelled) {
        this.log.warn("cron job was cancelled", { chatId, sessionKey });
        return;
      }

      // Store response
      const replyMsgId = storeMessage(this.db, {
        chatId,
        senderId: this.botUserId!,
        sessionKey,
        role: "assistant",
        contentText: response.text,
        platform: this.botIdentity.platform,
      });

      // Update session stats
      const agentSessionId = this.agent.getAgentSessionId?.(agentSession.id);
      this.db.prepare(`
        UPDATE sessions
        SET message_count = 2,
            turn_count = 1,
            last_active_at = datetime('now'),
            end_msg_id = ?,
            agent_session_id = ?,
            backend_type = ?
        WHERE id = ?
      `).run(replyMsgId, agentSessionId ?? null, this.backendType, sessionKey);

      // Build footer
      const footer = buildResponseFooter({
        sessionKey,
        turnCount: 1,
        contextTokens: response.contextTokens,
        compactCount: response.compactCount,
        model: response.model,
      });

      // Send card with ⏰ header（对齐 cc-connect: ⏰ + description）
      const header = `⏰ ${description || prompt.slice(0, 40)}`;
      const sentPlatformMsgId = await this.im.sendCard(platformChatId, header, response.text, footer);

      if (sentPlatformMsgId) {
        updateMessagePlatformId(this.db, replyMsgId, sentPlatformMsgId);
      }

      this.log.info("cron job completed", { chatId, sessionKey, responseLength: response.text.length });
    } catch (err) {
      this.log.error("cron job execution failed", { chatId, sessionKey, error: String(err) });
    } finally {
      // Archive session（turn=1，不触发 archive summary）
      this.db.prepare(`
        UPDATE sessions SET status = 'archived', ended_at = datetime('now'), last_active_at = datetime('now')
        WHERE id = ?
      `).run(sessionKey);

      await this.agent.closeSession(agentSession).catch((closeErr) => {
        this.log.warn("failed to close cron session", { chatId, sessionKey, error: String(closeErr) });
      });
    }
  }

  /** /new 和 /clear：归档当前 session，让下一条消息自然创建新 session。 */
  private async resetSession(chatId: string, platformChatId: string, msgId?: string): Promise<void> {
    await this.archiveSession(chatId)
      .then((archived) => {
        const text = archived
          ? "已开始新会话，当前上下文已清空。"
          : "当前没有进行中的会话；下一条消息会新建会话。";
        this.replyText(chatId, platformChatId, msgId, text);
      })
      .catch((err) => {
        this.log.error("reset session failed", { chatId, error: String(err) });
        this.replyText(chatId, platformChatId, msgId, `新建会话失败: ${String(err)}`);
      });
  }

  private startSessionTransition(chatId: string, task: () => Promise<void>): void {
    if (this.sessionTransitionLocks.has(chatId)) return;

    const transitionPromise = task()
      .finally(() => {
        if (this.sessionTransitionLocks.get(chatId) === transitionPromise) {
          this.sessionTransitionLocks.delete(chatId);
        }
        this.drainPendingTransitionMessages(chatId);
      });

    this.sessionTransitionLocks.set(chatId, transitionPromise);
  }

  private enqueuePendingTransitionMessage(chatId: string, msg: NormalizedMessage): void {
    const pending = this.pendingTransitionMessages.get(chatId) ?? [];
    pending.push({ msg });
    this.pendingTransitionMessages.set(chatId, pending);
    this.markQueuedMessage(msg.chatPlatformId, msg.platformMsgId);
  }

  private drainPendingTransitionMessages(chatId: string): void {
    const pending = this.pendingTransitionMessages.get(chatId);
    if (!pending || pending.length === 0) return;

    this.pendingTransitionMessages.delete(chatId);
    for (const entry of pending) {
      if (entry.msg.platformMsgId) {
        this.processedMsgIds.delete(entry.msg.platformMsgId);
      }
      this.handleMessage(entry.msg);
    }
  }

  /**
   * /agent 命令：查看或切换 agent backend。
   * - /agent        → 显示当前 backend
   * - /agent <type> → 切换到指定 backend，归档当前 session
   */
  private handleAgentCommand(args: string[], chatId: string, platformChatId: string, msgId?: string): void {
    if (args.length === 0) {
      // 显示当前 backend
      this.replyText(chatId, platformChatId, msgId,
        `当前 Agent: **${displayBackendType(this.backendType)}**\n可选: ${AGENT_BACKEND_DISPLAY.join(", ")}`);
      return;
    }

    let target: AgentBackendType | undefined;
    try {
      target = normalizeBackend(args[0]);
    } catch {
      target = undefined;
    }

    if (!target || !VALID_BACKENDS.has(target)) {
      this.replyText(chatId, platformChatId, msgId,
        `无效的 backend: "${args[0]}"\n可选: ${AGENT_BACKEND_DISPLAY.join(", ")}`);
      return;
    }

    if (target === this.backendType) {
      this.replyText(chatId, platformChatId, msgId, `已经是 ${displayBackendType(target)}，无需切换。`);
      return;
    }

    if (!this.backendResolver) {
      this.replyText(chatId, platformChatId, msgId, "backend resolver 未配置，无法切换。");
      return;
    }

    this.log.info("switching agent backend", { from: this.backendType, to: target });

    // 归档所有当前 session，获取新 backend（含 start），然后切换
    const doSwitch = async () => {
      const archivePromises: Promise<boolean>[] = [];
      for (const [cid] of this.chatSessions) {
        archivePromises.push(this.archiveSession(cid));
      }
      await Promise.all(archivePromises);

      const newBackend = await this.backendResolver!(target);
      this.agent = newBackend;
      this.backendType = target;
    };

    doSwitch()
      .then(() => {
        this.replyText(chatId, platformChatId, msgId,
          `已切换到 **${displayBackendType(target)}**，上下文已重置。重启后恢复为配置值。`);
        this.log.info("agent backend switched (runtime only)", { backend: target });
      })
      .catch((err) => {
        this.log.error("failed to switch agent backend", { error: String(err) });
        this.replyText(chatId, platformChatId, msgId, `切换失败: ${String(err)}`);
      });
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
    const reactionMsgIds = messages
      .map((message) => message.platformMsgId)
      .filter((msgId): msgId is string => !!msgId);

    if (platformChatId) {
      for (const msgId of reactionMsgIds) {
        this.moveMessageToProcessing(platformChatId, msgId);
      }
      for (const msgId of reactionMsgIds) {
        this.processingMsgIds.delete(msgId);
      }
    }

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

      // Inject unseen messages（agent 没见过的消息：内置命令回复、cron 结果等）
      // 只对 p2p 生效，群聊不注入
      const chatTypeRow = this.db.prepare("SELECT type FROM chats WHERE id = ?").get(chatId) as { type: string } | undefined;
      if ((chatTypeRow?.type ?? "p2p") === "p2p") {
        const sessionRow = this.db.prepare("SELECT start_msg_id FROM sessions WHERE id = ?").get(chatSession.sessionKey) as { start_msg_id: number | null } | undefined;
        const baseline = sessionRow?.start_msg_id ?? 0;
        const unseen = getUnseenMessages(this.db, chatId, baseline);
        if (unseen.length > 0) {
          const lines = unseen.map((m) => {
            const sender = m.role === "assistant" ? "bot" : (m.senderName ?? "user");
            return `[${sender}] ${m.contentText ?? ""}`;
          });
          messageToSend = `<system-hint>\n[对话流中你未看到的消息]\n${lines.join("\n")}\n以上消息已发送给用户。仅在用户主动提及时回应，不要打断当前话题。\n</system-hint>\n\n${messageToSend}`;
          markMessagesSeen(this.db, unseen.map((m) => m.id));
          this.log.info("injected unseen messages", { chatId, count: unseen.length });
        }
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
        agentSeen: true,
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
            agent_session_id = COALESCE(agent_session_id, ?),
            backend_type = COALESCE(backend_type, ?)
        WHERE id = ?
      `).run(
        chatSession.sessionKey,
        cumulativeBytes,
        replyMsgId,
        agentSessionId ?? null,
        this.backendType,
        chatSession.sessionKey,
      );

      // 构建 footer（对齐 cc-connect：shortId · #turn · context · model）
      const stats = this.db.prepare(
        "SELECT turn_count FROM sessions WHERE id = ?",
      ).get(chatSession.sessionKey) as { turn_count: number } | undefined;
      const footer = buildResponseFooter({
        sessionKey: chatSession.sessionKey,
        turnCount: stats?.turn_count,
        contextTokens: response.contextTokens,
        compactCount: response.compactCount,
        model: response.model,
      });

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
    this.pendingRouteDecisions.delete(chatId);

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

    // 构建 normal 上下文（全局摘要 + 最近 session summaries）— 后续拼到首条消息前缀
    const normalContext = buildNormalContext(this.db, chatId);
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
        INSERT INTO sessions (id, chat_id, user_id, status, start_msg_id, started_at, last_active_at, backend_type)
        VALUES (?, ?, ?, 'active', ?, datetime('now'), datetime('now'), ?)
      `).run(sessionKey, chatId, userId ?? null, startMsgId, this.backendType);

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
    });

    await this.archiveSession(chatId);

    this.db.prepare(`
      UPDATE messages SET session_key = NULL
      WHERE chat_id = ? AND session_key = ?
        AND id > COALESCE((SELECT end_msg_id FROM sessions WHERE id = ?), 0)
    `).run(chatId, existing.sessionKey, existing.sessionKey);

    this.pendingRouteDecisions.set(chatId, decision);
  }

  private async archiveSession(chatId: string): Promise<boolean> {
    const session = this.chatSessions.get(chatId);
    if (!session) {
      const result = this.db.prepare(`
        UPDATE sessions
        SET status = 'archived',
            ended_at = datetime('now'),
            last_active_at = datetime('now'),
            agent_session_id = NULL
        WHERE chat_id = ? AND status = 'active'
      `).run(chatId);

      return result.changes > 0;
    }

    const { agentSession, sessionKey } = session;

    const sessionRow = this.db.prepare(
      "SELECT source FROM sessions WHERE id = ?",
    ).get(sessionKey) as { source: string | null } | undefined;

    const isUserSession = (sessionRow?.source ?? "user") === "user";

    if (isUserSession) {
      this.archivingChats.add(chatId);
      try {
        const response = await this.agent.sendMessage(agentSession, ARCHIVE_SUMMARY_PROMPT);

        if (!response.cancelled) {
          const text = response.text.trim();
          // LLM 返回 null 表示无实质内容，跳过
          if (text === "null") {
            this.log.info("archive summary skipped (null)", { chatId, sessionKey });
          } else {
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              this.db.prepare(
                "UPDATE sessions SET summary = ?, topics = ? WHERE id = ?",
              ).run(JSON.stringify(parsed), JSON.stringify(parsed.topics ?? []), sessionKey);
              this.log.info("archive summary generated", { chatId, sessionKey });

              // 更新全局摘要
              await this.updateStateSummary(chatId, jsonMatch[0]);
            } else {
              this.log.warn("archive summary response has no JSON", { chatId, sessionKey });
            }
          }
        }
      } catch (err) {
        this.log.warn("failed to generate archive summary", { chatId, sessionKey, error: String(err) });
      } finally {
        this.archivingChats.delete(chatId);
      }
    }

    this.db.prepare(`
      UPDATE sessions SET status = 'archived', ended_at = datetime('now'), last_active_at = datetime('now')
      WHERE id = ?
    `).run(sessionKey);

    this.chatSessions.delete(chatId);
    await this.agent.closeSession(agentSession).catch((err) => {
      this.log.warn("failed to close backend session during archive", { chatId, sessionKey, error: String(err) });
    });

    this.log.info("session archived", { chatId, sessionKey });
    return true;
  }

  /** 用 lite model 滚动更新全局摘要 */
  private async updateStateSummary(chatId: string, sessionSummaryJson: string): Promise<void> {
    const chatRow = this.db.prepare(
      "SELECT state_summary FROM chats WHERE id = ?",
    ).get(chatId) as { state_summary: string | null } | undefined;

    const currentState = chatRow?.state_summary ?? null;
    const prompt = buildStateSummaryPrompt(currentState, sessionSummaryJson);

    let session;
    try {
      session = await this.agent.createSession({ modelTier: "lite" });
    } catch (err) {
      this.log.warn("failed to create state summary session", { chatId, error: String(err) });
      return;
    }

    try {
      const response = await this.agent.sendMessage(session, prompt);
      const jsonMatch = response.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        this.db.prepare("UPDATE chats SET state_summary = ? WHERE id = ?")
          .run(jsonMatch[0], chatId);
        this.log.info("state summary updated", { chatId });
      } else {
        this.log.warn("state summary response has no JSON", { chatId });
      }
    } catch (err) {
      this.log.warn("failed to update state summary", { chatId, error: String(err) });
    } finally {
      await this.agent.closeSession(session).catch(() => {});
    }
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

function displayBackendType(type: AgentBackendType): string {
  return type;
}
