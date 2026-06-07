import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CliAgentBackend, type BaseCliSession, type ParsedOutput } from "../agent/cli-base.js";
import type { AgentBackend, AgentResponse, AgentSession, SessionConfig } from "../agent/types.js";
import {
  getBotBackendModelState,
  getBotRuntimeState,
  getRecentRuntimeEvents,
  initDatabase,
  recordRuntimeEvent,
  setBotBackendModelState,
} from "../database/schema.js";
import type { NormalizedMessage, PlatformAdapter } from "../im/types.js";
import { INSTALL_GUIDE_COMMAND } from "../install-guide.js";
import { COMPACT_RECOVERY_REMINDER } from "../memory/inject.js";
import { SYSTEM_RULES } from "../system-rules.js";
import { Pipeline, type BotIdentity } from "./pipeline.js";
import { ResponseSender } from "./response-sender.js";

class RecordingAgent implements AgentBackend {
  supportsSystemPrompt = true;
  readonly createSessionCalls: SessionConfig[] = [];
  readonly sendMessageCalls: string[] = [];
  readonly closeSessionCalls: string[] = [];
  readonly backendSessions = new Map<string, { model?: string; liteModel?: string }>();

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async createSession(config: SessionConfig): Promise<AgentSession> {
    this.createSessionCalls.push(config);
    const id = `agent_${this.createSessionCalls.length}`;
    this.backendSessions.set(id, {
      model: config.model,
      liteModel: config.liteModel,
    });
    return { id };
  }

  async sendMessage(_session: AgentSession, message: string): Promise<AgentResponse> {
    this.sendMessageCalls.push(message);
    return { text: "" };
  }

  async cancelSession(): Promise<void> {}
  async closeSession(session: AgentSession): Promise<void> {
    this.closeSessionCalls.push(session.id);
  }

  updateSessionModels(sessionId: string, models: { model?: string; liteModel?: string }): void {
    const current = this.backendSessions.get(sessionId) ?? {};
    this.backendSessions.set(sessionId, {
      model: "model" in models ? models.model : current.model,
      liteModel: "liteModel" in models ? models.liteModel : current.liteModel,
    });
  }
}

class ThrowingProbeAgent extends CliAgentBackend<BaseCliSession> {
  constructor() {
    super("throwing-probe");
  }

  override async start(): Promise<void> {}

  command(): string {
    return "throwing-probe";
  }

  buildSession(config: SessionConfig): BaseCliSession {
    return {
      workingDirectory: config.workingDirectory ?? process.cwd(),
      extraEnv: {},
      cumulativeBytes: 0,
      compactCount: 0,
      jsonlOffset: 0,
    };
  }

  buildInput(): { args: string[]; stdin?: string } {
    return { args: [] };
  }

  parseOutput(): ParsedOutput {
    return { text: "" };
  }

  protected probeSessionFileMtime(): number | null {
    throw new Error("probe failed");
  }

  markRunning(sessionId: string): void {
    (this as any).activityMap.set(sessionId, {
      status: "running",
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      completionDetected: false,
      compacting: false,
      recentLines: [],
      notifyCount: 0,
    });
  }
}

class ThrowingActivityAgent extends ThrowingProbeAgent {
  override getActivity(): undefined {
    throw new Error("activity failed");
  }
}

class WatchdogAgent extends ThrowingProbeAgent {
  protected override probeSessionFileMtime(): number | null {
    return null;
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
  let messageHandler: ((msg: NormalizedMessage) => void) | undefined;

  const im: PlatformAdapter = {
    onMessage(handler) { messageHandler = handler; },
    async start() {},
    async stop() {},
    async sendText(_chatId, text) { sentTexts.push(text); return "pmid"; },
    async sendReply(_chatId, text) { sentTexts.push(text); return "pmid"; },
    async sendMarkdownCard() { return "pmid"; },
    async sendCard(_chatId, header, content, footer) {
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

  const dispatchMessage = (msg: NormalizedMessage) => {
    if (!messageHandler) throw new Error("message handler not registered");
    messageHandler(msg);
  };

  return { im, sentTexts, sentCards, reactions, removedReactions, dispatchMessage };
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

class CompactCountingAgent extends RecordingAgent {
  private calls = 0;

  constructor(private readonly compactCounts: Array<number | undefined> = [1]) {
    super();
  }

  override async sendMessage(_session: AgentSession, message: string): Promise<AgentResponse> {
    this.sendMessageCalls.push(message);
    this.calls++;
    return {
      text: `reply ${this.calls}`,
      compactCount: this.compactCounts[this.calls - 1],
    };
  }
}

class ReplyAgent extends RecordingAgent {
  constructor(private readonly replyText = "agent reply") {
    super();
  }

  override async sendMessage(_session: AgentSession, message: string): Promise<AgentResponse> {
    this.sendMessageCalls.push(message);
    return { text: this.replyText };
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
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Pipeline.start", () => {
  test("registers message entrypoint without waiting for platform probes", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const im = createImStub();
    let messageHandlerRegistered = false;
    im.onMessage = () => {
      messageHandlerRegistered = true;
    };
    im.getBotOpenId = async () => new Promise<string | undefined>(() => {});
    im.getBotName = async () => new Promise<string | undefined>(() => {});
    im.getAppCreatorId = async () => new Promise<string | undefined>(() => {});
    const agent = new RecordingAgent();
    const pipeline = new Pipeline(
      db,
      im,
      agent,
      { name: "NiuBot", platform: "feishu", platformBotId: "bot" },
      dir,
      path.join(dir, "niubot.db"),
      10,
      "codex",
    );

    let resolved = false;
    void pipeline.start().then(() => { resolved = true; });

    await Promise.resolve();
    await Promise.resolve();

    expect(resolved).toBe(true);
    expect(messageHandlerRegistered).toBe(true);
    pipeline.stop();
  });

  test("continues startup when app creator detection hangs", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const im = createImStub();
    im.getAppCreatorId = async () => new Promise<string | undefined>(() => {});
    const agent = new RecordingAgent();
    const pipeline = new Pipeline(
      db,
      im,
      agent,
      { name: "NiuBot", platform: "feishu", platformBotId: "bot" },
      dir,
      path.join(dir, "niubot.db"),
      10,
      "codex",
    );

    let resolved = false;
    const started = pipeline.start().then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(6_000);
    await Promise.resolve();

    expect(resolved).toBe(true);
    pipeline.stop();
    await started;
  });
});

describe("Pipeline.recover", () => {
  test("idle watchdog does not throw when backend session mtime probing fails", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const agent = new ThrowingProbeAgent();
    const agentSession = await agent.createSession({ workingDirectory: dir });
    agent.markRunning(agentSession.id);
    const pipeline = new Pipeline(
      db,
      createImStub(),
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );
    (pipeline as any).chatSessions.set("c1", {
      agentSession,
      sessionId: "s1",
      platformChatId: "chat-open-id",
      userId: "u2",
      hasReplied: false,
    });

    expect(() => (pipeline as any).runIdleWatchdog()).not.toThrow();
  });

  test("idle watchdog tick catches unexpected synchronous failures", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const agent = new ThrowingActivityAgent();
    const agentSession = await agent.createSession({ workingDirectory: dir });
    const pipeline = new Pipeline(
      db,
      createImStub(),
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );
    (pipeline as any).chatSessions.set("c1", {
      agentSession,
      sessionId: "s1",
      platformChatId: "chat-open-id",
      userId: "u2",
      hasReplied: false,
    });

    expect(() => (pipeline as any).runIdleWatchdogSafely()).not.toThrow();
  });

  test("notifies softly when a main chat session keeps running for one hour", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const { im, sentCards } = createRecordingImStub();
    const agent = new WatchdogAgent();
    const agentSession = await agent.createSession({ workingDirectory: dir });
    agent.markRunning(agentSession.id);
    const activity = (agent as any).activityMap.get(agentSession.id);
    const now = Date.now();
    activity.startedAt = now - 61 * 60_000;
    activity.lastActiveAt = now - 60_000;
    activity.recentLines = ["still working"];

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
    (pipeline as any).platformChatIds.set("c1", "chat-open-id");
    (pipeline as any).chatSessions.set("c1", {
      agentSession,
      sessionId: "s1",
      platformChatId: "chat-open-id",
      userId: "u2",
      hasReplied: false,
    });

    (pipeline as any).runIdleWatchdog();

    expect(sentCards).toHaveLength(1);
    expect(sentCards[0].header).toBe("任务还在运行");
    expect(sentCards[0].content).toContain("任务已经运行约 1 小时，进程仍在运行。");
    expect(sentCards[0].content).toContain("输出状态：最近 1 分钟内有输出，按输出看任务还活跃。");
    expect(sentCards[0].content).toContain("不急的话可以继续等");
    expect(sentCards[0].content).toContain("可以发送 /stop");
    expect(sentCards[0].content).not.toContain("still working");
  });

  test("sends hourly main chat notices even after idle notices are exhausted", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const { im, sentCards } = createRecordingImStub();
    const agent = new WatchdogAgent();
    const agentSession = await agent.createSession({ workingDirectory: dir });
    agent.markRunning(agentSession.id);
    const activity = (agent as any).activityMap.get(agentSession.id);
    const now = Date.now();
    activity.startedAt = now - 61 * 60_000;
    activity.lastActiveAt = now - 45 * 60_000;
    activity.notifyCount = 2;
    activity.lastNotifiedAt = now - 31 * 60_000;

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
    (pipeline as any).platformChatIds.set("c1", "chat-open-id");
    (pipeline as any).chatSessions.set("c1", {
      agentSession,
      sessionId: "s1",
      platformChatId: "chat-open-id",
      userId: "u2",
      hasReplied: false,
    });

    (pipeline as any).runIdleWatchdog();

    expect(sentCards).toHaveLength(1);
    expect(sentCards[0].header).toBe("任务还在运行");
    expect(sentCards[0].content).toContain("任务已经运行约 1 小时，进程仍在运行。");
    expect(sentCards[0].content).toContain("输出状态：已经 45 分钟没有输出，按输出看任务不活跃，可能卡住。");
  });

  test("does not send a long-running notice before one hour for a main chat session", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const { im, sentCards } = createRecordingImStub();
    const agent = new WatchdogAgent();
    const agentSession = await agent.createSession({ workingDirectory: dir });
    agent.markRunning(agentSession.id);
    const activity = (agent as any).activityMap.get(agentSession.id);
    const now = Date.now();
    activity.startedAt = now - 31 * 60_000;
    activity.lastActiveAt = now - 20_000;

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
    (pipeline as any).platformChatIds.set("c1", "chat-open-id");
    (pipeline as any).chatSessions.set("c1", {
      agentSession,
      sessionId: "s1",
      platformChatId: "chat-open-id",
      userId: "u2",
      hasReplied: false,
    });

    (pipeline as any).runIdleWatchdog();

    expect(sentCards).toHaveLength(0);
  });

  test("notifies softly when an independent task keeps running for one hour", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const { im, sentCards } = createRecordingImStub();
    const agent = new WatchdogAgent();
    const agentSession = await agent.createSession({ workingDirectory: dir });
    agent.markRunning(agentSession.id);
    const activity = (agent as any).activityMap.get(agentSession.id);
    const now = Date.now();
    activity.lastActiveAt = now - 20_000;
    activity.recentLines = ["still working"];

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
    (pipeline as any).platformChatIds.set("c1", "chat-open-id");
    (pipeline as any).runningTasks.set(agentSession.id, {
      agentSession,
      chatId: "c1",
      description: "daily job",
      startedAt: now - 61 * 60_000,
    });

    (pipeline as any).runIdleWatchdog();

    expect(sentCards).toHaveLength(1);
    expect(sentCards[0].header).toBe("定时任务还在运行");
    expect(sentCards[0].content).toContain("「daily job」已经运行约 1 小时，进程仍在运行。");
    expect(sentCards[0].content).toContain("输出状态：最近 1 分钟内有输出，按输出看任务还活跃。");
    expect(sentCards[0].content).not.toContain("/stop");
    expect(sentCards[0].content).not.toContain("still working");
  });

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

  test("marks unfinished runtime runs failed by restart and keeps chat idle", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    recordRuntimeEvent(db, {
      botId: "NiuBot",
      chatId: "c1",
      runId: "run-before-restart",
      messageIds: [11],
      stage: "agent_running",
      event: "stage_changed",
    });
    const { im, sentCards } = createRecordingImStub();
    const pipeline = new Pipeline(
      db,
      im,
      new RecordingAgent(),
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "claude",
    );

    await pipeline.start();

    const latest = getRecentRuntimeEvents(db, { chatId: "c1", limit: 1 })[0];
    expect(latest).toMatchObject({
      runId: "run-before-restart",
      stage: "failed",
      event: "failed_by_restart",
    });
    expect((pipeline as any).runtimeState.getChatState("c1")).toMatchObject({
      state: "idle",
      activeRunId: null,
    });

    const handled = (pipeline as any).handleBuiltinCommand("/status", "u2", "c1", "chat-open-id", "p2p", "status-msg");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handled).toBe(true);
    expect(sentCards.some((card) =>
      card.content.includes("最近失败") && card.content.includes("failed_by_restart"),
    )).toBe(true);
  });

  test("injects session profile on first message after recovering a non-resumable active session", async () => {
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
      VALUES ('s1', 'c1', 'u2', 'active', NULL, 'claude', datetime('now'))
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

    await pipeline.start();
    await pipeline.recover();
    (pipeline as any).handleMessage(createMessage({
      contentText: "after recover",
      platformMsgId: "m-recover-context",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agent.sendMessageCalls).toHaveLength(1);
    expect(agent.sendMessageCalls[0]).toContain("<session-profile");
    expect(agent.sendMessageCalls[0]).toContain("after recover");
    expect(agent.sendMessageCalls[0]).not.toContain("<niubot-system-rules>");
  });

  test("handles single-slash service as a local builtin command", () => {
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

    const handled = (pipeline as any).handleBuiltinCommand("/service", "u2", "c1", "chat-open-id");

    expect(handled).toBe(true);
    expect(sentCards).toHaveLength(1);
    expect(sentCards[0]?.header).toBe("service");
  });

  test("leaves double-slash service for agent passthrough", () => {
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

    const handled = (pipeline as any).handleBuiltinCommand("//service", "u2", "c1", "chat-open-id");

    expect(handled).toBe(false);
    expect(sentTexts).toHaveLength(0);
  });

  test("/update reports a newer version without installing or restarting", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const agent = new RecordingAgent();
    const { im, sentTexts, sentCards } = createRecordingImStub();
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
    const updateCommands: string[] = [];
    (pipeline as any).runUpdateCommand = async (cmd: string) => {
      updateCommands.push(cmd);
      return { stdout: "9.9.9\n", stderr: "" };
    };
    let restarted = false;
    (pipeline as any).triggerRestart = () => { restarted = true; };

    await (pipeline as any).handleUpdate("c1", "chat-open-id", undefined, false);

    expect(updateCommands).toEqual(["npm view @yuanzhangjing/niubot@latest version"]);
    expect(restarted).toBe(false);
    expect(sentTexts).toHaveLength(0);
    expect(sentCards).toHaveLength(1);
    expect(sentCards[0]?.content).toContain("发现新版本");
    expect(sentCards[0]?.content).toContain("9.9.9");
    expect(sentCards[0]?.content).toContain("/update 1");
  });

  test("/update 1 confirms update command", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const agent = new RecordingAgent();
    const pipeline = new Pipeline(
      db,
      createImStub(),
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );
    const calls: boolean[] = [];
    (pipeline as any).adminRoles.set("u2", "owner");
    (pipeline as any).handleUpdate = (_chatId: string, _platformChatId: string, _msgId?: string, confirmed = false) => {
      calls.push(confirmed);
      return Promise.resolve();
    };

    const handled = (pipeline as any).handleBuiltinCommand("/update 1", "u2", "c1", "chat-open-id", "p2p", "m1");

    expect(handled).toBe(true);
    expect(calls).toEqual([true]);
  });

  test("/update confirm installs the newer version and restarts", async () => {
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
    const updateCommands: string[] = [];
    (pipeline as any).runUpdateCommand = async (cmd: string) => {
      updateCommands.push(cmd);
      if (cmd.startsWith("npm view ")) return { stdout: "9.9.9\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    let restarted = false;
    (pipeline as any).triggerRestart = () => { restarted = true; };

    await (pipeline as any).handleUpdate("c1", "chat-open-id", undefined, true);

    expect(updateCommands).toEqual([
      "npm view @yuanzhangjing/niubot@latest version",
      "npm install -g @yuanzhangjing/niubot@9.9.9",
    ]);
    expect(restarted).toBe(true);
    expect(sentTexts.at(-2)).toContain("正在安装");
    expect(sentTexts.at(-1)).toContain("正在重启");
  });

  test("notifies admins about the same newer version only once", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    db.prepare(`
      INSERT INTO users (id, name, platform, platform_id, is_admin)
      VALUES ('u2', 'admin', 'feishu', 'user-open-id', 'owner')
    `).run();
    db.prepare(`
      INSERT INTO chats (id, type, platform, platform_id, user_id)
      VALUES ('c1', 'p2p', 'feishu', 'chat-open-id', 'user-open-id')
    `).run();

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
    (pipeline as any).runUpdateCommand = async () => ({ stdout: "9.9.9\n", stderr: "" });
    await pipeline.start();

    await (pipeline as any).checkForUpdatesAndNotifyAdmins();
    await (pipeline as any).checkForUpdatesAndNotifyAdmins();

    expect(sentCards).toHaveLength(1);
    expect(sentCards[0]?.content).toContain("发现新版本");
    expect(sentCards[0]?.content).toContain("9.9.9");
    expect(sentCards[0]?.content).toContain("/update 1");
  });

  test("checks for updates immediately when startup is inside the daytime window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 25, 11, 0, 0));
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const agent = new RecordingAgent();
    const pipeline = new Pipeline(
      db,
      createImStub(),
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );
    let checks = 0;
    (pipeline as any).checkForUpdatesAndNotifyAdmins = async () => { checks++; };

    await pipeline.start();
    expect(checks).toBe(1);

    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000);
    expect(checks).toBe(2);

    pipeline.stop();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(checks).toBe(2);
  });

  test("defers update notifications to the next daytime check when startup is at night", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 25, 23, 0, 0));
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const agent = new RecordingAgent();
    const pipeline = new Pipeline(
      db,
      createImStub(),
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );
    let checks = 0;
    (pipeline as any).checkForUpdatesAndNotifyAdmins = async () => { checks++; };

    await pipeline.start();
    expect(checks).toBe(0);

    await vi.advanceTimersByTimeAsync(11 * 60 * 60 * 1000);
    expect(checks).toBe(1);

    pipeline.stop();
  });

  test("skips automatic update notifications when disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 25, 11, 0, 0));
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const agent = new RecordingAgent();
    const pipeline = new Pipeline(
      db,
      createImStub(),
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    );
    let checks = 0;
    (pipeline as any).checkForUpdatesAndNotifyAdmins = async () => { checks++; };

    await pipeline.start();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    expect(checks).toBe(0);
    pipeline.stop();
  });

  test("uses the standard empty-response fallback for cron jobs", async () => {
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
    await pipeline.start();

    await pipeline.processCronJob("c1", "u2", "check release status", "每日发版状态检查");

    expect(sentCards).toHaveLength(1);
    expect(sentCards[0]?.header).toBe("⏰ 每日发版状态检查");
    expect(sentCards[0]?.content).toBe("（处理完成，但未生成回复。如果没收到预期结果，请重试）");
  });

  test("sends cron job replies without output rewriting", async () => {
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

    const { im, sentCards } = createRecordingImStub();
    const pipeline = new Pipeline(
      db,
      im,
      new ReplyAgent("cron reply"),
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
      undefined,
      undefined,
      undefined,
      undefined,
    );
    await pipeline.start();

    await pipeline.processCronJob("c1", "u2", "check weather", "每日天气");

    expect(sentCards[0]?.content).toBe("cron reply");

    const row = db.prepare("SELECT content_text FROM messages WHERE role = 'assistant'").get() as { content_text: string };
    expect(row.content_text).toBe("cron reply");
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
    agent.backendSessions.set("agent_1", { model: "old-model", liteModel: "old-lite" });
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
    expect(agent.backendSessions.get("agent_1")).toEqual({
      model: "new-model",
      liteModel: "old-lite",
    });
    expect((pipeline as any).chatSessions.has("c1")).toBe(true);
    expect(agent.closeSessionCalls).toHaveLength(0);
    expect(sentCards[0]?.content).toContain("主模型已切换为 **new-model**");
    expect(sentCards[0]?.content).not.toContain("下次会话生效");
    expect(getBotRuntimeState(db, "NiuBot")).toEqual({
      backendType: "codex",
      model: "new-model",
      liteModel: undefined,
    });
  });

  test("orders model candidates deterministically when history timestamps tie", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    db.prepare(
      "INSERT INTO model_history (backend, model_name, last_used_at) VALUES (?, ?, ?)",
    ).run("codex", "history-old", "2026-04-25 10:00:00");
    db.prepare(
      "INSERT INTO model_history (backend, model_name, last_used_at) VALUES (?, ?, ?)",
    ).run("codex", "history-new", "2026-04-25 10:00:00");

    const identity = createBotIdentity();
    identity.model = "gpt-5.4";
    identity.liteModel = "gpt-5.4-mini";
    const pipeline = new Pipeline(
      db,
      createImStub(),
      new RecordingAgent(),
      identity,
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );

    expect((pipeline as any).buildModelCandidates()).toEqual([
      "gpt-5.4",
      "gpt-5.4-mini",
      "history-new",
      "history-old",
    ]);
  });

  test("records model history with sub-second timestamps", () => {
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

    (pipeline as any).recordModelHistory("codex", "gpt-5.5");

    const row = db.prepare(
      "SELECT last_used_at FROM model_history WHERE backend = ? AND model_name = ?",
    ).get("codex", "gpt-5.5") as { last_used_at: string };
    expect(row.last_used_at).toMatch(/\.\d{3}$/);
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
    agent.backendSessions.set("agent_1", { model: "old-model", liteModel: "old-lite" });
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
    expect(agent.backendSessions.get("agent_1")).toEqual({
      model: "old-model",
      liteModel: "new-lite",
    });
    expect((pipeline as any).chatSessions.has("c1")).toBe(true);
    expect(agent.closeSessionCalls).toHaveLength(0);
    expect(getBotRuntimeState(db, "NiuBot")).toEqual({
      backendType: "codex",
      model: undefined,
      liteModel: "new-lite",
    });
  });

  test("clears runtime models on /model reset while keeping backend", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const identity = createBotIdentity();
    identity.model = "runtime-model";
    identity.liteModel = "runtime-lite";
    const pipeline = new Pipeline(
      db,
      createImStub(),
      new RecordingAgent(),
      identity,
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );

    (pipeline as any).handleModelCommand(["reset"], "c1", "chat-open-id");

    expect(identity.model).toBeUndefined();
    expect(identity.liteModel).toBe("gpt-5.4-mini");
    expect(getBotRuntimeState(db, "NiuBot")).toEqual({
      backendType: "codex",
      model: undefined,
      liteModel: undefined,
    });
  });

  test("persists backend and restored models after /agent switch", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const identity = createBotIdentity();
    identity.model = "codex-model";
    identity.liteModel = "codex-lite";
    const { im, sentCards } = createRecordingImStub();
    const pipeline = new Pipeline(
      db,
      im,
      new RecordingAgent(),
      identity,
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
      async () => new RecordingAgent(),
      () => ["codex", "claude"],
    );

    (pipeline as any).backendModelCache.set("claude", {
      model: "claude-model",
      liteModel: "claude-lite",
    });

    (pipeline as any).handleAgentCommand(["claude"], "c1", "chat-open-id");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(identity.model).toBe("claude-model");
    expect(identity.liteModel).toBe("claude-lite");
    expect(getBotRuntimeState(db, "NiuBot")).toEqual({
      backendType: "claude",
      model: "claude-model",
      liteModel: "claude-lite",
    });
    expect(sentCards[0]?.content).toContain("重启后仍保持当前选择");
  });

  test("restores persisted backend-specific models on /agent switch after restart", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    setBotBackendModelState(db, "NiuBot", "claude", {
      model: "claude-opus-4-6",
      liteModel: "haiku",
    });

    const identity = createBotIdentity();
    identity.model = "gpt-5.4";
    const { im, sentCards } = createRecordingImStub();
    const pipeline = new Pipeline(
      db,
      im,
      new RecordingAgent(),
      identity,
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
      async () => new RecordingAgent(),
      () => ["codex", "claude"],
    );

    (pipeline as any).handleAgentCommand(["claude"], "c1", "chat-open-id");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(identity.model).toBe("claude-opus-4-6");
    expect(identity.liteModel).toBe("haiku");
    expect(getBotRuntimeState(db, "NiuBot")).toEqual({
      backendType: "claude",
      model: "claude-opus-4-6",
      liteModel: "haiku",
    });
    expect(getBotBackendModelState(db, "NiuBot", "claude")).toEqual({
      model: "claude-opus-4-6",
      liteModel: "haiku",
    });
    expect(sentCards[0]?.content).toContain("claude-opus-4-6");
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
    (pipeline as any).pendingCompactRecovery.add("c1");
    (pipeline as any).lastCompactCounts.set("c1", 1);

    const handled = (pipeline as any).handleBuiltinCommand("/new", "u2", "c1", "chat-open-id");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const row = db.prepare("SELECT status FROM sessions WHERE id = 's1'").get() as { status: string };

    expect(handled).toBe(true);
    expect(row.status).toBe("archived");
    expect(agent.closeSessionCalls).toEqual(["agent_1"]);
    expect(sentTexts).toContain("已开始新会话，当前上下文已清空。");
    expect((pipeline as any).chatSessions.has("c1")).toBe(false);
    expect((pipeline as any).pendingCompactRecovery.has("c1")).toBe(false);
    expect((pipeline as any).lastCompactCounts.has("c1")).toBe(false);
  });

  test("refreshes agent context files before creating a new chat session", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const events: string[] = [];
    class OrderedAgent extends RecordingAgent {
      override async createSession(config: SessionConfig): Promise<AgentSession> {
        events.push("create");
        return super.createSession(config);
      }
    }

    const agent = new OrderedAgent();
    const pipeline = new Pipeline(
      db,
      createImStub(),
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
      undefined,
      undefined,
      () => { events.push("refresh"); },
    );

    await pipeline.start();
    (pipeline as any).handleMessage(createMessage({
      contentText: "first",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    (pipeline as any).handleMessage(createMessage({
      contentText: "second",
      platformMsgId: "m2",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual(["refresh", "create"]);
    expect(agent.createSessionCalls).toHaveLength(1);
  });

  test("falls back to text and releases queue when card send times out", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const sentTexts: string[] = [];
    const sentCards: string[] = [];
    const im = createImStub();
    im.sendCard = async (_chatId, _header, content) => {
      sentCards.push(content);
      return new Promise<string>(() => {});
    };
    im.sendText = async (_chatId, text) => {
      sentTexts.push(text);
      return "text-msg";
    };
    const agent = new ReplyAgent();
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
    (pipeline as any).responseSender = new ResponseSender(im, { timeoutMs: 1 });

    await pipeline.start();
    (pipeline as any).handleMessage(createMessage({
      contentText: "first",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentCards).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(sentTexts).toContain("agent reply");
    (pipeline as any).handleMessage(createMessage({
      contentText: "second",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agent.sendMessageCalls).toHaveLength(2);
  });

  test("releases queue when all response send methods fail", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const im = createImStub();
    im.sendCard = async () => { throw new Error("card failed"); };
    im.sendText = async () => { throw new Error("text failed"); };
    im.sendFile = async () => { throw new Error("file failed"); };
    const agent = new ReplyAgent();
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

    expect(agent.sendMessageCalls).toHaveLength(2);
  });

  test("syncs runtime state from agent running to response sending to done", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    let resolveSendCard: ((value: string) => void) | undefined;
    const im = createImStub();
    im.sendCard = async () => new Promise<string>((resolve) => {
      resolveSendCard = resolve;
    });
    const pipeline = new Pipeline(
      db,
      im,
      new ReplyAgent(),
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    const store = (pipeline as any).runtimeState;
    const run = store.getRunsForChat("c1")[0];
    expect(run).toMatchObject({
      chatId: "c1",
      triggerMessageIds: [1],
      triggerPlatformMsgIds: ["m1"],
      replyToPlatformMsgId: "m1",
      mergedText: "first",
      stage: "sending_response",
    });
    expect(store.getChatState("c1").state).toBe("busy");

    resolveSendCard?.("pmid");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.getRunsForChat("c1")[0].stage).toBe("done");
    expect(store.getChatState("c1").state).toBe("idle");
    expect(store.getPipelineHealth().inflightRunIds).toEqual([]);
  });

  test("marks runtime run failed when agent throws and keeps queue behavior", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const { im, sentTexts } = createRecordingImStub();
    const pipeline = new Pipeline(
      db,
      im,
      new ErrorAgent(new Error("agent failed")),
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

    const store = (pipeline as any).runtimeState;
    const run = store.getRunsForChat("c1")[0];
    expect(run.stage).toBe("failed");
    expect(run.lastError).toContain("agent failed");
    expect(store.getChatState("c1")).toMatchObject({
      state: "idle",
      activeRunId: null,
    });
    expect(sentTexts.some((text) => text.includes("处理出错了"))).toBe(true);
  });

  test("syncs runtime state while preserving pending queue behavior", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const agent = new DeferredAgent();
    const pipeline = new Pipeline(
      db,
      createImStub(),
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

    const store = (pipeline as any).runtimeState;
    expect(store.getActiveRun("c1")).toMatchObject({ stage: "agent_running" });
    expect((pipeline as any).queue.pendingCount("c1")).toBe(1);

    agent.resolveNext();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    agent.resolveNext();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.getRunsForChat("c1").map((run: { stage: string }) => run.stage)).toEqual(["done", "done"]);
    expect((pipeline as any).queue.pendingCount("c1")).toBe(0);
  });

  test("persists runtime events for a successful run", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const pipeline = new Pipeline(
      db,
      createImStub(),
      new ReplyAgent("agent reply"),
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    const events = getRecentRuntimeEvents(db, { chatId: "c1", limit: 10 }).reverse();
    expect(events.map((event) => event.event)).toEqual([
      "started",
      "stage_changed",
      "stage_changed",
      "done",
    ]);
    expect(events[0]).toMatchObject({
      botId: "NiuBot",
      chatId: "c1",
      messageIds: [1],
      stage: "queued",
    });
    expect(events.at(-1)).toMatchObject({
      runId: events[0].runId,
      stage: "done",
    });
  });

  test("runtime event write failures do not affect message processing", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    db.prepare("DROP TABLE runtime_events").run();
    const { im, sentCards } = createRecordingImStub();
    const pipeline = new Pipeline(
      db,
      im,
      new ReplyAgent("agent reply"),
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    const store = (pipeline as any).runtimeState;
    expect(store.getRunsForChat("c1")[0].stage).toBe("done");
    expect(sentCards.some((card) => card.content.includes("agent reply"))).toBe(true);
  });

  test("sends codex final replies without output rewriting", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const { im, sentCards } = createRecordingImStub();
    const pipeline = new Pipeline(
      db,
      im,
      new ReplyAgent("agent reply"),
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
      undefined,
      undefined,
      undefined,
      undefined,
    );

    await pipeline.start();
    (pipeline as any).handleMessage(createMessage({
      contentText: "first",
      platformMsgId: "m1",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentCards.some((card) => card.content.includes("rewritten reply"))).toBe(false);
    expect(sentCards.some((card) => card.content.includes("agent reply"))).toBe(true);

    const row = db.prepare("SELECT content_text FROM messages WHERE role = 'assistant'").get() as { content_text: string };
    expect(row.content_text).toBe("agent reply");
  });

  test("syncs runtime state while messages are buffering", async () => {
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
      1000,
      "codex",
    );

    await pipeline.start();
    (pipeline as any).handleMessage(createMessage({
      contentText: "first",
      platformMsgId: "m1",
    }));

    const store = (pipeline as any).runtimeState;
    expect(store.getChatState("c1")).toMatchObject({
      state: "buffering",
      bufferMessageIds: [1],
      activeRunId: null,
    });
  });

  test("injects only stable context through system prompt when supported", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, "bot_profile.md"), "plain bot profile", "utf-8");

    const db = initDatabase(path.join(dir, "niubot.db"));
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
      undefined,
      undefined,
      undefined,
      {
        botProfilePath: path.join(dir, "bot_profile.md"),
      },
    );

    await pipeline.start();
    (pipeline as any).handleMessage(createMessage({
      contentText: "hello",
      platformMsgId: "m-system-1",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agent.createSessionCalls).toHaveLength(1);
    expect(agent.createSessionCalls[0]?.importantContext).toContain("<niubot-system-rules>");
    expect(agent.createSessionCalls[0]?.importantContext).toContain("<bot-identity>");
    expect(agent.createSessionCalls[0]?.importantContext).toContain("你就是当前 Bot：");
    expect(agent.createSessionCalls[0]?.importantContext).toContain("对用户来说，你是 NiuBot。");
    expect(agent.createSessionCalls[0]?.importantContext).toContain("plain bot profile");
    expect(agent.createSessionCalls[0]?.importantContext).not.toContain("<session-profile");
    expect(agent.createSessionCalls[0]?.importantContext).toContain("nbt system-rules");
    expect(agent.sendMessageCalls).toHaveLength(1);
    expect(agent.sendMessageCalls[0]).toContain("<session-profile");
    expect(agent.sendMessageCalls[0]).toContain("这是一个全新的对话 session");
    expect(agent.sendMessageCalls[0]).not.toContain("<niubot-system-rules>");
    expect(agent.sendMessageCalls[0]).not.toContain("plain bot profile");
  });

  test("falls back to first user prompt when system prompt is not supported", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, "bot_profile.md"), "fallback bot profile", "utf-8");

    const db = initDatabase(path.join(dir, "niubot.db"));
    const agent = new RecordingAgent();
    agent.supportsSystemPrompt = false;
    const pipeline = new Pipeline(
      db,
      createImStub(),
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
      undefined,
      undefined,
      undefined,
      {
        botProfilePath: path.join(dir, "bot_profile.md"),
      },
    );

    await pipeline.start();
    (pipeline as any).handleMessage(createMessage({
      contentText: "hello",
      platformMsgId: "m-system-2",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agent.createSessionCalls).toHaveLength(1);
    expect(agent.createSessionCalls[0]?.importantContext).toBeUndefined();
    expect(agent.sendMessageCalls).toHaveLength(1);
    expect(agent.sendMessageCalls[0]).toContain("<niubot-system-rules>");
    expect(agent.sendMessageCalls[0]).toContain("<bot-identity>");
    expect(agent.sendMessageCalls[0]).toContain("对用户来说，你是 NiuBot。");
    expect(agent.sendMessageCalls[0]).toContain("fallback bot profile");
    expect(agent.sendMessageCalls[0]).toContain("<session-profile");
    expect(agent.sendMessageCalls[0]).toContain("这是一个全新的对话 session");
    expect(agent.sendMessageCalls[0]).toContain("hello");
  });

  test("does not read workspace bot profile when stable context options are omitted", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, "bot_profile.md"), "workspace profile should be ignored", "utf-8");

    const db = initDatabase(path.join(dir, "niubot.db"));
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

    await pipeline.start();
    (pipeline as any).handleMessage(createMessage({
      contentText: "hello",
      platformMsgId: "m-system-default",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agent.createSessionCalls[0]?.importantContext).toContain("<niubot-system-rules>");
    expect(agent.createSessionCalls[0]?.importantContext).not.toContain("workspace profile should be ignored");
  });

  test("injects compact recovery reminder once after compact count increases", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const agent = new CompactCountingAgent([1, undefined, 2, undefined]);
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

    await pipeline.start();
    (pipeline as any).handleMessage(createMessage({
      contentText: "first",
      platformMsgId: "m-compact-1",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    (pipeline as any).handleMessage(createMessage({
      contentText: "second",
      platformMsgId: "m-compact-2",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    (pipeline as any).handleMessage(createMessage({
      contentText: "third",
      platformMsgId: "m-compact-3",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    (pipeline as any).handleMessage(createMessage({
      contentText: "fourth",
      platformMsgId: "m-compact-4",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agent.sendMessageCalls).toHaveLength(4);
    expect(agent.sendMessageCalls[0]).not.toContain(COMPACT_RECOVERY_REMINDER);
    expect(agent.sendMessageCalls[1]).toContain(COMPACT_RECOVERY_REMINDER);
    expect(agent.sendMessageCalls[1]).not.toContain("<niubot-system-rules>");
    expect(agent.sendMessageCalls[1]).toContain("<session-profile");
    expect(agent.sendMessageCalls[1]).toContain("second");
    expect(agent.sendMessageCalls[2]).not.toContain(COMPACT_RECOVERY_REMINDER);
    expect(agent.sendMessageCalls[3]).toContain(COMPACT_RECOVERY_REMINDER);
    expect(agent.sendMessageCalls[3]).not.toContain("<niubot-system-rules>");
    expect(agent.sendMessageCalls[3]).toContain("fourth");
    expect(SYSTEM_RULES).toContain("nbt system-rules");
  });

  test("compact recovery keeps active tasks but skips recent sessions and messages", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, "tasks"), { recursive: true });
    writeFileSync(path.join(dir, "tasks", "index.yaml"), yaml.stringify({
      tasks: [{
        name: "visible-task",
        description: "short task description",
        path: "tasks/visible-task",
        owner: "u2",
        visibility: "private",
        created_at: "2026-05-10",
      }],
    }), "utf-8");

    const db = initDatabase(path.join(dir, "niubot.db"));
    db.prepare(`
      INSERT INTO sessions (id, chat_id, user_id, source, status, summary, started_at, ended_at, start_msg_id, end_msg_id, last_active_at)
      VALUES ('archived1', 'c1', 'u2', 'user', 'archived', ?, datetime('now', '-1 hour'), datetime('now', '-30 minutes'), 1, 1, datetime('now', '-30 minutes'))
    `).run(JSON.stringify({ summary: "archived summary should not appear" }));
    db.prepare(`
      INSERT INTO messages (chat_id, sender_id, session_key, role, content_text, content_type, platform, platform_msg_id, platform_ts, platform_raw)
      VALUES ('c1', 'u2', 'archived1', 'user', 'recent message should not appear', 'text', 'feishu', 'old-msg', datetime('now', '-40 minutes'), '{}')
    `).run();

    const agent = new CompactCountingAgent([1, undefined]);
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

    await pipeline.start();
    (pipeline as any).handleMessage(createMessage({
      contentText: "first",
      platformMsgId: "m-compact-light-1",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    (pipeline as any).handleMessage(createMessage({
      contentText: "second",
      platformMsgId: "m-compact-light-2",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agent.sendMessageCalls[1]).toContain(COMPACT_RECOVERY_REMINDER);
    expect(agent.sendMessageCalls[1]).toContain("<active-tasks>");
    expect(agent.sendMessageCalls[1]).toContain("visible-task");
    expect(agent.sendMessageCalls[1]).not.toContain("<recent-sessions>");
    expect(agent.sendMessageCalls[1]).not.toContain("archived summary should not appear");
    expect(agent.sendMessageCalls[1]).not.toContain("<recent-messages>");
    expect(agent.sendMessageCalls[1]).not.toContain("recent message should not appear");
  });

  test("reasserts stable context after compact when system prompt is not supported", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, "bot_profile.md"), "no-system profile", "utf-8");

    const db = initDatabase(path.join(dir, "niubot.db"));
    const agent = new CompactCountingAgent([1, undefined]);
    agent.supportsSystemPrompt = false;
    const pipeline = new Pipeline(
      db,
      createImStub(),
      agent,
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
      undefined,
      undefined,
      undefined,
      {
        botProfilePath: path.join(dir, "bot_profile.md"),
      },
    );

    await pipeline.start();
    (pipeline as any).handleMessage(createMessage({
      contentText: "first",
      platformMsgId: "m-compact-nosystem-1",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    (pipeline as any).handleMessage(createMessage({
      contentText: "second",
      platformMsgId: "m-compact-nosystem-2",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agent.sendMessageCalls).toHaveLength(2);
    expect(agent.sendMessageCalls[1]).toContain(COMPACT_RECOVERY_REMINDER);
    expect(agent.sendMessageCalls[1]).toContain("<niubot-system-rules>");
    expect(agent.sendMessageCalls[1]).toContain("no-system profile");
    expect(agent.sendMessageCalls[1]).toContain("<session-profile");
    expect(agent.sendMessageCalls[1]).toContain("second");
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

  test("/status reads runtime state while response sending is active", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const sentCards: Array<{ header: string; content: string }> = [];
    let resolveAgentCard: ((value: string) => void) | undefined;
    const im = createImStub();
    im.sendCard = async (_chatId, header, content) => {
      if (content.includes("agent reply")) {
        return new Promise<string>((resolve) => {
          resolveAgentCard = resolve;
        });
      }
      sentCards.push({ header, content });
      return "status-msg";
    };
    const pipeline = new Pipeline(
      db,
      im,
      new ReplyAgent(),
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    (pipeline as any).handleMessage(createMessage({
      contentText: "second",
      platformMsgId: "m2",
    }));

    const handled = (pipeline as any).handleBuiltinCommand("/status", "u2", "c1", "chat-open-id", "p2p", "status-msg");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handled).toBe(true);
    expect(sentCards.some((card) => card.content.includes("sending_response"))).toBe(true);
    expect(sentCards.some((card) => card.content.includes("pending: 1"))).toBe(true);

    resolveAgentCard?.("pmid-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveAgentCard?.("pmid-2");
  });

  test("/status shows the latest failed runtime run", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const { im, sentCards } = createRecordingImStub();
    const pipeline = new Pipeline(
      db,
      im,
      new ErrorAgent(new Error("agent failed")),
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

    const handled = (pipeline as any).handleBuiltinCommand("/status", "u2", "c1", "chat-open-id", "p2p", "status-msg");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handled).toBe(true);
    expect(sentCards.some((card) => card.content.includes("最近失败") && card.content.includes("agent failed"))).toBe(true);
  });

  test("/stop marks the active runtime run stopped and clears pending messages", async () => {
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
    (pipeline as any).handleMessage(createMessage({ contentText: "first", platformMsgId: "m1" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    (pipeline as any).handleMessage(createMessage({ contentText: "second", platformMsgId: "m2" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const handled = (pipeline as any).handleBuiltinCommand("/stop", "u2", "c1", "chat-open-id", "p2p", "stop-msg");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const store = (pipeline as any).runtimeState;
    expect(handled).toBe(true);
    expect(store.getRunsForChat("c1")[0].stage).toBe("stopped");
    expect(store.getActiveRun("c1")).toBeNull();
    expect((pipeline as any).queue.pendingCount("c1")).toBe(0);
    expect(sentTexts).toContain("已停止当前任务，并清空 1 条排队消息。");
    expect(getRecentRuntimeEvents(db, { chatId: "c1", limit: 1 })[0]).toMatchObject({
      event: "stopped",
      stage: "stopped",
    });
  });

  test("/stop releases a runtime run stuck in response sending without waiting for IM send", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const { im, sentTexts } = createRecordingImStub();
    im.sendCard = async () => new Promise<string>(() => {});
    const pipeline = new Pipeline(
      db,
      im,
      new ReplyAgent(),
      createBotIdentity(),
      dir,
      path.join(dir, "niubot.db"),
      0,
      "codex",
    );

    await pipeline.start();
    (pipeline as any).responseSender = new ResponseSender(im, { timeoutMs: 30_000 });
    (pipeline as any).handleMessage(createMessage({ contentText: "first", platformMsgId: "m1" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const store = (pipeline as any).runtimeState;
    expect(store.getActiveRun("c1")).toMatchObject({ stage: "sending_response" });

    const handled = (pipeline as any).handleBuiltinCommand("/stop", "u2", "c1", "chat-open-id", "p2p", "stop-msg");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handled).toBe(true);
    expect(store.getRunsForChat("c1")[0].stage).toBe("stopped");
    expect(store.getActiveRun("c1")).toBeNull();
    expect(sentTexts).toContain("已停止当前任务。");
  });

  test("/flush stops the active runtime run and keeps pending messages for the next run", async () => {
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
    (pipeline as any).handleMessage(createMessage({ contentText: "first", platformMsgId: "m1" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    (pipeline as any).handleMessage(createMessage({ contentText: "second", platformMsgId: "m2" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const handled = (pipeline as any).handleBuiltinCommand("/flush", "u2", "c1", "chat-open-id", "p2p", "flush-msg");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const store = (pipeline as any).runtimeState;
    expect(handled).toBe(true);
    expect(store.getRunsForChat("c1")[0].stage).toBe("stopped");
    expect((pipeline as any).queue.pendingCount("c1")).toBe(1);
    expect(sentTexts).toContain("中断当前回复，合并处理队列中的 1 条消息。");

    agent.resolveNext();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getRunsForChat("c1")).toHaveLength(2);
    expect(store.getRunsForChat("c1")[1].stage).toBe("agent_running");

    agent.resolveNext();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getRunsForChat("c1").map((run: { stage: string }) => run.stage)).toEqual(["stopped", "done"]);
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

  test("points agents to the installation guide from /help", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-pipeline-test-"));
    tempDirs.push(dir);

    const db = initDatabase(path.join(dir, "niubot.db"));
    const { im, sentCards, dispatchMessage } = createRecordingImStub();
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
    dispatchMessage(createMessage({
      contentText: "/help",
      platformMsgId: "m1",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentCards.some((card) => card.content.includes(`安装配置：让 agent 执行 \`${INSTALL_GUIDE_COMMAND}\``))).toBe(true);
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
      "处理出错了：\n```\nAPI Error: 500 internal server error (request_id=req_123)\nCommand failed\n```",
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
      "处理出错了：\n```\nCommand failed: codex exec resume thread_123\n```",
    );
  });

  test("skips raw non-JSON lines and only shows structured errors", async () => {
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
      "处理出错了：\n```\nsession expired\nCommand failed: codex exec resume thread_123\n```",
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
