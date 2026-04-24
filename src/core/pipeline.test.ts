import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentBackend, AgentResponse, AgentSession, SessionConfig } from "../agent/types.js";
import { initDatabase } from "../database/schema.js";
import type { NormalizedMessage, PlatformAdapter } from "../im/types.js";
import { Pipeline, type BotIdentity } from "./pipeline.js";

class RecordingAgent implements AgentBackend {
  supportsSystemPrompt = true;
  readonly createSessionCalls: SessionConfig[] = [];
  readonly sendMessageCalls: string[] = [];
  readonly closeSessionCalls: string[] = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async createSession(config: SessionConfig): Promise<AgentSession> {
    this.createSessionCalls.push(config);
    return { id: `agent_${this.createSessionCalls.length}` };
  }

  async sendMessage(_session: AgentSession, message: string): Promise<AgentResponse> {
    this.sendMessageCalls.push(message);
    return { text: "" };
  }

  async cancelSession(): Promise<void> {}
  async closeSession(session: AgentSession): Promise<void> {
    this.closeSessionCalls.push(session.id);
  }
}

function createImStub(): PlatformAdapter {
  return {
    onMessage() {},
    async start() {},
    async stop() {},
    async sendText() { return "pmid"; },
    async sendReply() { return "pmid"; },
    async sendMarkdownCard() { return "pmid"; },
    async sendCard() { return "pmid"; },
    async replyCard() { return "pmid"; },
    async editMessage() {},
    async addReaction() {},
    async removeReaction() {},
    async sendFile() { return "pmid"; },
    async getBotOpenId() { return "bot-open-id"; },
    async getBotName() { return "NiuBot"; },
    async getChatName() { return "Admin"; },
    async getMessageContent() { return undefined; },
    async getAppCreatorId() { return undefined; },
  };
}

function createRecordingImStub() {
  const sentTexts: string[] = [];
  const sentCards: Array<{ header: string; content: string; footer?: string }> = [];
  const reactions: Array<{ chatId: string; msgId: string; emoji: string }> = [];
  const removedReactions: Array<{ chatId: string; msgId: string; emoji: string }> = [];

  const im: PlatformAdapter = {
    onMessage() {},
    async start() {},
    async stop() {},
    async sendText(_chatId, text) { sentTexts.push(text); return "pmid"; },
    async sendReply(_chatId, text) { sentTexts.push(text); return "pmid"; },
    async sendMarkdownCard() { return "pmid"; },
    async sendCard(_chatId, header, content, footer) {
      sentCards.push({ header, content, footer });
      return "pmid";
    },
    async replyCard(_msgId, header, content, footer) {
      sentCards.push({ header, content, footer });
      return "pmid";
    },
    async editMessage() {},
    async addReaction(chatId, msgId, emoji) { reactions.push({ chatId, msgId, emoji }); },
    async removeReaction(chatId, msgId, emoji) { removedReactions.push({ chatId, msgId, emoji }); },
    async sendFile() { return "pmid"; },
    async getBotOpenId() { return "bot-open-id"; },
    async getBotName() { return "NiuBot"; },
    async getChatName() { return "Admin"; },
    async getMessageContent() { return undefined; },
    async getAppCreatorId() { return undefined; },
  };

  return { im, sentTexts, sentCards, reactions, removedReactions };
}

function createImStubWithSendFailures(options: {
  cardError: Error;
  rawTextError?: Error;
}) {
  const sentTexts: string[] = [];
  const sentReplies: Array<{ chatId: string; text: string; replyToMsgId: string }> = [];
  const sentCards: Array<{ header: string; content: string; footer?: string }> = [];
  let sendTextCalls = 0;
  let sendReplyCalls = 0;

  const im: PlatformAdapter = {
    onMessage() {},
    async start() {},
    async stop() {},
    async sendText(_chatId, text) {
      sendTextCalls++;
      if (sendTextCalls === 1 && options.rawTextError) {
        throw options.rawTextError;
      }
      sentTexts.push(text);
      return "pmid";
    },
    async sendReply(chatId, text, replyToMsgId) {
      sendReplyCalls++;
      if (sendReplyCalls === 1 && options.rawTextError) {
        throw options.rawTextError;
      }
      sentReplies.push({ chatId, text, replyToMsgId });
      return "pmid";
    },
    async sendMarkdownCard() { return "pmid"; },
    async sendCard(_chatId, header, content, footer) {
      sentCards.push({ header, content, footer });
      throw options.cardError;
    },
    async replyCard(_msgId, header, content, footer) {
      sentCards.push({ header, content, footer });
      throw options.cardError;
    },
    async editMessage() {},
    async addReaction() {},
    async removeReaction() {},
    async sendFile() { return "pmid"; },
    async getBotOpenId() { return "bot-open-id"; },
    async getBotName() { return "NiuBot"; },
    async getChatName() { return "Admin"; },
    async getMessageContent() { return undefined; },
    async getAppCreatorId() { return undefined; },
  };

  return { im, sentTexts, sentReplies, sentCards };
}

class DeferredAgent extends RecordingAgent {
  private readonly pendingResolvers: Array<() => void> = [];

  override async sendMessage(_session: AgentSession, message: string): Promise<AgentResponse> {
    this.sendMessageCalls.push(message);
    await new Promise<void>((resolve) => {
      this.pendingResolvers.push(resolve);
    });
    return { text: `reply:${message}` };
  }

  resolveNext(): void {
    const resolve = this.pendingResolvers.shift();
    if (!resolve) throw new Error("no pending sendMessage to resolve");
    resolve();
  }
}

class ErrorAgent extends RecordingAgent {
  constructor(private readonly error: Error & { stdout?: string }) {
    super();
  }

  override async sendMessage(_session: AgentSession, message: string): Promise<AgentResponse> {
    this.sendMessageCalls.push(message);
    throw this.error;
  }
}

function createBotIdentity(): BotIdentity {
  return {
    name: "NiuBot",
    platform: "feishu",
    platformBotId: "bot-open-id",
  };
}

function createMessage(overrides: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    senderPlatformId: "user-open-id",
    senderName: "admin",
    chatPlatformId: "chat-open-id",
    chatType: "p2p",
    contentText: "hello",
    contentType: "text",
    timestamp: new Date(),
    raw: {},
    ...overrides,
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Pipeline.recover", () => {
  test("does not recover active sessions when the stored backend is missing", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    db.prepare(`
      INSERT INTO users (id, name, platform, platform_id)
      VALUES ('u2', 'admin', 'feishu', 'user-open-id')
    `).run();
    db.prepare(`
      INSERT INTO chats (id, type, platform, platform_id, user_id)
      VALUES ('c1', 'p2p', 'feishu', 'chat-open-id', 'user-open-id')
    `).run();
    db.prepare(`
      INSERT INTO sessions (id, chat_id, user_id, status, agent_session_id, backend_type, last_active_at)
      VALUES ('s1', 'c1', 'u2', 'active', 'legacy-session-id', NULL, datetime('now'))
    `).run();

    const agent = new RecordingAgent();
    const pipeline = new Pipeline(
      db,
      createImStub(),
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "claude",
    );

    await pipeline.recover();

    const row = db.prepare(
      "SELECT status, agent_session_id, backend_type FROM sessions WHERE id = 's1'",
    ).get() as { status: string; agent_session_id: string | null; backend_type: string | null };

    expect(agent.createSessionCalls).toHaveLength(0);
    expect(row).toEqual({
      status: "archived",
      agent_session_id: null,
      backend_type: null,
    });
  });

  test("does not recover active sessions from a different backend", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    db.prepare(`
      INSERT INTO users (id, name, platform, platform_id)
      VALUES ('u2', 'admin', 'feishu', 'user-open-id')
    `).run();
    db.prepare(`
      INSERT INTO chats (id, type, platform, platform_id, user_id)
      VALUES ('c1', 'p2p', 'feishu', 'chat-open-id', 'user-open-id')
    `).run();
    db.prepare(`
      INSERT INTO sessions (id, chat_id, user_id, status, agent_session_id, backend_type, last_active_at)
      VALUES ('s1', 'c1', 'u2', 'active', 'codex-thread-id', 'codex', datetime('now'))
    `).run();

    const agent = new RecordingAgent();
    const pipeline = new Pipeline(
      db,
      createImStub(),
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "claude",
    );

    await pipeline.recover();

    const row = db.prepare(
      "SELECT status, agent_session_id, backend_type FROM sessions WHERE id = 's1'",
    ).get() as { status: string; agent_session_id: string | null; backend_type: string | null };

    expect(agent.createSessionCalls).toHaveLength(0);
    expect(row).toEqual({
      status: "archived",
      agent_session_id: null,
      backend_type: "codex",
    });
  });

  test("reuses agent session ids when the stored backend matches", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    db.prepare(`
      INSERT INTO users (id, name, platform, platform_id)
      VALUES ('u2', 'admin', 'feishu', 'user-open-id')
    `).run();
    db.prepare(`
      INSERT INTO chats (id, type, platform, platform_id, user_id)
      VALUES ('c1', 'p2p', 'feishu', 'chat-open-id', 'user-open-id')
    `).run();
    db.prepare(`
      INSERT INTO sessions (id, chat_id, user_id, status, agent_session_id, backend_type, last_active_at)
      VALUES ('s1', 'c1', 'u2', 'active', 'claude-session-id', 'claude', datetime('now'))
    `).run();

    const agent = new RecordingAgent();
    const pipeline = new Pipeline(
      db,
      createImStub(),
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "claude",
    );

    await pipeline.recover();

    expect(agent.createSessionCalls).toHaveLength(1);
    expect(agent.createSessionCalls[0]?.agentSessionId).toBe("claude-session-id");
  });

  test("handles single-slash status as a local builtin command", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const agent = new RecordingAgent();
    const { im, sentCards } = createRecordingImStub();
    const pipeline = new Pipeline(
      db,
      im,
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );

    const handled = (pipeline as any).handleBuiltinCommand("/status", "u2", "c1", "chat-open-id");

    expect(handled).toBe(true);
    expect(sentCards).toHaveLength(1);
    expect(sentCards[0]?.header).toBe("Status");
  });

  test("leaves double-slash status for agent passthrough", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const agent = new RecordingAgent();
    const { im, sentTexts } = createRecordingImStub();
    const pipeline = new Pipeline(
      db,
      im,
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );

    const handled = (pipeline as any).handleBuiltinCommand("//status", "u2", "c1", "chat-open-id");

    expect(handled).toBe(false);
    expect(sentTexts).toHaveLength(0);
  });

  test("normalizes double-slash commands before forwarding to agent", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const pipeline = new Pipeline(
      db,
      createImStub(),
      new RecordingAgent(),
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );

    expect((pipeline as any).normalizeUserTextForAgent("//status")).toBe("/status");
    expect((pipeline as any).normalizeUserTextForAgent("hello")).toBe("hello");
  });

  test("updates the active chat session model without starting a new session", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const agent = new RecordingAgent();
    const { im, sentCards } = createRecordingImStub();
    const identity = createBotIdentity();
    const pipeline = new Pipeline(
      db,
      im,
      agent,
      identity,
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );
    const activeAgentSession = { id: "agent_1", model: "old-model", liteModel: "old-lite" };
    (pipeline as any).chatSessions.set("c1", {
      agentSession: activeAgentSession,
      sessionId: "s1",
      platformChatId: "chat-open-id",
      userId: "u2",
      hasReplied: false,
    });

    (pipeline as any).handleModelCommand(["new-model"], "c1", "chat-open-id");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(identity.model).toBe("new-model");
    expect(activeAgentSession.model).toBe("new-model");
    expect(activeAgentSession.liteModel).toBe("old-lite");
    expect((pipeline as any).chatSessions.has("c1")).toBe(true);
    expect(agent.closeSessionCalls).toHaveLength(0);
    expect(sentCards[0]?.content).toContain("主模型已切换为 **new-model**");
    expect(sentCards[0]?.content).not.toContain("下次会话生效");
  });

  test("updates the active chat session lite model without starting a new session", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const agent = new RecordingAgent();
    const identity = createBotIdentity();
    const pipeline = new Pipeline(
      db,
      createImStub(),
      agent,
      identity,
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );
    const activeAgentSession = { id: "agent_1", model: "old-model", liteModel: "old-lite" };
    (pipeline as any).chatSessions.set("c1", {
      agentSession: activeAgentSession,
      sessionId: "s1",
      platformChatId: "chat-open-id",
      userId: "u2",
      hasReplied: false,
    });

    (pipeline as any).handleModelCommand(["lite", "new-lite"], "c1", "chat-open-id");

    expect(identity.liteModel).toBe("new-lite");
    expect(activeAgentSession.model).toBe("old-model");
    expect(activeAgentSession.liteModel).toBe("new-lite");
    expect((pipeline as any).chatSessions.has("c1")).toBe(true);
    expect(agent.closeSessionCalls).toHaveLength(0);
  });

  test("archives the current session on /new", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    db.prepare(`
      INSERT INTO sessions (id, chat_id, user_id, status, turn_count, backend_type, last_active_at)
      VALUES ('s1', 'c1', 'u2', 'active', 0, 'codex', datetime('now'))
    `).run();

    const agent = new RecordingAgent();
    const { im, sentTexts } = createRecordingImStub();
    const pipeline = new Pipeline(
      db,
      im,
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );
    (pipeline as any).chatSessions.set("c1", {
      agentSession: { id: "agent_1" },
      sessionId: "s1",
      platformChatId: "chat-open-id",
      userId: "u2",
      hasReplied: false,
    });

    const handled = (pipeline as any).handleBuiltinCommand("/new", "u2", "c1", "chat-open-id");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const row = db.prepare("SELECT status FROM sessions WHERE id = 's1'").get() as { status: string };

    expect(handled).toBe(true);
    expect(row.status).toBe("archived");
    expect(agent.closeSessionCalls).toEqual(["agent_1"]);
    expect(sentTexts).toContain("已开始新会话，当前上下文已清空。");
    expect((pipeline as any).chatSessions.has("c1")).toBe(false);
  });

  test("defers later messages until /new reset finishes", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    db.prepare(`
      INSERT INTO sessions (id, chat_id, user_id, status, turn_count, backend_type, last_active_at)
      VALUES ('s1', 'c1', 'u2', 'active', 0, 'codex', datetime('now'))
    `).run();

    const agent = new RecordingAgent();
    const { im, sentTexts, reactions } = createRecordingImStub();
    const pipeline = new Pipeline(
      db,
      im,
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );
    await pipeline.start();
    (pipeline as any).chatSessions.set("c1", {
      agentSession: { id: "agent_1" },
      sessionId: "s1",
      platformChatId: "chat-open-id",
      userId: "u2",
      hasReplied: false,
    });

    let releaseArchive!: () => void;
    const archiveDeferred = new Promise<boolean>((resolve) => {
      releaseArchive = () => resolve(true);
    });
    (pipeline as any).archiveSession = () => archiveDeferred;

    (pipeline as any).handleMessage(createMessage({
      contentText: "/new",
      platformMsgId: "m1",
    }));
    (pipeline as any).handleMessage(createMessage({
      contentText: "hi",
      platformMsgId: "m2",
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agent.sendMessageCalls).toHaveLength(0);
    expect(sentTexts).toHaveLength(0);
    expect(reactions).toContainEqual({ chatId: "chat-open-id", msgId: "m2", emoji: "Pin" });

    releaseArchive();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentTexts).toContain("已开始新会话，当前上下文已清空。");
    expect(agent.sendMessageCalls).toHaveLength(1);
    expect(agent.sendMessageCalls[0]).toContain("hi");
  });

  test("adds pin for pending messages and get for non-pending ones on receipt", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const agent = new DeferredAgent();
    const { im, reactions, removedReactions } = createRecordingImStub();
    const pipeline = new Pipeline(
      db,
      im,
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );
    await pipeline.start();

    (pipeline as any).handleMessage(createMessage({
      contentText: "first",
      platformMsgId: "m1",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reactions).toContainEqual({ chatId: "chat-open-id", msgId: "m1", emoji: "Get" });
    expect(reactions).not.toContainEqual({ chatId: "chat-open-id", msgId: "m1", emoji: "Pin" });

    (pipeline as any).handleMessage(createMessage({
      contentText: "second",
      platformMsgId: "m2",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reactions).toContainEqual({ chatId: "chat-open-id", msgId: "m2", emoji: "Pin" });
    expect(reactions).not.toContainEqual({ chatId: "chat-open-id", msgId: "m2", emoji: "Get" });

    agent.resolveNext();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(removedReactions).not.toContainEqual({ chatId: "chat-open-id", msgId: "m1", emoji: "Get" });
    expect(removedReactions).not.toContainEqual({ chatId: "chat-open-id", msgId: "m2", emoji: "Pin" });
    expect(reactions).toContainEqual({ chatId: "chat-open-id", msgId: "m2", emoji: "Get" });

    agent.resolveNext();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(removedReactions).not.toContainEqual({ chatId: "chat-open-id", msgId: "m2", emoji: "Get" });
  });

  test("replies safely on /clear when queue is empty", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const { im, sentTexts } = createRecordingImStub();
    const pipeline = new Pipeline(
      db,
      im,
      new RecordingAgent(),
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );

    const handled = (pipeline as any).handleBuiltinCommand("/clear", "u2", "c1", "chat-open-id");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handled).toBe(true);
    expect(sentTexts).toContain("队列是空的，没啥可清的。");
  });

  test("/clear does not archive session, only drains queue", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    db.prepare(`
      INSERT INTO sessions (id, chat_id, user_id, status, turn_count, backend_type, last_active_at)
      VALUES ('s1', 'c1', 'u2', 'active', 0, 'codex', datetime('now'))
    `).run();

    const { im, sentTexts } = createRecordingImStub();
    const pipeline = new Pipeline(
      db,
      im,
      new RecordingAgent(),
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );

    const handled = (pipeline as any).handleBuiltinCommand("/clear", "u2", "c1", "chat-open-id");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const row = db.prepare("SELECT status FROM sessions WHERE id = 's1'").get() as { status: string };

    expect(handled).toBe(true);
    expect(row.status).toBe("active");
    expect(sentTexts).toContain("队列是空的，没啥可清的。");
  });

  test("replies with accurate /flush copy when interrupting current work", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const agent = new DeferredAgent();
    const { im, sentTexts } = createRecordingImStub();
    const pipeline = new Pipeline(
      db,
      im,
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );
    await pipeline.start();

    (pipeline as any).handleMessage(createMessage({
      contentText: "first",
      platformMsgId: "m1",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    (pipeline as any).handleMessage(createMessage({
      contentText: "second",
      platformMsgId: "m2",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const handled = (pipeline as any).handleBuiltinCommand("/flush", "u2", "c1", "chat-open-id");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handled).toBe(true);
    expect(sentTexts).toContain("中断当前回复，合并处理队列中的 1 条消息。");
  });

  test("shows accurate /flush help copy", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const { im, sentCards } = createRecordingImStub();
    const pipeline = new Pipeline(
      db,
      im,
      new RecordingAgent(),
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );

    (pipeline as any).sendHelpCard("c1", "chat-open-id", undefined, true);

    expect(sentCards.some((card) => card.content.includes("`/flush`　　中断当前回复，合并处理排队消息"))).toBe(true);
  });

  test("surfaces structured agent errors to the user", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const { im, sentTexts } = createRecordingImStub();
    const err = new Error("Command failed");
    err.stdout = [
      JSON.stringify({
        type: "result",
        is_error: true,
        result: "API Error: 500 internal server error (request_id=req_123)",
      }),
      "",
    ].join("\n");

    const pipeline = new Pipeline(
      db,
      im,
      new ErrorAgent(err),
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "claude",
    );
    await pipeline.start();

    (pipeline as any).handleMessage(createMessage({
      contentText: "hello",
      platformMsgId: "m1",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentTexts).toContain(
      "处理出错了：API Error: 500 internal server error (request_id=req_123)\nCommand failed",
    );
  });

  test("surfaces plain-text CLI errors from stderr to the user", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const { im, sentTexts } = createRecordingImStub();
    const err = new Error("Command failed: codex exec resume thread_123");
    err.stderr = "Error: conversation not found for session thread_123";

    const pipeline = new Pipeline(
      db,
      im,
      new ErrorAgent(err),
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );
    await pipeline.start();

    (pipeline as any).handleMessage(createMessage({
      contentText: "hello",
      platformMsgId: "m1",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentTexts).toContain(
      "处理出错了：Error: conversation not found for session thread_123\nCommand failed: codex exec resume thread_123",
    );
  });

  test("falls back to the latest raw error line when stderr is JSON text", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const { im, sentTexts } = createRecordingImStub();
    const err = new Error("Command failed: codex exec resume thread_123");
    err.stderr = [
      "warning: retrying request",
      "{\"type\":\"error\",\"message\":\"session expired\"}",
    ].join("\n");

    const pipeline = new Pipeline(
      db,
      im,
      new ErrorAgent(err),
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );
    await pipeline.start();

    (pipeline as any).handleMessage(createMessage({
      contentText: "hello",
      platformMsgId: "m1",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentTexts).toContain(
      "处理出错了：warning: retrying request\nsession expired\nCommand failed: codex exec resume thread_123",
    );
  });

  test("surfaces platform send errors to the user before degrading", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const platformErr = new Error("Request failed with status code 400") as Error & {
      response?: { data?: { code?: number; msg?: string } };
    };
    platformErr.response = {
      data: {
        code: 230028,
        msg: "The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS",
      },
    };
    const { im, sentReplies, sentTexts } = createImStubWithSendFailures({ cardError: platformErr });

    const pipeline = new Pipeline(
      db,
      im,
      new RecordingAgent(),
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );
    await pipeline.start();

    (pipeline as any).handleMessage(createMessage({
      contentText: "why no reply",
      platformMsgId: "m1",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentTexts).toHaveLength(0);
    expect(sentReplies).toContainEqual({
      chatId: "chat-open-id",
      text: "发送失败：The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS (code: 230028)",
      replyToMsgId: "m1",
    });
    const row = db.prepare(`
      SELECT content_text, platform_msg_id
      FROM messages
      WHERE role = 'assistant'
      ORDER BY id DESC
      LIMIT 1
    `).get() as { content_text: string; platform_msg_id: string | null };
    expect(row).toEqual({
      content_text: "发送失败：The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS (code: 230028)",
      platform_msg_id: "pmid",
    });
    const ftsRow = db.prepare(`
      SELECT rowid
      FROM messages_fts
      WHERE messages_fts MATCH ?
      LIMIT 1
    `).get("230028") as { rowid: number } | undefined;
    expect(ftsRow).toBeTruthy();
  });

  test("degrades platform send errors when raw platform error cannot be delivered", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const platformErr = new Error("Request failed with status code 400") as Error & {
      response?: { data?: { code?: number; msg?: string } };
    };
    platformErr.response = {
      data: {
        code: 230028,
        msg: "The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS",
      },
    };
    const rawTextErr = new Error("raw platform error blocked");
    const { im, sentReplies, sentTexts } = createImStubWithSendFailures({
      cardError: platformErr,
      rawTextError: rawTextErr,
    });

    const pipeline = new Pipeline(
      db,
      im,
      new RecordingAgent(),
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );
    await pipeline.start();

    (pipeline as any).handleMessage(createMessage({
      contentText: "still no reply",
      platformMsgId: "m1",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentTexts).toHaveLength(0);
    expect(sentReplies).toContainEqual({
      chatId: "chat-open-id",
      text: "上一条回复未送达：平台发送失败（code: 230028）。",
      replyToMsgId: "m1",
    });
    const row = db.prepare(`
      SELECT content_text, platform_msg_id
      FROM messages
      WHERE role = 'assistant'
      ORDER BY id DESC
      LIMIT 1
    `).get() as { content_text: string; platform_msg_id: string | null };
    expect(row).toEqual({
      content_text: "上一条回复未送达：平台发送失败（code: 230028）。",
      platform_msg_id: "pmid",
    });
    const ftsRow = db.prepare(`
      SELECT rowid
      FROM messages_fts
      WHERE messages_fts MATCH ?
      LIMIT 1
    `).get("230028") as { rowid: number } | undefined;
    expect(ftsRow).toBeTruthy();
  });
});
