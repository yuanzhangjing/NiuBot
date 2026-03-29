import type Database from "better-sqlite3";
import type { PlatformAdapter, NormalizedMessage } from "../im/types.js";
import type { AgentBackend, AgentSession } from "../agent/types.js";
import { MessageQueue } from "./queue.js";
import { ensureUser, ensureChat, storeMessage } from "../database/schema.js";
import { createLogger } from "../logger.js";

const log = createLogger("pipeline");

const PLATFORM = "feishu";
const PROCESSING_EMOJI = "OnIt";

interface ChatSession {
  agentSession: AgentSession;
  sessionKey: string;
}

export class Pipeline {
  private db: Database.Database;
  private im: PlatformAdapter;
  private agent: AgentBackend;
  private queue: MessageQueue;

  /** 每个 chat 的当前 agent session（M1: 一个 chat 一个 session） */
  private chatSessions = new Map<string, ChatSession>();

  /** agent 工作目录 */
  private workingDirectory: string;

  constructor(
    db: Database.Database,
    im: PlatformAdapter,
    agent: AgentBackend,
    workingDirectory: string,
    bufferMs: number,
    cancelThresholdMs: number,
  ) {
    this.db = db;
    this.im = im;
    this.agent = agent;
    this.workingDirectory = workingDirectory;
    this.queue = new MessageQueue(bufferMs, cancelThresholdMs);

    this.queue.onProcess((chatId, mergedText) => this.process(chatId, mergedText));
    this.queue.onCancel((chatId) => this.cancelChat(chatId));
  }

  /** 启动管道：注册 IM 消息回调 */
  start(): void {
    this.im.onMessage((msg) => this.handleMessage(msg));
    log.info("pipeline started");
  }

  /** 进程恢复：标记所有 active session 为 aborted */
  recover(): void {
    const result = this.db.prepare(
      "UPDATE sessions SET status = 'aborted', ended_at = datetime('now') WHERE status = 'active'",
    ).run();

    if (result.changes > 0) {
      log.info("recovered: marked active sessions as aborted", { count: result.changes });
    }
  }

  private handleMessage(msg: NormalizedMessage): void {
    // 1. 确保用户和会话存在
    const userId = ensureUser(this.db, PLATFORM, msg.senderPlatformId);
    const chatId = ensureChat(this.db, PLATFORM, msg.chatPlatformId, "p2p");

    // 2. 存储用户消息
    const sessionKey = this.chatSessions.get(chatId)?.sessionKey;
    const msgId = storeMessage(this.db, {
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

    log.info("message received", {
      chatId,
      userId,
      msgId,
      textLength: msg.contentText.length,
    });

    // 3. 加 reaction 表示收到
    if (msg.platformMsgId) {
      void this.im.addReaction(msg.chatPlatformId, msg.platformMsgId, PROCESSING_EMOJI);
    }

    // 4. 推入队列（处理缓冲合并、排队）
    this.queue.push({
      chatId,
      text: msg.contentText,
      timestamp: Date.now(),
    });
  }

  private async process(chatId: string, mergedText: string): Promise<void> {
    try {
      // 获取或创建 agent session
      const chatSession = await this.getOrCreateSession(chatId);

      log.info("sending to agent", {
        chatId,
        sessionKey: chatSession.sessionKey,
        textLength: mergedText.length,
      });

      // 发送消息给 agent
      const response = await this.agent.sendMessage(chatSession.agentSession, mergedText);

      // 存储 agent 回复
      storeMessage(this.db, {
        chatId,
        senderId: "bot",
        sessionKey: chatSession.sessionKey,
        role: "assistant",
        contentText: response.text,
        platform: PLATFORM,
      });

      // 更新 session 统计
      this.db.prepare(`
        UPDATE sessions
        SET message_count = message_count + 2,
            turn_count = turn_count + 1,
            last_active_at = datetime('now')
        WHERE id = ?
      `).run(chatSession.sessionKey);

      // 发送到 IM
      const platformChatId = this.getPlatformChatId(chatId);
      if (platformChatId) {
        await this.im.sendText(platformChatId, response.text);
      }

      log.info("response sent", {
        chatId,
        responseLength: response.text.length,
        filesChanged: response.filesChanged,
      });
    } catch (err) {
      log.error("pipeline error", { chatId, error: String(err) });

      // 发送错误提示给用户
      const platformChatId = this.getPlatformChatId(chatId);
      if (platformChatId) {
        await this.im.sendText(
          platformChatId,
          `处理出错了，请稍后再试。\n\n错误信息: ${String(err)}`,
        ).catch(() => {});
      }
    }
  }

  private async getOrCreateSession(chatId: string): Promise<ChatSession> {
    const existing = this.chatSessions.get(chatId);
    if (existing) return existing;

    // M1: 简单的 system prompt
    const systemPrompt = "You are a helpful AI assistant. Respond concisely.";

    const agentSession = await this.agent.createSession({
      systemPrompt,
      workingDirectory: this.workingDirectory,
    });

    const sessionKey = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 写入数据库
    this.db.prepare(`
      INSERT INTO sessions (id, chat_id, status, started_at, last_active_at)
      VALUES (?, ?, 'active', datetime('now'), datetime('now'))
    `).run(sessionKey, chatId);

    const chatSession: ChatSession = { agentSession, sessionKey };
    this.chatSessions.set(chatId, chatSession);

    log.info("session created", { chatId, sessionKey, agentSessionId: agentSession.id });
    return chatSession;
  }

  private async cancelChat(chatId: string): Promise<void> {
    const session = this.chatSessions.get(chatId);
    if (!session) return;

    await this.agent.cancelSession(session.agentSession);

    // cancel 后需要创建新的 agent session（旧的不可复用）
    this.chatSessions.delete(chatId);
  }

  private getPlatformChatId(internalChatId: string): string | undefined {
    const row = this.db.prepare(
      "SELECT platform_id FROM chats WHERE id = ?",
    ).get(internalChatId) as { platform_id: string } | undefined;
    return row?.platform_id;
  }
}
