import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentBackend, AgentResponse, AgentSession, SessionConfig } from "../agent/types.js";
import { Pipeline } from "../core/pipeline.js";
import { initDatabase } from "../database/schema.js";
import type { MessageHandler, PlatformAdapter } from "../im/types.js";
import { PersistentTransport } from "./persistent-transport.js";
import type { NormalizedMessage } from "./types.js";

const tempDirs: string[] = [];
const databases: Database.Database[] = [];

class TestAgent implements AgentBackend {
  readonly messages: string[] = [];
  response: Promise<AgentResponse> | undefined;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async createSession(_config: SessionConfig): Promise<AgentSession> { return { id: "agent-1" }; }
  async sendMessage(_session: AgentSession, message: string): Promise<AgentResponse> {
    this.messages.push(message);
    return this.response ?? { text: "reply" };
  }
  async cancelSession(): Promise<void> {}
  async closeSession(): Promise<void> {}
  needsStableUserPrefix(): boolean { return false; }
  needsCompactRecoveryReminder(): boolean { return true; }
  async validateModel(): Promise<{ valid: boolean }> { return { valid: true }; }
}

function createAdapter() {
  let handler: MessageHandler | undefined;
  const sent: string[] = [];
  const adapter: PlatformAdapter = {
    onMessage(value) { handler = value; },
    async start() {},
    async stop() {},
    async sendText(_chatId, text) { sent.push(text); return `text-${sent.length}`; },
    async sendReply(_chatId, text) { sent.push(text); return `reply-${sent.length}`; },
    async sendMarkdownCard(_chatId, text) { sent.push(text); return `markdown-${sent.length}`; },
    async sendCard(_chatId, _header, content) { sent.push(content); return `card-${sent.length}`; },
    async editMessage() {},
    async addReaction() {},
    async removeReaction() {},
    async sendFile() { return "file-1"; },
    async getBotOpenId() { return "bot-open-id"; },
    async getBotName() { return "NiuBot"; },
    async getChatName() { return "Chat"; },
    async getMessageContent() { return undefined; },
    async getAppCreatorId() { return undefined; },
  };
  return {
    adapter,
    sent,
    emit: async (message: NormalizedMessage) => {
      if (!handler) throw new Error("message handler not registered");
      await handler(message);
    },
  };
}

function message(platformMsgId: string, contentText: string): NormalizedMessage {
  return {
    senderPlatformId: "user-open-id",
    senderName: "User",
    chatPlatformId: "chat-open-id",
    chatType: "p2p",
    contentText,
    contentType: "text",
    timestamp: new Date(),
    platformTs: Date.now(),
    platformMsgId,
    raw: { id: platformMsgId },
  };
}

function createSystem(
  agent = new TestAgent(),
  bufferMs = 0,
  transportOptions: { inboundRetryDelaysMs?: number[] } = {},
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-transport-pipeline-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "niubot.db");
  const db = initDatabase(dbPath);
  databases.push(db);
  const platform = createAdapter();
  const transport = new PersistentTransport({
    db,
    botId: "NiuBot",
    platform: "feishu",
    adapter: platform.adapter,
    storageDir: dir,
    inboundRetryDelaysMs: transportOptions.inboundRetryDelaysMs,
  });
  const pipeline = new Pipeline(
    db,
    transport,
    agent,
    { name: "NiuBot", platform: "feishu", platformBotId: "bot-open-id" },
    dir,
    dbPath,
    bufferMs,
    "codex",
  );
  transport.onInbound((delivery) => pipeline.handleInbound(delivery));
  return { db, agent, platform, transport, pipeline };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) {
    if (db.open) db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("PersistentTransport and Pipeline", () => {
  test("runs one Engine turn for one persisted platform message", async () => {
    const system = createSystem();
    await system.pipeline.start();

    await system.platform.emit(message("msg-1", "hello"));
    await vi.waitFor(() => expect(system.agent.messages).toHaveLength(1));
    await vi.waitFor(() => expect(system.transport.getStatusCounts().inbox.completed).toBe(1));

    await system.platform.emit(message("msg-1", "duplicate"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(system.agent.messages).toHaveLength(1);
    expect(system.transport.getStatusCounts()).toMatchObject({
      inbox: { completed: 1 },
      outbox: { sent: 1 },
    });
    system.pipeline.stop();
  });

  test("marks explicitly cleared queued work discarded so restart cannot revive it", async () => {
    let finishFirst!: (response: AgentResponse) => void;
    const agent = new TestAgent();
    agent.response = new Promise<AgentResponse>((resolve) => { finishFirst = resolve; });
    const system = createSystem(agent);
    await system.pipeline.start();

    await system.platform.emit(message("msg-1", "first"));
    await vi.waitFor(() => expect(agent.messages).toHaveLength(1));
    await system.platform.emit(message("msg-2", "second"));
    await system.platform.emit(message("msg-clear", "/clear"));

    const secondStatus = system.db.prepare(
      "SELECT status FROM transport_inbox WHERE platform_msg_id = 'msg-2'",
    ).get() as { status: string };
    expect(secondStatus.status).toBe("discarded");

    finishFirst({ text: "reply" });
    await vi.waitFor(() => expect(system.transport.getStatusCounts().inbox.completed).toBeGreaterThanOrEqual(2));
    expect(agent.messages).toHaveLength(1);
    system.pipeline.stop();
  });

  test("recovers queued Engine work without duplicating its chat-history row", async () => {
    const first = createSystem(new TestAgent(), 60_000);
    await first.pipeline.start();

    await first.platform.emit(message("msg-recover", "recover me"));
    expect(first.transport.getStatusCounts().inbox.queued).toBe(1);
    expect(first.agent.messages).toHaveLength(0);
    first.pipeline.stop();

    const secondAgent = new TestAgent();
    const secondPlatform = createAdapter();
    const secondTransport = new PersistentTransport({
      db: first.db,
      botId: "NiuBot",
      platform: "feishu",
      adapter: secondPlatform.adapter,
      storageDir: path.dirname(first.db.name),
    });
    const secondPipeline = new Pipeline(
      first.db,
      secondTransport,
      secondAgent,
      { name: "NiuBot", platform: "feishu", platformBotId: "bot-open-id" },
      path.dirname(first.db.name),
      first.db.name,
      0,
      "codex",
    );
    secondTransport.onInbound((delivery) => secondPipeline.handleInbound(delivery));
    await secondPipeline.start();
    await secondTransport.recover();

    await vi.waitFor(() => expect(secondAgent.messages).toHaveLength(1));
    await vi.waitFor(() => expect(secondTransport.getStatusCounts().inbox.completed).toBe(1));
    const userMessages = first.db.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE role = 'user' AND platform_msg_id = 'msg-recover'",
    ).get() as { count: number };
    expect(userMessages.count).toBe(1);
    secondPipeline.stop();
  });

  test("rolls back the chat-history row when inbox queue association fails", async () => {
    const system = createSystem(new TestAgent(), 0, { inboundRetryDelaysMs: [0, 0] });
    await system.pipeline.start();
    vi.spyOn(system.transport, "markInboundQueued").mockImplementation(() => {
      throw new Error("injected queue association failure");
    });

    await system.platform.emit(message("msg-atomic", "must stay atomic"));
    await vi.waitFor(() => expect(system.transport.getStatusCounts().inbox.failed).toBe(1));

    const stored = system.db.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE platform_msg_id = 'msg-atomic'",
    ).get() as { count: number };
    expect(stored.count).toBe(0);
    expect(system.agent.messages).toHaveLength(0);
    system.pipeline.stop();
  });

  test("retries a deferred message when processing after a session transition fails", async () => {
    const system = createSystem(new TestAgent(), 60_000, { inboundRetryDelaysMs: [0, 0] });
    await system.pipeline.start();

    let finishTransition!: () => void;
    const transition = new Promise<void>((resolve) => { finishTransition = resolve; });
    (system.pipeline as any).startGlobalSessionTransition("chat-open-id", async () => transition);

    const queuedTransition = system.platform.emit(message("msg-transition", "after transition"));
    await vi.waitFor(() => expect(system.transport.getStatusCounts().inbox.dispatching).toBe(1));

    vi.spyOn(system.transport, "markInboundQueued")
      .mockImplementationOnce(() => { throw new Error("injected deferred association failure"); });
    finishTransition();
    await queuedTransition;

    await vi.waitFor(() => expect(system.transport.getStatusCounts().inbox.queued).toBe(1));
    const stored = system.db.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE platform_msg_id = 'msg-transition'",
    ).get() as { count: number };
    expect(stored.count).toBe(1);
    expect(system.agent.messages).toHaveLength(0);
    system.pipeline.stop();
  });

  test("retries persisted queued work when the in-memory queue rejects it", async () => {
    const system = createSystem(new TestAgent(), 60_000, { inboundRetryDelaysMs: [0, 0] });
    await system.pipeline.start();
    vi.spyOn((system.pipeline as any).queue, "push")
      .mockImplementationOnce(() => { throw new Error("injected in-memory queue failure"); });

    await system.platform.emit(message("msg-queue", "retry queue"));

    await vi.waitFor(() => expect(system.transport.getStatusCounts().inbox.queued).toBe(1));
    const stored = system.db.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE platform_msg_id = 'msg-queue'",
    ).get() as { count: number };
    expect(stored.count).toBe(1);
    expect(system.agent.messages).toHaveLength(0);
    system.pipeline.stop();
  });

  test("does not re-run a command after its non-repeatable boundary was persisted", async () => {
    const system = createSystem();
    await system.pipeline.start();
    vi.spyOn(system.pipeline as any, "handleBuiltinCommand").mockImplementation(() => {
      throw new Error("injected crash after command boundary");
    });

    await system.platform.emit(message("msg-command", "/help"));

    expect(system.transport.getStatusCounts().inbox.processing).toBe(1);
    expect(system.transport.getStatusCounts().outbox.pending).toBe(0);
    await system.transport.recover();
    expect(system.transport.getStatusCounts().inbox.interrupted).toBe(1);
    expect(system.transport.getStatusCounts().inbox.pending).toBe(0);
    system.pipeline.stop();
  });
});
