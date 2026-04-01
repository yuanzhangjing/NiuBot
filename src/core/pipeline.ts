import type Database from "better-sqlite3";
import type { PlatformAdapter, NormalizedMessage } from "../im/types.js";
import type { AgentBackend, AgentSession } from "../agent/types.js";
import { MessageQueue } from "./queue.js";
import { ensureUser, ensureChat, storeMessage } from "../database/schema.js";
import { buildSessionContext } from "../memory/inject.js";
import { loadPersona } from "../persona.js";
import { ARCHIVE_SUMMARY_PROMPT } from "./prompts.js";
import { decideRoute, type RouteDecision } from "./routing.js";
import { createLogger } from "../logger.js";

const PROCESSING_EMOJI = "Get";

/** Bot 身份信息，由外部传入 */
export interface BotIdentity {
  /** Bot 名称（如 "NiuBot"） */
  name: string;
  /** IM 平台标识（如 "feishu"） */
  platform: string;
  /** Bot 在平台上的唯一标识（用于 DB 中的 bot 用户记录） */
  platformBotId: string;
  /** 人格文件路径 */
  personaPath: string;
  /** 轻量模型 ID（可选，覆盖 backend 默认值） */
  liteModel?: string;
}

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

  /** agent 工作目录 */
  private workingDirectory: string;

  /** 数据库路径（传递给 agent 子进程） */
  private dbPath: string;

  /** 已处理的消息 ID 去重集合（有上限防内存泄漏） */
  private processedMsgIds = new Set<string>();
  private static readonly MAX_PROCESSED_IDS = 10000;

  /** 正在归档的 chatId 集合，期间 cancel 不发送到 agent（保护摘要 prompt） */
  private archivingChats = new Set<string>();

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
  start(): void {
    this.botUserId = ensureUser(
      this.db,
      this.botIdentity.platform,
      this.botIdentity.platformBotId,
      this.botIdentity.name,
    );
    this.im.onMessage((msg) => this.handleMessage(msg));
    this.log.info("pipeline started", { botUserId: this.botUserId });
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

      // 重建上下文注入（含 persona）
      const persona = loadPersona(this.botIdentity.personaPath);
      const userRow = row.user_id
        ? this.db.prepare("SELECT name FROM users WHERE id = ?").get(row.user_id) as { name: string | null } | undefined
        : undefined;
      const context = row.user_id
        ? buildSessionContext(this.db, row.user_id, row.chat_id, chatType, userRow?.name ?? undefined, undefined, persona)
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
          botId: this.botIdentity.platformBotId,
          botName: this.botIdentity.name,
          liteModel: this.botIdentity.liteModel,
        });

        this.chatSessions.set(row.chat_id, {
          agentSession,
          sessionKey: row.id,
          platformChatId: row.platform_id,
          userId: row.user_id ?? "",
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
      // 超过上限时清空旧数据（简单策略，飞书重复推送间隔很短，不会跨越万条消息）
      if (this.processedMsgIds.size > Pipeline.MAX_PROCESSED_IDS) {
        this.processedMsgIds.clear();
      }
    }

    const userId = ensureUser(this.db, platform, msg.senderPlatformId, msg.senderName);
    const chatId = ensureChat(this.db, platform, msg.chatPlatformId, msg.chatType);

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
      platformRaw: JSON.stringify(msg.raw),
    });

    this.log.info("message received", { chatId, userId, textLength: msg.contentText.length });

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
      // M3: 路由决策 — 判断是否需要切换 session
      await this.maybeRouteSession(chatId, mergedText);

      const chatSession = await this.getOrCreateSession(chatId);

      this.log.info("sending to agent", {
        chatId,
        sessionKey: chatSession.sessionKey,
        textLength: mergedText.length,
      });

      const response = await this.agent.sendMessage(chatSession.agentSession, mergedText);

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

      // 拼接 debug meta 信息（NIUBOT_DEBUG_META=1 时启用）
      let sendText = response.text;
      if (process.env["NIUBOT_DEBUG_META"] === "1") {
        const stats = this.db.prepare(
          "SELECT turn_count FROM sessions WHERE id = ?",
        ).get(chatSession.sessionKey) as { turn_count: number } | undefined;

        // 取 session key 末尾 8 位作为短 ID
        const shortId = chatSession.sessionKey.slice(-8);
        sendText += `\n\n---\n${shortId} #${stats?.turn_count ?? "?"}`;
      }

      // 发送到 IM（独立 try/catch，不影响已存储的数据）
      try {
        await this.im.sendText(chatSession.platformChatId, sendText);
      } catch (sendErr) {
        this.log.error("failed to send response to IM", {
          chatId,
          error: String(sendErr),
          responseLength: sendText.length,
        });
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

    // 读取 persona（每次 session 创建时重新读取，支持热更新）
    const persona = loadPersona(this.botIdentity.personaPath);

    // 构建 session 上下文（persona + user_memory + chat_summary + 今日归档 + recall）
    const userRow = userId
      ? this.db.prepare("SELECT name FROM users WHERE id = ?").get(userId) as { name: string | null } | undefined
      : undefined;
    const context = userId ? buildSessionContext(this.db, userId, chatId, chatType, userRow?.name ?? undefined, recallSessionId, persona) : "";
    const systemPrompt = context || undefined;

    const agentSession = await this.agent.createSession({
      workingDirectory: this.workingDirectory,
      systemPrompt,
      userId: userId ?? undefined,
      chatId,
      chatType,
      dbPath: this.dbPath,
      botId: this.botIdentity.platformBotId,
      botName: this.botIdentity.name,
      liteModel: this.botIdentity.liteModel,
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

    this.log.info("session created", { chatId, sessionKey, userId, agentSessionId: agentSession.id });
    return chatSession;
  }

  /** 路由决策结果暂存：chatId → RouteDecision（在 process 中传递给 getOrCreateSession） */
  private pendingRouteDecisions = new Map<string, RouteDecision>();

  /** 路由判断的最小轮次门槛：低于此值直接续，不调 LLM */
  private static readonly ROUTE_MIN_TURNS = 10;

  /**
   * M3: 路由决策 — 如果当前 chat 有 active session 且间隔超过阈值，调 LLM 判断。
   * 如果判断为 new/recall，先归档旧 session，让后续 getOrCreateSession 创建新的。
   */
  private async maybeRouteSession(chatId: string, newMessage: string): Promise<void> {
    const existing = this.chatSessions.get(chatId);
    if (!existing) return; // 没有 active session，直接走新建

    // 查 session 状态
    const sessionRow = this.db.prepare(
      "SELECT last_active_at, turn_count FROM sessions WHERE id = ?",
    ).get(existing.sessionKey) as { last_active_at: string | null; turn_count: number } | undefined;

    if (!sessionRow?.last_active_at) return;

    // 上下文很轻（不满 10 轮），直接续，省一次 LLM 调用
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

    // new 或 recall：归档旧 session，暂存决策供 getOrCreateSession 使用
    this.log.info("route decision: switching session", {
      chatId,
      action: decision.action,
      reason: decision.reason,
      recallSessionId: decision.recallSessionId,
    });

    await this.archiveSession(chatId);

    // 归档后，将新到达的消息（end_msg_id 之后的）从旧 session 移出，
    // 标记为 orphan，让 getOrCreateSession 的新 session 认领
    this.db.prepare(`
      UPDATE messages SET session_key = NULL
      WHERE chat_id = ? AND session_key = ?
        AND id > COALESCE((SELECT end_msg_id FROM sessions WHERE id = ?), 0)
    `).run(chatId, existing.sessionKey, existing.sessionKey);

    this.pendingRouteDecisions.set(chatId, decision);
  }

  /** 归档阈值：低于此 turn 数的 session 跳过摘要生成 */
  private static readonly ARCHIVE_SUMMARY_MIN_TURNS = 5;

  /** M3: 归档当前 session — 生成摘要并关闭 */
  private async archiveSession(chatId: string): Promise<void> {
    const session = this.chatSessions.get(chatId);
    if (!session) return;

    const { agentSession, sessionKey } = session;

    // 检查 turn_count — 短 session 跳过摘要生成
    const sessionRow = this.db.prepare(
      "SELECT turn_count FROM sessions WHERE id = ?",
    ).get(sessionKey) as { turn_count: number } | undefined;

    const turnCount = sessionRow?.turn_count ?? 0;

    if (turnCount >= Pipeline.ARCHIVE_SUMMARY_MIN_TURNS) {
      // 保护摘要 prompt 不被 cancelChat 误杀
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
        // 摘要生成失败不影响归档流程
      } finally {
        this.archivingChats.delete(chatId);
      }
    } else {
      this.log.info("skipping archive summary for short session", { chatId, sessionKey, turnCount });
    }

    // 更新 session 状态为 archived
    this.db.prepare(`
      UPDATE sessions SET status = 'archived', ended_at = datetime('now'), last_active_at = datetime('now')
      WHERE id = ?
    `).run(sessionKey);

    // 先从内存中移除，再关闭 backend session（确保 closeSession 失败时不留死引用）
    this.chatSessions.delete(chatId);
    await this.agent.closeSession(agentSession).catch((err) => {
      this.log.warn("failed to close backend session during archive", { chatId, sessionKey, error: String(err) });
    });

    this.log.info("session archived", { chatId, sessionKey, turnCount });
  }

  /** cancel 当前 prompt，但保持 session 存活（供 cancel+merge 复用） */
  private async cancelChat(chatId: string): Promise<void> {
    const session = this.chatSessions.get(chatId);
    if (!session) return;

    // 归档期间不 cancel，保护摘要 prompt 完成
    if (this.archivingChats.has(chatId)) {
      this.log.debug("cancel suppressed during archive", { chatId });
      return;
    }

    await this.agent.cancelSession(session.agentSession);
    // 不 close session，不从 chatSessions 删除
    // session 保持存活，后续消息复用同一个 agent session
  }
}
