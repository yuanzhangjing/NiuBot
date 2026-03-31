import type Database from "better-sqlite3";
import type { PlatformAdapter, NormalizedMessage } from "../im/types.js";
import type { AgentBackend, AgentSession } from "../agent/types.js";
import { MessageQueue } from "./queue.js";
import { ensureUser, ensureChat, storeMessage } from "../database/schema.js";
import { buildSessionContext } from "../memory/inject.js";
import { createLogger } from "../logger.js";

const log = createLogger("pipeline");

const PLATFORM = "feishu";
const PROCESSING_EMOJI = "Get";

interface ChatSession {
  agentSession: AgentSession;
  sessionKey: string;
  platformChatId: string;
  userId: string;
}

export class Pipeline {
  private db: Database.Database;
  private im: PlatformAdapter;
  private agent: AgentBackend;
  private queue: MessageQueue;

  /** 每个 chat 的当前 agent session（M1: 一个 chat 一个 session） */
  private chatSessions = new Map<string, ChatSession>();

  /** chatId → platformChatId 映射 */
  private platformChatIds = new Map<string, string>();

  /** chatId → userId 映射 */
  private chatUserIds = new Map<string, string>();

  /** bot 的内部用户 ID */
  private botUserId: string | null = null;

  /** agent 工作目录 */
  private workingDirectory: string;

  /** 数据库路径（传递给 agent 子进程） */
  private dbPath: string;

  /** 已处理的消息 ID 去重集合（有上限防内存泄漏） */
  private processedMsgIds = new Set<string>();
  private static readonly MAX_PROCESSED_IDS = 10000;

  constructor(
    db: Database.Database,
    im: PlatformAdapter,
    agent: AgentBackend,
    workingDirectory: string,
    dbPath: string,
    bufferMs: number,
    cancelThresholdMs: number,
  ) {
    this.db = db;
    this.im = im;
    this.agent = agent;
    this.workingDirectory = workingDirectory;
    this.dbPath = dbPath;
    this.queue = new MessageQueue(bufferMs, cancelThresholdMs);

    this.queue.onProcess((chatId, mergedText) => this.process(chatId, mergedText));
    this.queue.onCancel((chatId) => this.cancelChat(chatId));
  }

  /** 启动管道：注册 IM 消息回调 */
  start(): void {
    this.botUserId = ensureUser(this.db, PLATFORM, "_niubot_", "NiuBot");
    this.im.onMessage((msg) => this.handleMessage(msg));
    log.info("pipeline started", { botUserId: this.botUserId });
  }

  /** 停止管道：清除队列计时器 */
  stop(): void {
    this.queue.stop();
    log.info("pipeline stopped");
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
        log.warn("failed to close session during shutdown", { chatId, error: String(err) });
      }
    }
    this.chatSessions.clear();
  }

  /** 是否有正在处理的 chat */
  hasBusyChats(): boolean {
    return this.queue.hasBusyChats();
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

    log.info("recovering active sessions", { count: uniqueRows.length });

    for (const row of uniqueRows) {
      const chatType = (row.type ?? "p2p") as "p2p" | "group";

      // 重建上下文注入
      const userRow = row.user_id
        ? this.db.prepare("SELECT name FROM users WHERE id = ?").get(row.user_id) as { name: string | null } | undefined
        : undefined;
      const context = row.user_id
        ? buildSessionContext(this.db, row.user_id, row.chat_id, chatType, userRow?.name ?? undefined)
        : "";
      const systemPrompt = context || undefined;

      try {
        const agentSession = await this.agent.createSession({
          workingDirectory: this.workingDirectory,
          systemPrompt,
          userId: row.user_id ?? undefined,
          chatId: row.chat_id,
          chatType,
          dbPath: this.dbPath,
        });

        this.chatSessions.set(row.chat_id, {
          agentSession,
          sessionKey: row.id,
          platformChatId: row.platform_id,
          userId: row.user_id ?? "",
        });
        this.platformChatIds.set(row.chat_id, row.platform_id);
        if (row.user_id) this.chatUserIds.set(row.chat_id, row.user_id);

        log.info("session recovered", { chatId: row.chat_id, sessionKey: row.id });
      } catch (err) {
        log.error("failed to recover session", {
          chatId: row.chat_id,
          sessionKey: row.id,
          error: String(err),
        });
      }
    }
  }

  private handleMessage(msg: NormalizedMessage): void {
    // 消息去重（飞书 WebSocket 可能重复推送）
    if (msg.platformMsgId && this.processedMsgIds.has(msg.platformMsgId)) {
      log.debug("duplicate message, skipping", { platformMsgId: msg.platformMsgId });
      return;
    }
    if (msg.platformMsgId) {
      this.processedMsgIds.add(msg.platformMsgId);
      // 超过上限时清空旧数据（简单策略，飞书重复推送间隔很短，不会跨越万条消息）
      if (this.processedMsgIds.size > Pipeline.MAX_PROCESSED_IDS) {
        this.processedMsgIds.clear();
      }
    }

    const userId = ensureUser(this.db, PLATFORM, msg.senderPlatformId, msg.senderName);
    const chatId = ensureChat(this.db, PLATFORM, msg.chatPlatformId, msg.chatType);

    const sessionKey = this.chatSessions.get(chatId)?.sessionKey;
    storeMessage(this.db, {
      chatId,
      senderId: userId,
      sessionKey,
      role: "user",
      contentText: msg.contentText,
      contentType: msg.contentType,
      platform: PLATFORM,
      platformMsgId: msg.platformMsgId,
      platformRaw: JSON.stringify(msg.raw),
    });

    log.info("message received", { chatId, userId, textLength: msg.contentText.length });

    if (msg.platformMsgId) {
      this.im.addReaction(msg.chatPlatformId, msg.platformMsgId, PROCESSING_EMOJI).catch(() => {});
    }

    // 缓存映射（每次都更新，防止 cancel 后丢失）
    this.platformChatIds.set(chatId, msg.chatPlatformId);
    this.chatUserIds.set(chatId, userId);

    this.queue.push({
      chatId,
      text: msg.contentText,
      timestamp: Date.now(),
    });
  }

  private async process(chatId: string, mergedText: string): Promise<void> {
    const platformChatId = this.chatSessions.get(chatId)?.platformChatId
      ?? this.platformChatIds.get(chatId);

    try {
      const chatSession = await this.getOrCreateSession(chatId);

      log.info("sending to agent", {
        chatId,
        sessionKey: chatSession.sessionKey,
        textLength: mergedText.length,
      });

      const response = await this.agent.sendMessage(chatSession.agentSession, mergedText);

      // 被 cancel 的 prompt 不存储不发送（cancelled 后会有新的合并消息进来）
      if (response.cancelled) {
        log.info("prompt was cancelled, skipping response", { chatId });
        return;
      }

      // 存储 agent 回复
      const replyMsgId = storeMessage(this.db, {
        chatId,
        senderId: this.botUserId!,
        sessionKey: chatSession.sessionKey,
        role: "assistant",
        contentText: response.text,
        platform: PLATFORM,
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

      // 发送到 IM（独立 try/catch，不影响已存储的数据）
      try {
        await this.im.sendText(chatSession.platformChatId, response.text);
      } catch (sendErr) {
        log.error("failed to send response to IM", {
          chatId,
          error: String(sendErr),
          responseLength: response.text.length,
        });
      }

      log.info("response sent", {
        chatId,
        responseLength: response.text.length,
        filesChanged: response.filesChanged,
      });
    } catch (err) {
      log.error("pipeline error", { chatId, error: String(err) });

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

    // 构建 session 上下文（user_memory + chat_summary）
    const userRow = userId
      ? this.db.prepare("SELECT name FROM users WHERE id = ?").get(userId) as { name: string | null } | undefined
      : undefined;
    const context = userId ? buildSessionContext(this.db, userId, chatId, chatType, userRow?.name ?? undefined) : "";
    const systemPrompt = context || undefined;

    const agentSession = await this.agent.createSession({
      workingDirectory: this.workingDirectory,
      systemPrompt,
      userId: userId ?? undefined,
      chatId,
      chatType,
      dbPath: this.dbPath,
    });

    const sessionKey = `s_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    try {
      // 认领无主消息（session 创建前已存入的消息）并获取 start_msg_id
      const orphan = this.db.prepare(
        "SELECT MIN(id) as startId FROM messages WHERE chat_id = ? AND session_key IS NULL",
      ).get(chatId) as { startId: number | null } | undefined;
      const startMsgId = orphan?.startId ?? null;

      this.db.prepare(`
        INSERT INTO sessions (id, chat_id, user_id, status, start_msg_id, started_at, last_active_at)
        VALUES (?, ?, ?, 'active', ?, datetime('now'), datetime('now'))
      `).run(sessionKey, chatId, userId ?? null, startMsgId);

      // 回填无主消息的 session_key
      this.db.prepare(
        "UPDATE messages SET session_key = ? WHERE chat_id = ? AND session_key IS NULL",
      ).run(sessionKey, chatId);
    } catch (dbErr) {
      // DB 插入失败，清理已创建的 ACP session 防泄漏
      await this.agent.closeSession(agentSession).catch(() => {});
      throw dbErr;
    }

    const chatSession: ChatSession = {
      agentSession,
      sessionKey,
      platformChatId,
      userId: userId ?? "",
    };
    this.chatSessions.set(chatId, chatSession);

    log.info("session created", { chatId, sessionKey, userId, agentSessionId: agentSession.id });
    return chatSession;
  }

  /** cancel 当前 prompt，但保持 session 存活（供 cancel+merge 复用） */
  private async cancelChat(chatId: string): Promise<void> {
    const session = this.chatSessions.get(chatId);
    if (!session) return;

    await this.agent.cancelSession(session.agentSession);
    // 不 close session，不从 chatSessions 删除
    // session 保持存活，后续消息复用同一个 agent session
  }
}
