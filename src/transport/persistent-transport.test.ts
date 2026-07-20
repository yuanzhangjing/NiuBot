import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { initDatabase } from "../database/schema.js";
import type { MessageHandler, PlatformAdapter } from "../im/types.js";
import { DeliveryUncertainError } from "./errors.js";
import { PersistentTransport } from "./persistent-transport.js";
import { TransportStore } from "./store.js";
import type { NormalizedMessage } from "./types.js";

const tempDirs: string[] = [];
const databases: Database.Database[] = [];

function createMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    senderPlatformId: "user-1",
    senderName: "User",
    chatPlatformId: "chat-1",
    chatType: "p2p",
    contentText: "hello",
    contentType: "text",
    timestamp: new Date("2026-07-20T12:00:00Z"),
    platformTs: Date.parse("2026-07-20T12:00:00Z"),
    platformMsgId: "msg-1",
    raw: { event: "message" },
    ...overrides,
  };
}

function createAdapter(overrides: Partial<PlatformAdapter> = {}) {
  let handler: MessageHandler | undefined;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const adapter: PlatformAdapter = {
    onMessage(value) { handler = value; },
    async start() { calls.push({ method: "start", args: [] }); },
    async stop() { calls.push({ method: "stop", args: [] }); },
    async sendText(...args) { calls.push({ method: "sendText", args }); return "text-id"; },
    async sendReply(...args) { calls.push({ method: "sendReply", args }); return "reply-id"; },
    async sendMarkdownCard(...args) { calls.push({ method: "sendMarkdownCard", args }); return "markdown-id"; },
    async sendCard(...args) { calls.push({ method: "sendCard", args }); return "card-id"; },
    async editMessage(...args) { calls.push({ method: "editMessage", args }); },
    async addReaction(...args) { calls.push({ method: "addReaction", args }); },
    async removeReaction(...args) { calls.push({ method: "removeReaction", args }); },
    async sendFile(...args) { calls.push({ method: "sendFile", args }); return "file-id"; },
    async getBotOpenId() { return "bot-id"; },
    async getBotName() { return "NiuBot"; },
    async getChatName() { return "Chat"; },
    async getMessageContent() { return undefined; },
    async getAppCreatorId() { return "owner-id"; },
    ...overrides,
  };
  return {
    adapter,
    calls,
    emit: async (message: NormalizedMessage) => {
      if (!handler) throw new Error("message handler not registered");
      await handler(message);
    },
  };
}

function createRuntime(
  adapter: PlatformAdapter,
  options: {
    unknownFileRetentionMs?: number;
    deliveryTimeoutMs?: number;
    inboundRetryDelaysMs?: number[];
  } = {},
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-persistent-transport-"));
  tempDirs.push(dir);
  const db = initDatabase(path.join(dir, "niubot.db"));
  databases.push(db);
  const runtime = new PersistentTransport({
    db,
    botId: "NiuBot",
    platform: "feishu",
    adapter,
    storageDir: dir,
    unknownFileRetentionMs: options.unknownFileRetentionMs,
    deliveryTimeoutMs: options.deliveryTimeoutMs,
    inboundRetryDelaysMs: options.inboundRetryDelaysMs,
  });
  return { runtime, db, dir };
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.open) db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("PersistentTransport inbound", () => {
  test("stops an adapter whose slow start finishes after shutdown", async () => {
    let finishStart!: () => void;
    const delayedStart = new Promise<void>((resolve) => { finishStart = resolve; });
    const fake = createAdapter({ async start() { await delayedStart; } });
    const { runtime } = createRuntime(fake.adapter);

    const starting = runtime.start();
    await Promise.resolve();
    await runtime.stop();
    finishStart();
    await starting;

    expect(fake.calls.filter((call) => call.method === "stop")).toHaveLength(2);
  });

  test("persists before dispatch and skips duplicate platform delivery", async () => {
    const { adapter, emit } = createAdapter();
    const { runtime } = createRuntime(adapter);
    const deliveries: number[] = [];
    runtime.onInbound((delivery) => {
      deliveries.push(delivery.inboxId);
      runtime.markInboundTerminal(delivery.inboxId, delivery.claimToken, "completed");
    });

    await emit(createMessage());
    await emit(createMessage({ contentText: "duplicate" }));

    expect(deliveries).toHaveLength(1);
    expect(runtime.getStatusCounts().inbox.completed).toBe(1);
  });

  test("replays queued messages but not messages that entered Backend", async () => {
    const firstAdapter = createAdapter();
    const { runtime, db, dir } = createRuntime(firstAdapter.adapter);
    runtime.onInbound((delivery) => {
      const messageId = delivery.message.platformMsgId === "queued" ? 1 : 2;
      runtime.markInboundQueued(delivery.inboxId, delivery.claimToken, messageId);
      if (messageId === 2) runtime.markInboundRunState([messageId], "run-2", "agent_running");
    });
    await firstAdapter.emit(createMessage({ platformMsgId: "queued" }));
    await firstAdapter.emit(createMessage({ platformMsgId: "processing" }));

    const secondAdapter = createAdapter();
    const recovered = new PersistentTransport({
      db,
      botId: "NiuBot",
      platform: "feishu",
      adapter: secondAdapter.adapter,
      storageDir: dir,
    });
    const replayed: string[] = [];
    const recoveredMessageIds: Array<number | undefined> = [];
    recovered.onInbound((delivery) => {
      replayed.push(delivery.message.platformMsgId!);
      recoveredMessageIds.push(delivery.messageId);
      recovered.markInboundTerminal(delivery.inboxId, delivery.claimToken, "completed");
    });

    await recovered.recover();

    expect(replayed).toEqual(["queued"]);
    expect(recoveredMessageIds).toEqual([1]);
    expect(recovered.getStatusCounts().inbox.interrupted).toBe(1);
  });

  test("retries transient handler failures in-process and stops after success", async () => {
    const fake = createAdapter();
    const { runtime } = createRuntime(fake.adapter, { inboundRetryDelaysMs: [0, 0] });
    let attempts = 0;
    runtime.onInbound((delivery) => {
      attempts += 1;
      if (attempts < 3) throw new Error("temporary handler failure");
      runtime.markInboundTerminal(delivery.inboxId, delivery.claimToken, "completed");
    });

    await fake.emit(createMessage());
    await viWaitFor(() => attempts === 3);

    expect(runtime.getStatusCounts().inbox.completed).toBe(1);
    expect(runtime.getStatusCounts().inbox.failed).toBe(0);
  });

  test("prepares startup recovery only once when callers race", async () => {
    const fake = createAdapter();
    const { runtime } = createRuntime(fake.adapter);
    await fake.emit(createMessage());
    let deliveries = 0;
    runtime.onInbound((delivery) => {
      deliveries += 1;
      runtime.markInboundQueued(delivery.inboxId, delivery.claimToken, 1);
    });

    await Promise.all([runtime.recover(), runtime.recover()]);

    expect(deliveries).toBe(1);
    expect(runtime.getStatusCounts().inbox.queued).toBe(1);
  });
});

describe("PersistentTransport outbox", () => {
  test("persists and records a successful send", async () => {
    const fake = createAdapter();
    const { runtime } = createRuntime(fake.adapter);

    await expect(runtime.sendText("chat-1", "hello")).resolves.toBe("text-id");

    expect(fake.calls.map((call) => call.method)).toEqual(["sendText"]);
    expect(runtime.getStatusCounts().outbox.sent).toBe(1);
  });

  test("marks a timed out send unknown and accepts its late success without retrying", async () => {
    let resolveSend!: (value: string) => void;
    const operation = new Promise<string>((resolve) => { resolveSend = resolve; });
    const fake = createAdapter({ async sendText() { return operation; } });
    const { runtime } = createRuntime(fake.adapter);

    await expect(runtime.sendText("chat-1", "hello", { timeoutMs: 5 }))
      .rejects.toBeInstanceOf(DeliveryUncertainError);
    expect(runtime.getStatusCounts().outbox.unknown).toBe(1);

    resolveSend("late-id");
    await operation;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.getStatusCounts().outbox.sent).toBe(1);
  });

  test("records a definite adapter rejection as failed", async () => {
    const fake = createAdapter({ async sendText() { throw new Error("platform rejected"); } });
    const { runtime } = createRuntime(fake.adapter);

    await expect(runtime.sendText("chat-1", "hello")).rejects.toThrow("platform rejected");
    expect(runtime.getStatusCounts().outbox.failed).toBe(1);
  });

  test("sends a pending request during recovery", async () => {
    const fake = createAdapter();
    const { runtime, db } = createRuntime(fake.adapter);
    new TransportStore(db, "NiuBot", "feishu").insertOutbound(
      "pending-request",
      { kind: "text", chatId: "chat-1", text: "recover me" },
      JSON.stringify({ kind: "text", chatId: "chat-1", text: "recover me" }),
    );

    await runtime.recover();

    await viWaitFor(() => runtime.getStatusCounts().outbox.sent === 1);
    expect(fake.calls.map((call) => call.method)).toEqual(["sendText"]);
    expect(runtime.getStatusCounts().outbox.sent).toBe(1);
  });

  test("does not block recovery while pending outbox delivery is slow", async () => {
    const never = new Promise<string>(() => {});
    const fake = createAdapter({ async sendText() { return never; } });
    const { runtime, db } = createRuntime(fake.adapter, { deliveryTimeoutMs: 10 });
    new TransportStore(db, "NiuBot", "feishu").insertOutbound(
      "pending-request",
      { kind: "text", chatId: "chat-1", text: "recover me" },
      JSON.stringify({ kind: "text", chatId: "chat-1", text: "recover me" }),
    );

    await runtime.recover();

    expect(runtime.getStatusCounts().outbox.sending).toBe(1);
    await viWaitFor(() => runtime.getStatusCounts().outbox.unknown === 1);
  });

  test("copies outgoing files into managed storage and cleans the copy after success", async () => {
    let deliveredPath = "";
    const fake = createAdapter({
      async sendFile(_chatId, filePath) {
        deliveredPath = filePath;
        expect(existsSync(filePath)).toBe(true);
        return "file-id";
      },
    });
    const { runtime, dir } = createRuntime(fake.adapter);
    const source = path.join(dir, "source.txt");
    writeFileSync(source, "content");

    await runtime.sendFile("chat-1", source, "report.txt");

    expect(deliveredPath).not.toBe(source);
    expect(existsSync(deliveredPath)).toBe(false);
    expect(existsSync(source)).toBe(true);
  });

  test("cleans managed copies for expired unknown file deliveries during recovery", async () => {
    let deliveredPath = "";
    const never = new Promise<string>(() => {});
    const firstAdapter = createAdapter({
      async sendFile(_chatId, filePath) {
        deliveredPath = filePath;
        return never;
      },
    });
    const { runtime, db, dir } = createRuntime(firstAdapter.adapter);
    const source = path.join(dir, "source.txt");
    writeFileSync(source, "content");

    await expect(runtime.sendFile("chat-1", source, "report.txt", { timeoutMs: 1 }))
      .rejects.toBeInstanceOf(DeliveryUncertainError);
    expect(existsSync(deliveredPath)).toBe(true);

    const recovered = new PersistentTransport({
      db,
      botId: "NiuBot",
      platform: "feishu",
      adapter: createAdapter().adapter,
      storageDir: dir,
      unknownFileRetentionMs: 0,
    });
    await recovered.recover();

    expect(existsSync(deliveredPath)).toBe(false);
    expect(recovered.getStatusCounts().outbox.unknown).toBe(1);
  });
});

async function viWaitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
