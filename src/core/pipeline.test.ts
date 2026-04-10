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
    const { im, sentCards } = createRecordingImStub();
    const pipeline = new Pipeline(
      db,
      im,
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      0,
      "codex",
    );

    const handled = (pipeline as any).handleBuiltinCommand("//status", "u2", "c1", "chat-open-id");

    expect(handled).toBe(false);
    expect(sentCards).toHaveLength(0);
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
      0,
      "codex",
    );

    expect((pipeline as any).normalizeUserTextForAgent("//status")).toBe("/status");
    expect((pipeline as any).normalizeUserTextForAgent("hello")).toBe("hello");
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

  test("replies safely on /clear when no active session exists", async () => {
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
      0,
      "codex",
    );

    const handled = (pipeline as any).handleBuiltinCommand("/clear", "u2", "c1", "chat-open-id");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handled).toBe(true);
    expect(sentTexts).toContain("当前没有进行中的会话；下一条消息会新建会话。");
  });

  test("archives db-only active session on /clear", async () => {
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
      0,
      "codex",
    );

    const handled = (pipeline as any).handleBuiltinCommand("/clear", "u2", "c1", "chat-open-id");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const row = db.prepare("SELECT status FROM sessions WHERE id = 's1'").get() as { status: string };

    expect(handled).toBe(true);
    expect(row.status).toBe("archived");
    expect(sentTexts).toContain("已开始新会话，当前上下文已清空。");
  });
});
