import { randomUUID } from "node:crypto";
import { exec, execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type { PlatformAdapter, NormalizedMessage } from "../im/types.js";
import { escapeYamlContent, renderMessageNodes } from "../im/render.js";
import type { AgentBackend, AgentSession } from "../agent/types.js";
import { BUILTIN_BACKEND_LIST, normalizeBackend, type AgentBackendType } from "../config.js";
import { MessageQueue } from "./queue.js";
import {
  ensureUser, ensureChat, storeMessage, updateChatName,
  getUserShortLabel, getChatShortLabel, formatSenderLabel, getMessageByPlatformId, updateMessageContent, updateMessagePlatformId,
  getUnseenMessages, markMessagesSeen,
  setUserAdminRole, getAdminUserIds, getUserAdminRole, type AdminRole,
} from "../database/schema.js";
import { buildImportantContext, buildNormalContext, buildSpeakerContext, type SceneInfo, type SpeakerInfo } from "../memory/inject.js";
import { loadPersona } from "../persona.js";
import { buildArchiveSummaryPrompt } from "./prompts.js";
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
const INTERRUPT_WORDS = new Set([
  "停", "停下", "停止", "打住", "够了", "算了", "算了吧", "取消",
  "等等", "等一下", "稍等",
  "stop", "cancel", "abort",
]);
/** Bot 身份信息，由外部传入 */
export interface BotIdentity {
  /** Bot 显示名称（如 "CowBot"，从平台 API 获取或 config 指定） */
  name: string;
  /** IM 平台标识（如 "feishu"） */
  platform: string;
  /** Bot 在平台上的唯一标识（用于 DB 中的 bot 用户记录） */
  platformBotId: string;
  /** 主模型 ID（可选，覆盖 backend 默认值） */
  model?: string;
  /** 轻量模型 ID（可选，覆盖 backend 默认值） */
  liteModel?: string;
  /** 人设文件路径（注入到 admin 的场景信息中） */
  personaPath?: string;
}

interface ChatSession {
  agentSession: AgentSession;
  sessionId: string;
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
  private getAvailableBackends: () => string[];
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

  /** admin 角色映射：userId → role */
  private adminRoles = new Map<string, AdminRole>();

  /** agent 工作目录 */
  private workingDirectory: string;

  /** 数据库路径（传递给 agent 子进程） */
  private dbPath: string;

  /** 启动时间戳，用于 /status 计算 uptime */
  private startedAt = Date.now();

  /** 已处理的消息 ID 去重集合（有上限防内存泄漏） */
  private processedMsgIds = new Set<string>();
  private static readonly MAX_PROCESSED_IDS = 10000;

  /** chatId → 待完成的归档摘要 promise，新 session 创建前 await 确保 summary 就绪 */
  private pendingSummary = new Map<string, Promise<void>>();

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
    backendType: AgentBackendType = "claude",
    backendResolver?: (type: AgentBackendType) => Promise<AgentBackend>,
    getAvailableBackends?: () => string[],
  ) {
    this.db = db;
    this.im = im;
    this.agent = agent;
    this.backendType = backendType;
    this.backendResolver = backendResolver;
    this.getAvailableBackends = getAvailableBackends ?? (() => [...BUILTIN_BACKEND_LIST]);
    this.botIdentity = botIdentity;
    this.workingDirectory = workingDirectory;
    this.dbPath = dbPath;
    this.log = createLogger("pipeline", botIdentity.name);
    this.queue = new MessageQueue(bufferMs);

    this.queue.onProcess((chatId, mergedText, messages) => this.process(chatId, mergedText, messages));
  }

  /** 启动管道：注册 IM 消息回调 */
  async start(): Promise<void> {
    // Resolve bot's real open_id and display name from platform
    let platformBotName: string | undefined;
    try {
      const [realBotId, name] = await Promise.all([
        this.im.getBotOpenId(),
        this.im.getBotName(),
      ]);
      if (realBotId) {
        this.botIdentity.platformBotId = realBotId;
      }
      platformBotName = name ?? undefined;
    } catch (err) {
      this.log.warn("failed to fetch bot identity", { error: String(err) });
    }

    // 平台显示名写入 DB user 记录（用于 whoami 等场景），但不覆盖 botIdentity.name（config name，用于路径）
    this.botUserId = ensureUser(
      this.db,
      this.botIdentity.platform,
      this.botIdentity.platformBotId,
      platformBotName ?? this.botIdentity.name,
      "bot_info",
    );

    // Detect admin users
    await this.detectAdmins();

    this.im.onMessage((msg) => this.handleMessage(msg));
    this.log.info("pipeline started", {
      botUserId: this.botUserId,
      botPlatformId: this.botIdentity.platformBotId,
      adminCount: this.adminRoles.size,
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
          .run(session.sessionId);
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

  /** 检查用户是否为 admin 或 owner */
  isAdmin(userId: string): boolean {
    return this.adminRoles.has(userId);
  }

  /** 检查用户是否为 owner */
  isOwner(userId: string): boolean {
    return this.adminRoles.get(userId) === "owner";
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
          sessionId: row.id,
          storedBackendType: storedBackendType ?? "unknown",
          activeBackendType: this.backendType,
        });
        continue;
      }

      // 重建 important 上下文
      // 群聊：只注入 bot + chat 信息，不注入用户身份
      const isGroup = chatType === "group";
      const userRow = (!isGroup && row.user_id)
        ? this.db.prepare("SELECT name FROM users WHERE id = ?").get(row.user_id) as { name: string | null } | undefined
        : undefined;
      const isAdmin = row.user_id ? this.adminRoles.has(row.user_id) : false;
      const persona = this.botIdentity.personaPath ? loadPersona(this.botIdentity.personaPath) : undefined;
      const importantContext = buildImportantContext(this.db, {
        botName: this.botIdentity.name,
        botLabel: this.botUserId ? getUserShortLabel(this.db, this.botUserId) : undefined,
        userName: userRow?.name ?? undefined,
        userId: isGroup ? undefined : (row.user_id ?? undefined),
        chatId: row.chat_id,
        chatLabel: getChatShortLabel(this.db, row.chat_id),
        chatType,
        isAdmin,
        personaPath: isAdmin ? this.botIdentity.personaPath : undefined,
        personaContent: persona,
      });

      try {
        const supportsSystemPrompt = this.agent.supportsSystemPrompt === true;

        const agentSession = await this.agent.createSession({
          workingDirectory: this.workingDirectory,
          importantContext: supportsSystemPrompt ? (importantContext || undefined) : undefined,
          userId: row.user_id ?? undefined,
          chatId: row.chat_id,
          chatType,
          dbPath: this.dbPath,
          botId: this.botIdentity.platformBotId,
          model: this.botIdentity.model,
          liteModel: this.botIdentity.liteModel,
          isAdmin,
          agentSessionId: canResumeRecoveredSession ? (row.agent_session_id ?? undefined) : undefined,
        });

        // fallback 模式下：仅新建 session 时需要注入（resume 的 session 已有上下文）
        const isResuming = canResumeRecoveredSession && !!row.agent_session_id;
        if (!supportsSystemPrompt && importantContext && !isResuming) {
          this.pendingImportantContext.set(row.chat_id, importantContext);
        }

        this.chatSessions.set(row.chat_id, {
          agentSession,
          sessionId: row.id,
          platformChatId: row.platform_id,
          userId: row.user_id ?? "",
          hasReplied: true, // recovered sessions skip reply-to
        });
        this.platformChatIds.set(row.chat_id, row.platform_id);
        if (row.user_id) this.chatUserIds.set(row.chat_id, row.user_id);

        this.log.info("session recovered", {
          chatId: row.chat_id,
          sessionId: row.id,
          resumed: canResumeRecoveredSession && !!row.agent_session_id,
          storedBackendType: storedBackendType ?? "unknown",
          activeBackendType: this.backendType,
        });
      } catch (err) {
        this.log.error("failed to recover session", {
          chatId: row.chat_id,
          sessionId: row.id,
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

    // Collect user info from mentions + replace @name with @shortLabel
    if (msg.mentions) {
      for (const m of msg.mentions) {
        if (m.platformUserId && m.name) {
          const mentionUserId = ensureUser(this.db, platform, m.platformUserId, m.name, m.isBot ? "bot_sender" : "mention");
          const shortLabel = getUserShortLabel(this.db, mentionUserId);
          msg.contentText = msg.contentText.replaceAll(`@${m.name}`, `@${shortLabel}`);
        }
      }
    }

    const userId = ensureUser(this.db, platform, msg.senderPlatformId, msg.senderName, "bot_sender");

    // Fallback: if no admin detected yet and this is a p2p message, first user becomes owner
    if (this.adminRoles.size === 0 && msg.chatType === "p2p") {
      this.setAdminRole(userId, "owner", "first_p2p_user", msg.senderPlatformId);
    }

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

    const sessionId = this.chatSessions.get(chatId)?.sessionId;
    const incomingMsgId = storeMessage(this.db, {
      chatId,
      senderId: userId,
      sessionId,
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
      this.queue.drain(chatId);
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
      senderId: userId,
      dbMsgId: incomingMsgId,
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
      sessionId: this.chatSessions.get(chatId)?.sessionId,
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

    // Collect user info from mentions + replace @name with @shortLabel
    if (msg.mentions) {
      for (const m of msg.mentions) {
        if (m.platformUserId && m.name) {
          ensureUser(this.db, platform, m.platformUserId, m.name, m.isBot ? "bot_sender" : "mention");
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

  /** Persist a user's admin role in both memory and DB */
  private setAdminRole(userId: string, role: AdminRole, source: string, platformId?: string): void {
    const existing = this.adminRoles.get(userId);
    if (existing === role) return;
    // Never downgrade owner via this method
    if (existing === "owner" && role === "admin") return;
    this.adminRoles.set(userId, role);
    setUserAdminRole(this.db, userId, role);
    this.log.info("admin role set", { userId, role, source, platformId });
  }

  /** Remove admin from both memory and DB (cannot remove owner) */
  private removeAdmin(userId: string): boolean {
    if (this.adminRoles.get(userId) === "owner") return false;
    this.adminRoles.delete(userId);
    setUserAdminRole(this.db, userId, "none");
    this.log.info("admin removed", { userId });
    return true;
  }

  /** Detect admin users from DB + platform */
  private async detectAdmins(): Promise<void> {
    const platform = this.botIdentity.platform;

    // 0. Restore from DB
    for (const { id, role } of getAdminUserIds(this.db)) {
      this.adminRoles.set(id, role);
      this.log.info("admin restored from DB", { userId: id, role });
    }

    // 1. App creator → owner
    try {
      const creatorId = await this.im.getAppCreatorId();
      if (creatorId) {
        const userId = ensureUser(this.db, platform, creatorId, undefined, undefined);
        this.setAdminRole(userId, "owner", "app_creator", creatorId);
      }
    } catch (err) {
      this.log.warn("failed to detect app creator", { error: String(err) });
    }
  }

  /**
   * 内置命令拦截：匹配 /xxx 格式的消息，命中则直接处理并返回 true。
   * //xxx 视为强制透传给 agent，本地不拦截。
   * 未命中返回 false，消息继续走 agent 流程。
   *
   * 分发顺序（对齐 cc-connect）：
   *   1. 内置命令 switch（/restart, /status, /new, /clear, /cron, /stop）
   *   2. 管理员 shell 命令（tryShellCommand）
   *   3. return false → 转发给 agent
   */
  private handleBuiltinCommand(text: string, userId: string, chatId: string, platformChatId: string, msgId?: string): boolean {
    if (!text.startsWith("/") || text.startsWith("//")) return false;

    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const isAdmin = this.adminRoles.has(userId);

    // 1. 内置命令
    switch (cmd) {
      case "/restart": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "restart 仅管理员可用。");
          return true;
        }
        this.log.info("builtin command: restart", { userId });
        this.triggerRestart({ platformChatId });
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
      case "/admin": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "/admin 仅管理员可用。");
          return true;
        }
        this.handleAdminCommand(parts.slice(1), userId, chatId, platformChatId, msgId);
        return true;
      }
      case "/help": {
        this.log.info("builtin command: help", { userId });
        this.sendHelpCard(chatId, platformChatId, msgId, isAdmin);
        return true;
      }
      case "/stop": {
        this.log.info("builtin command: stop", { userId, chatId });
        const dropped = this.queue.drain(chatId);
        if (this.chatSessions.has(chatId)) {
          this.cancelChat(chatId).catch(() => {});
          const hint = dropped > 0 ? `好的，已停止（丢弃 ${dropped} 条排队消息）。` : "好的，已停止。";
          this.replyText(chatId, platformChatId, msgId, hint);
        } else if (dropped > 0) {
          this.replyText(chatId, platformChatId, msgId, `已清空 ${dropped} 条排队消息。`);
        } else {
          this.replyText(chatId, platformChatId, msgId, "当前没有正在执行的任务。");
        }
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

    let version = "unknown";
    try {
      const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
      const pkg = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf-8"));
      version = pkg.version;
    } catch { /* ignore */ }

    const content = [
      `**Bot:** ${this.botIdentity.name}`,
      `**Version:** ${version}`,
      `**Platform:** ${this.botIdentity.platform}`,
      `**Uptime:** ${uptimeStr}`,
      `**Active sessions:** ${activeSessions}`,
      `**Cron jobs:** ${cronCount}`,
      `**Path:** \`${path.dirname(path.resolve(process.argv[1]))}\``,
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
    const isGroup = chatType === "group";
    const userRow = (!isGroup && userId)
      ? this.db.prepare("SELECT name FROM users WHERE id = ?").get(userId) as { name: string | null } | undefined
      : undefined;
    const isAdmin = userId ? this.adminRoles.has(userId) : false;
    const persona = this.botIdentity.personaPath ? loadPersona(this.botIdentity.personaPath) : undefined;
    const importantContext = buildImportantContext(this.db, {
      botName: this.botIdentity.name,
      botLabel: this.botUserId ? getUserShortLabel(this.db, this.botUserId) : undefined,
      userName: userRow?.name ?? undefined,
      userId: isGroup ? undefined : userId,
      chatId,
      chatLabel: getChatShortLabel(this.db, chatId),
      chatType,
      isAdmin,
      personaPath: isAdmin ? this.botIdentity.personaPath : undefined,
      personaContent: persona,
    });

    // 等待上一个 session 的归档摘要完成，确保 context 注入拿到最新 summary
    await this.pendingSummary.get(chatId);

    // Build normal context（会话定位 + task 索引 + 最近 session summaries）
    const normalContext = buildNormalContext(this.db, chatId, this.workingDirectory, undefined, chatType);

    // Create independent agent session
    const supportsSystemPrompt = this.agent.supportsSystemPrompt === true;
    const agentSession = await this.agent.createSession({
      workingDirectory: this.workingDirectory,
      importantContext: supportsSystemPrompt ? (importantContext || undefined) : undefined,
      userId: userId ?? undefined,
      chatId,
      chatType,
      dbPath: this.dbPath,
      botId: this.botIdentity.platformBotId,
      model: this.botIdentity.model,
      liteModel: this.botIdentity.liteModel,
      isAdmin,
    });

    // Create session record with source='cron'
    const sessionId = randomUUID().slice(0, 8);
    this.db.prepare(`
      INSERT INTO sessions (id, chat_id, user_id, source, status, started_at, last_active_at, backend_type)
      VALUES (?, ?, ?, 'cron', 'active', datetime('now'), datetime('now'), ?)
    `).run(sessionId, chatId, userId, this.backendType);

    // Store cron prompt as user message
    storeMessage(this.db, {
      chatId,
      senderId: userId,
      sessionId,
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

    this.log.info("executing cron job", { chatId, sessionId, userId, description });

    try {
      const response = await this.agent.sendMessage(agentSession, messageToSend);

      if (response.cancelled) {
        this.log.warn("cron job was cancelled", { chatId, sessionId });
        return;
      }

      // Store response
      const replyMsgId = storeMessage(this.db, {
        chatId,
        senderId: this.botUserId!,
        sessionId,
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
      `).run(replyMsgId, agentSessionId ?? null, this.backendType, sessionId);

      // Build footer
      const footer = buildResponseFooter({
        sessionId: agentSessionId ?? sessionId,
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

      this.log.info("cron job completed", { chatId, sessionId, responseLength: response.text.length });
    } catch (err) {
      this.log.error("cron job execution failed", { chatId, sessionId, error: String(err) });
    } finally {
      // Archive session（turn=1，不触发 archive summary）
      this.db.prepare(`
        UPDATE sessions SET status = 'archived', ended_at = datetime('now'), last_active_at = datetime('now')
        WHERE id = ?
      `).run(sessionId);

      await this.agent.closeSession(agentSession).catch((closeErr) => {
        this.log.warn("failed to close cron session", { chatId, sessionId, error: String(closeErr) });
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
   * /admin 命令：管理员列表/添加/移除。
   * - /admin             → 显示管理员列表
   * - /admin add @某人   → 添加管理员（需要 @ mention）
   * - /admin remove @某人 → 移除管理员
   */
  private handleAdminCommand(args: string[], userId: string, chatId: string, platformChatId: string, msgId?: string): void {
    const sub = args[0]?.toLowerCase();

    if (!sub || sub === "list") {
      const admins = getAdminUserIds(this.db);
      if (admins.length === 0) {
        this.replyText(chatId, platformChatId, msgId, "当前没有管理员。");
        return;
      }
      const lines = admins.map(({ id, role }) => {
        const label = getUserShortLabel(this.db, id);
        return role === "owner" ? `- ${label} (owner)` : `- ${label}`;
      });
      this.replyText(chatId, platformChatId, msgId, `管理员列表：\n${lines.join("\n")}`);
      return;
    }

    if (sub === "add" || sub === "remove") {
      // Only owner can add/remove
      if (!this.isOwner(userId)) {
        this.replyText(chatId, platformChatId, msgId, "只有 owner 可以管理管理员。");
        return;
      }

      const rest = args.slice(1).join(" ");
      const match = rest.match(/@(u\d+)/i);
      if (!match) {
        this.replyText(chatId, platformChatId, msgId, `用法：/admin ${sub} @某人`);
        return;
      }
      const targetUserId = match[1].toLowerCase();

      const userRow = this.db.prepare("SELECT id, name FROM users WHERE id = ?").get(targetUserId) as { id: string; name: string | null } | undefined;
      if (!userRow) {
        this.replyText(chatId, platformChatId, msgId, `用户 ${targetUserId} 不存在。`);
        return;
      }

      const label = getUserShortLabel(this.db, targetUserId);

      if (sub === "add") {
        if (this.adminRoles.has(targetUserId)) {
          this.replyText(chatId, platformChatId, msgId, `${label} 已经是管理员了。`);
          return;
        }
        this.setAdminRole(targetUserId, "admin", "manual");
        this.replyText(chatId, platformChatId, msgId, `已添加 ${label} 为管理员。`);
      } else {
        if (!this.adminRoles.has(targetUserId)) {
          this.replyText(chatId, platformChatId, msgId, `${label} 不是管理员。`);
          return;
        }
        if (this.isOwner(targetUserId)) {
          this.replyText(chatId, platformChatId, msgId, `${label} 是 owner，不能被移除。`);
          return;
        }
        this.removeAdmin(targetUserId);
        this.replyText(chatId, platformChatId, msgId, `已移除 ${label} 的管理员权限。`);
      }
      return;
    }

    this.replyText(chatId, platformChatId, msgId, "用法：/admin [list|add|remove] [@某人]");
  }

  /**
   * /agent 命令：查看或切换 agent backend。
   * - /agent        → 显示当前 backend
   * - /agent <type> → 切换到指定 backend，归档当前 session
   */
  private handleAgentCommand(args: string[], chatId: string, platformChatId: string, msgId?: string): void {
    if (args.length === 0) {
      // 显示当前 backend（卡片）
      const backends = this.getAvailableBackends();
      const content = backends.map((b) =>
        b === this.backendType ? `◉ ${b}` : `○ ${b}`,
      ).join("\n");
      this.sendAgentCard(chatId, platformChatId, msgId, "Agent", content);
      return;
    }

    const target = normalizeBackend(args[0]);

    const available = this.getAvailableBackends();
    if (!target || !available.includes(target)) {
      const content = `无效的 backend: \`${args[0]}\`\n\n可选: ${available.join(", ")}`;
      this.sendAgentCard(chatId, platformChatId, msgId, "Agent", content);
      return;
    }

    if (target === this.backendType) {
      this.sendAgentCard(chatId, platformChatId, msgId, "Agent", `已经是 **${displayBackendType(target)}**，无需切换。`);
      return;
    }

    if (!this.backendResolver) {
      this.sendAgentCard(chatId, platformChatId, msgId, "Agent", "backend resolver 未配置，无法切换。");
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
        this.sendAgentCard(chatId, platformChatId, msgId, "Agent",
          `已切换到 **${displayBackendType(target)}**\n上下文已重置，重启后恢复为配置值。`);
        this.log.info("agent backend switched (runtime only)", { backend: target });
      })
      .catch((err) => {
        this.log.error("failed to switch agent backend", { error: String(err) });
        this.sendAgentCard(chatId, platformChatId, msgId, "Agent", `切换失败: ${String(err)}`);
      });
  }

  /** 发送 Agent 命令卡片回复 */
  private sendAgentCard(chatId: string, platformChatId: string, msgId: string | undefined, header: string, content: string): void {
    const send = msgId
      ? this.im.replyCard(msgId, header, content)
      : this.im.sendCard(platformChatId, header, content);
    send
      .then((pmid) => { this.storeBotResponse(chatId, content, pmid); })
      .catch(() => {});
  }

  /** 发送 /help 卡片 */
  private sendHelpCard(chatId: string, platformChatId: string, msgId: string | undefined, isAdmin: boolean): void {
    const lines = [
      "`/new`　　新会话（清空当前上下文）",
      "`/stop`　　停止正在执行的任务",
      "`/status`　查看运行状态",
      "`/cron`　　查看定时任务",
      "`/help`　　显示本帮助",
    ];
    if (isAdmin) {
      lines.push(
        "",
        "**管理员**",
        "`/admin`　　管理员列表/添加/移除",
        "`/agent`　　查看/切换 Agent backend",
        "`/restart`　重启引擎",
        "`/<cmd>`　　执行 shell 命令",
      );
    }
    const content = lines.join("\n");
    const send = msgId
      ? this.im.replyCard(msgId, "Help", content)
      : this.im.sendCard(platformChatId, "Help", content);
    send
      .then((pmid) => { this.storeBotResponse(chatId, content, pmid); })
      .catch(() => {});
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
   * restart.sh 负责：sleep → build → preflight → kill old → start new → health check → notify。
   * 可通过 platformChatId 或 chatId 指定通知目标，都不传则不发通知。
   */
  triggerRestart(opts?: { platformChatId?: string; chatId?: string }): void {
    const projectRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    const restartScript = path.join(projectRoot, "restart.sh");

    // 解析 chatId 和 platformChatId（互相反查）
    let chatId = opts?.chatId;
    let platformChatId = opts?.platformChatId;
    if (!chatId && platformChatId) {
      for (const [cid, pid] of this.platformChatIds) {
        if (pid === platformChatId) { chatId = cid; break; }
      }
    } else if (chatId && !platformChatId) {
      platformChatId = this.platformChatIds.get(chatId);
    }

    // 发送"正在重启..."通知
    if (platformChatId) {
      this.im.sendText(platformChatId, "正在重启...").catch(() => {});
    }

    const socketPath = path.join(path.dirname(this.dbPath), "api.sock");

    const child = spawn("nohup", ["bash", restartScript], {
      cwd: projectRoot,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        NIUBOT_CHAT_ID: chatId ?? "",
        NIUBOT_API_SOCKET: socketPath,
        RESTART_DETACHED: "1",
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

      const msgIds = messages.map((m) => m.dbMsgId).filter((id): id is number => id != null);
      const firstMsgId = msgIds.length > 0 ? Math.min(...msgIds) : undefined;
      const chatSession = await this.getOrCreateSession(chatId, firstMsgId);

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

      // 群聊：消息级 speaker 注入（<current-speaker> / <speakers>）
      const chatTypeRow = this.db.prepare("SELECT type FROM chats WHERE id = ?").get(chatId) as { type: string } | undefined;
      const processChatType = (chatTypeRow?.type ?? "p2p") as "p2p" | "group";
      if (processChatType === "group" && messages.length > 0) {
        // 提取去重的 sender 列表
        const senderIds = [...new Set(messages.map((m) => m.senderId).filter((id): id is string => !!id))];
        if (senderIds.length > 0) {
          const speakers: SpeakerInfo[] = senderIds.map((id) => {
            const row = this.db.prepare("SELECT name FROM users WHERE id = ?").get(id) as { name: string | null } | undefined;
            return {
              userId: id,
              userName: row?.name ?? undefined,
              isAdmin: this.adminRoles.has(id),
            };
          });
          const speakerCtx = buildSpeakerContext(this.db, speakers);
          if (speakerCtx) {
            messageToSend = `${speakerCtx}\n\n${messageToSend}`;
          }
        }
      }

      // Inject unseen messages（agent 没见过的消息：内置命令回复、cron 结果等）
      // 只对 p2p 生效，群聊不注入
      if (processChatType === "p2p") {
        const sessionRow = this.db.prepare("SELECT start_msg_id FROM sessions WHERE id = ?").get(chatSession.sessionId) as { start_msg_id: number | null } | undefined;
        const baseline = sessionRow?.start_msg_id ?? 0;
        // 先把走 agent 的用户消息标为已见，再查 unseen 时就不会查到它们
        const agentMsgIds = messages.map((m) => m.dbMsgId).filter((id): id is number => id != null);
        if (agentMsgIds.length > 0) {
          markMessagesSeen(this.db, agentMsgIds);
        }
        const unseen = getUnseenMessages(this.db, chatId, baseline);
        if (unseen.length > 0) {
          const lines = unseen.map((m) => {
            const sender = formatSenderLabel(m.senderId, m.senderName, m.role);
            const text = m.contentText ?? "";
            const truncated = text.length > 200 ? text.slice(0, 200) + "…" : text;
            return `${sender}: ${truncated}`;
          });
          messageToSend = `<unseen-messages>\n${lines.join("\n")}\n以上消息已发送给用户。不必主动复述，但应将其作为上下文纳入后续回复。\n</unseen-messages>\n\n${messageToSend}`;
          markMessagesSeen(this.db, unseen.map((m) => m.id));
          this.log.info("injected unseen messages", { chatId, count: unseen.length });
        }
      }

      this.log.info("sending to agent", {
        chatId,
        sessionId: chatSession.sessionId,
        textLength: messageToSend.length,
      });

      const response = await this.agent.sendMessage(chatSession.agentSession, messageToSend);

      // cancelled：有内容就发（中间结果），没内容就静默（用户已收到"已停止"）
      if (response.cancelled) {
        if (response.text.trim()) {
          this.log.info("cancelled with content, delivering result", { chatId, responseLength: response.text.length });
        } else {
          this.log.info("prompt cancelled, no response to send", { chatId });
          return;
        }
      }

      // 非 cancel 的空响应：发兜底提示，防止用户等半天没反应
      if (!response.text.trim()) {
        this.log.warn("empty response from agent", { chatId });
        response.text = "（处理完成，但未生成回复。如果没收到预期结果，请重试）";
      }

      // 存储 agent 回复并标记已见
      const replyMsgId = storeMessage(this.db, {
        chatId,
        senderId: this.botUserId!,
        sessionId: chatSession.sessionId,
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
        chatSession.sessionId,
        cumulativeBytes,
        replyMsgId,
        agentSessionId ?? null,
        this.backendType,
        chatSession.sessionId,
      );

      // 构建 footer（对齐 cc-connect：shortId · #turn · context · model）
      const stats = this.db.prepare(
        "SELECT turn_count FROM sessions WHERE id = ?",
      ).get(chatSession.sessionId) as { turn_count: number } | undefined;
      const footer = buildResponseFooter({
        sessionId: agentSessionId ?? chatSession.sessionId,
        turnCount: stats?.turn_count,
        contextTokens: response.contextTokens,
        compactCount: response.compactCount,
        model: response.model,
      });

      // 合并消息提示头
      let displayText = response.text;
      let deliveredText = response.text;
      if (isMerged) {
        const lines = messages.map((m) => {
          const brief = m.text.length > 10 ? m.text.slice(0, 10) + "…" : m.text;
          return `• ${brief}`;
        });
        displayText = `> 📌 回复 ${messages.length} 条消息：\n${lines.map((l) => `> ${l}`).join("\n")}\n\n${response.text}`;
      }

      // 发送到 IM（始终用卡片，footer 带 session 信息）
      let sentPlatformMsgId: string | undefined;
      const sendFallbackText = (text: string) => triggerMsgId
        ? this.im.sendReply(chatSession.platformChatId, text, triggerMsgId)
        : this.im.sendText(chatSession.platformChatId, text);
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
        // 先把平台错误原样回给用户；若平台连这条也拦，再降级为稳定短句。
        try {
          deliveredText = `发送失败：${extractPlatformErrorDetail(sendErr)}`;
          sentPlatformMsgId = await sendFallbackText(deliveredText);
        } catch (platformErrEchoErr) {
          this.log.warn("failed to surface platform error to user", {
            chatId,
            error: String(platformErrEchoErr),
          });
          try {
            deliveredText = buildPlatformFailureFallback(sendErr);
            sentPlatformMsgId = await sendFallbackText(deliveredText);
          } catch (fallbackSendErr) {
            this.log.error("failed to send degraded platform error", {
              chatId,
              error: String(fallbackSendErr),
            });
          }
        }
      }

      // 回写 platform_msg_id（用于 merge_forward 等场景的内容缓存查找）
      if (sentPlatformMsgId) {
        if (deliveredText !== response.text) {
          updateMessageContent(this.db, replyMsgId, deliveredText);
        }
        updateMessagePlatformId(this.db, replyMsgId, sentPlatformMsgId);
      }

      if (sentPlatformMsgId) {
        this.log.info("response sent", {
          chatId,
          responseLength: response.text.length,
          filesChanged: response.filesChanged,
        });
      } else {
        this.log.warn("response not delivered to IM", {
          chatId,
          responseLength: response.text.length,
        });
      }
    } catch (err) {
      this.log.error("pipeline error", { chatId, error: String(err) });

      if (platformChatId) {
        const detail = extractAgentErrorDetail(err);
        const errorText = detail
          ? `处理出错了：${detail}`
          : "处理出错了，请稍后再试。";
        try {
          const pmid = await this.im.sendText(platformChatId, errorText);
          this.storeBotResponse(chatId, errorText, pmid);
        } catch { /* give up */ }
      }
    }
  }

  private async getOrCreateSession(chatId: string, beforeMsgId?: number): Promise<ChatSession> {
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
    // 群聊：只注入 bot + chat 信息，不注入用户身份（由消息级 speaker 注入）
    const isGroup = chatType === "group";
    const userRow = (!isGroup && userId)
      ? this.db.prepare("SELECT name FROM users WHERE id = ?").get(userId) as { name: string | null } | undefined
      : undefined;
    const isAdmin = userId ? this.adminRoles.has(userId) : false;
    const persona = this.botIdentity.personaPath ? loadPersona(this.botIdentity.personaPath) : undefined;
    const importantContext = buildImportantContext(this.db, {
      botName: this.botIdentity.name,
      botLabel: this.botUserId ? getUserShortLabel(this.db, this.botUserId) : undefined,
      userName: userRow?.name ?? undefined,
      userId: isGroup ? undefined : userId,
      chatId,
      chatLabel: getChatShortLabel(this.db, chatId),
      chatType,
      isAdmin,
      personaPath: isAdmin ? this.botIdentity.personaPath : undefined,
      personaContent: persona,
    });

    // 等待上一个 session 的归档摘要完成，确保 context 注入拿到最新 summary
    await this.pendingSummary.get(chatId);

    // 构建 normal 上下文（会话定位 + task 索引 + 最近 session summaries）— 后续拼到首条消息前缀
    const normalContext = buildNormalContext(this.db, chatId, this.workingDirectory, beforeMsgId, chatType);
    if (normalContext) {
      this.pendingNormalContext.set(chatId, normalContext);
    }

    // backend 不支持 system prompt 时，important 上下文 fallback 到首条消息前缀
    const supportsSystemPrompt = this.agent.supportsSystemPrompt === true;

    const agentSession = await this.agent.createSession({
      workingDirectory: this.workingDirectory,
      importantContext: supportsSystemPrompt ? (importantContext || undefined) : undefined,
      userId: userId ?? undefined,
      chatId,
      chatType,
      dbPath: this.dbPath,
      botId: this.botIdentity.platformBotId,
      model: this.botIdentity.model,
      liteModel: this.botIdentity.liteModel,
      isAdmin,
    });

    if (!supportsSystemPrompt && importantContext) {
      this.pendingImportantContext.set(chatId, importantContext);
    }

    const sessionId = randomUUID().slice(0, 8);

    try {
      const orphan = this.db.prepare(
        "SELECT MIN(id) as startId FROM messages WHERE chat_id = ? AND session_key IS NULL",
      ).get(chatId) as { startId: number | null } | undefined;
      const startMsgId = orphan?.startId ?? null;

      this.db.prepare(`
        INSERT INTO sessions (id, chat_id, user_id, status, start_msg_id, started_at, last_active_at, backend_type)
        VALUES (?, ?, ?, 'active', ?, datetime('now'), datetime('now'), ?)
      `).run(sessionId, chatId, userId ?? null, startMsgId, this.backendType);

      this.db.prepare(
        "UPDATE messages SET session_key = ? WHERE chat_id = ? AND session_key IS NULL",
      ).run(sessionId, chatId);
    } catch (dbErr) {
      await this.agent.closeSession(agentSession).catch(() => {});
      throw dbErr;
    }

    const chatSession: ChatSession = {
      agentSession,
      sessionId,
      platformChatId,
      userId: userId ?? "",
      triggerPlatformMsgId: this.triggerMsgIds.get(chatId),
      hasReplied: false,
    };
    this.chatSessions.set(chatId, chatSession);

    this.log.info("session created", { chatId, sessionId, userId, agentSessionId: agentSession.id });
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
    ).get(existing.sessionId) as { last_active_at: string | null; turn_count: number } | undefined;

    if (!sessionRow?.last_active_at) return;
    if (sessionRow.turn_count < Pipeline.ROUTE_MIN_TURNS) return;

    const decision = await decideRoute(
      this.agent,
      this.db,
      chatId,
      sessionRow.last_active_at,
      newMessage,
      existing.sessionId,
      this.botIdentity.liteModel,
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
    `).run(chatId, existing.sessionId, existing.sessionId);

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

    const { agentSession, sessionId } = session;

    const sessionRow = this.db.prepare(
      "SELECT source, start_msg_id, end_msg_id FROM sessions WHERE id = ?",
    ).get(sessionId) as { source: string | null; start_msg_id: number | null; end_msg_id: number | null } | undefined;

    const isUserSession = (sessionRow?.source ?? "user") === "user";

    // 先关闭 agent session，不阻塞摘要生成
    this.db.prepare(`
      UPDATE sessions SET status = 'archived', ended_at = datetime('now'), last_active_at = datetime('now')
      WHERE id = ?
    `).run(sessionId);

    this.chatSessions.delete(chatId);
    await this.agent.closeSession(agentSession).catch((err) => {
      this.log.warn("failed to close backend session during archive", { chatId, sessionId, error: String(err) });
    });

    this.log.info("session archived", { chatId, sessionId });

    // 用 lite model 异步生成归档摘要，promise 存起来供新 session 创建时 await
    if (isUserSession && sessionRow?.start_msg_id != null && sessionRow?.end_msg_id != null) {
      const summaryPromise = this.generateArchiveSummary(chatId, sessionId, sessionRow.start_msg_id, sessionRow.end_msg_id)
        .catch((err) => this.log.warn("archive summary failed", { chatId, sessionId, error: String(err) }))
        .finally(() => this.pendingSummary.delete(chatId));
      this.pendingSummary.set(chatId, summaryPromise);
    }
    return true;
  }

  /** 用 lite model 从 DB 消息生成归档摘要 */
  private async generateArchiveSummary(chatId: string, sessionId: string, startMsgId: number, endMsgId: number): Promise<void> {
    // 从 DB 捞消息，拼成对话文本
    const rows = this.db.prepare(`
      SELECT m.role, m.sender_id, m.content_text, u.name as sender_name
      FROM messages m
      LEFT JOIN users u ON m.sender_id = u.id
      WHERE m.id BETWEEN ? AND ? AND m.chat_id = ? AND m.content_text IS NOT NULL
      ORDER BY m.id ASC
    `).all(startMsgId, endMsgId, chatId) as Array<{
      role: string;
      sender_id: string | null;
      content_text: string;
      sender_name: string | null;
    }>;

    if (rows.length === 0) {
      this.log.info("archive summary skipped (no messages)", { chatId, sessionId });
      return;
    }

    const lines = rows.map((r) => {
      const sender = formatSenderLabel(r.sender_id, r.sender_name, r.role);
      const text = r.content_text.length > 500 ? r.content_text.slice(0, 500) + "..." : r.content_text;
      return `${sender}: ${text}`;
    });

    // 总长度限制 ~150K 字符，超了砍头部保留最近的消息
    const MAX_TOTAL_LEN = 150_000;
    let conversationText = lines.join("\n");
    if (conversationText.length > MAX_TOTAL_LEN) {
      conversationText = "...(早期对话省略)...\n\n" + conversationText.slice(-MAX_TOTAL_LEN);
    }

    const prompt = buildArchiveSummaryPrompt(conversationText);

    let session;
    try {
      session = await this.agent.createSession({ modelTier: "lite", liteModel: this.botIdentity.liteModel });
    } catch (err) {
      this.log.warn("failed to create archive summary session", { chatId, sessionId, error: String(err) });
      return;
    }

    try {
      const response = await this.agent.sendMessage(session, prompt);
      const text = response.text.trim();

      if (text === "null") {
        this.log.info("archive summary skipped (null)", { chatId, sessionId });
      } else {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          // topics 列存放搜索用关键词：旧格式的 topic titles + 新格式的 tags
          const topicTitles = Array.isArray(parsed.topics)
            ? parsed.topics.map((t: any) => typeof t === "string" ? t : t.title).filter(Boolean)
            : [];
          const tags = Array.isArray(parsed.tags) ? parsed.tags.filter(Boolean) : [];
          const searchTerms = [...new Set([...topicTitles, ...tags])];
          this.db.prepare(
            "UPDATE sessions SET summary = ?, topics = ? WHERE id = ?",
          ).run(JSON.stringify(parsed), JSON.stringify(searchTerms), sessionId);
          this.log.info("archive summary generated", { chatId, sessionId });
        } else {
          this.log.warn("archive summary response has no JSON", { chatId, sessionId });
        }
      }
    } catch (err) {
      this.log.warn("failed to generate archive summary", { chatId, sessionId, error: String(err) });
    } finally {
      await this.agent.closeSession(session).catch(() => {});
    }
  }

  private async cancelChat(chatId: string): Promise<void> {
    const session = this.chatSessions.get(chatId);
    if (!session) return;

    await this.agent.cancelSession(session.agentSession);
  }
}

function extractAgentErrorDetail(err: unknown): string | null {
  const stderr = typeof err === "object" && err !== null && "stderr" in err
    ? String((err as { stderr?: unknown }).stderr ?? "")
    : "";
  const stdout = typeof err === "object" && err !== null && "stdout" in err
    ? String((err as { stdout?: unknown }).stdout ?? "")
    : "";

  // Collect all meaningful error fragments from every source.
  // Different agent backends embed errors in different formats / streams,
  // so we gather everything and let the caller display it all.
  const parts: string[] = [];

  for (const stream of [stdout, stderr]) {
    if (!stream) continue;
    for (const line of stream.split("\n")) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        // Claude format: {type:"result", is_error:true, result:"..."}
        if (event.type === "result" && event.is_error && typeof event.result === "string" && event.result.trim()) {
          parts.push(event.result.trim());
        }
        // Codex / generic format: {type:"error", message:"..."}
        if (event.type === "error" && typeof event.message === "string" && event.message.trim()) {
          parts.push(event.message.trim());
        }
      } catch {
        // Not JSON — keep raw non-empty lines as-is
        const trimmed = line.trim();
        if (trimmed) parts.push(trimmed);
      }
    }
  }

  // Also include the Error.message itself (may carry info not in streams)
  const message = err instanceof Error ? err.message.trim() : String(err ?? "").trim();
  if (message) parts.push(message);

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique = parts.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });

  return unique.length > 0 ? unique.join("\n") : null;
}

function extractPlatformErrorDetail(err: unknown): string {
  const data = typeof err === "object" && err !== null && "response" in err
    ? (err as { response?: { data?: { code?: unknown; msg?: unknown } } }).response?.data
    : undefined;
  const msg = typeof data?.msg === "string" ? data.msg.trim() : "";
  const code = data?.code;

  if (msg && code !== undefined && code !== null && String(code).trim()) {
    return `${msg} (code: ${String(code).trim()})`;
  }
  if (msg) return msg;

  const message = err instanceof Error ? err.message.trim() : String(err ?? "").trim();
  return message || "平台发送失败";
}

function buildPlatformFailureFallback(err: unknown): string {
  const data = typeof err === "object" && err !== null && "response" in err
    ? (err as { response?: { data?: { code?: unknown } } }).response?.data
    : undefined;
  const code = data?.code;

  if (code !== undefined && code !== null && String(code).trim()) {
    return `上一条回复未送达：平台发送失败（code: ${String(code).trim()}）。`;
  }
  return "上一条回复未送达：平台发送失败。";
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
