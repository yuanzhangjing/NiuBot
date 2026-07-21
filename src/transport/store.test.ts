import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { initDatabase } from "../database/schema.js";
import { TransportStore } from "./store.js";

const tempDirs: string[] = [];
const databases: Database.Database[] = [];

function createStore(): { db: Database.Database; store: TransportStore } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-transport-store-"));
  tempDirs.push(dir);
  const db = initDatabase(path.join(dir, "niubot.db"));
  databases.push(db);
  return { db, store: new TransportStore(db, "NiuBot", "feishu") };
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.open) db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("TransportStore inbox", () => {
  test("deduplicates platform messages with a database constraint", () => {
    const { store } = createStore();

    const first = store.insertInbound("msg-1", JSON.stringify({ text: "first" }));
    const duplicate = store.insertInbound("msg-1", JSON.stringify({ text: "duplicate" }));

    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.row.id).toBe(first.row.id);
    expect(JSON.parse(duplicate.row.payloadJson)).toEqual({ text: "first" });
  });

  test("tracks a queued message through Backend processing to completion", () => {
    const { store } = createStore();
    const inbox = store.insertInbound("msg-1", "{}").row;

    expect(store.claimInbound(inbox.id, "claim-1")).toMatchObject({
      status: "dispatching",
      claimToken: "claim-1",
      attemptCount: 1,
    });
    expect(store.markInboundQueued(inbox.id, "claim-1", 42)).toBe(true);
    expect(store.markInboundRunState([42], "run-1", "queued")).toBe(1);
    expect(store.markInboundRunState([42], "run-1", "agent_running")).toBe(1);
    expect(store.markInboundRunState([42], "run-1", "done")).toBe(1);

    expect(store.getInbound(inbox.id)).toMatchObject({
      status: "completed",
      messageId: 42,
      runId: "run-1",
      attemptCount: 1,
    });
  });

  test("allows only one consumer to claim a pending message", () => {
    const { db, store } = createStore();
    const competingStore = new TransportStore(db, "NiuBot", "feishu");
    const inbox = store.insertInbound("msg-1", "{}").row;

    const first = store.claimInbound(inbox.id, "consumer-a");
    const second = competingStore.claimInbound(inbox.id, "consumer-b");

    expect(first).toMatchObject({ status: "dispatching", claimToken: "consumer-a" });
    expect(second).toBeUndefined();
    expect(store.markInboundQueued(inbox.id, "consumer-b", 42)).toBe(false);
    expect(store.markInboundQueued(inbox.id, "consumer-a", 42)).toBe(true);
  });

  test("releases a failed claim for retry and fails it after the third attempt", () => {
    const { store } = createStore();
    const inbox = store.insertInbound("msg-1", "{}").row;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const token = `claim-${attempt}`;
      expect(store.claimInbound(inbox.id, token)?.attemptCount).toBe(attempt);
      const released = store.releaseInboundClaim(inbox.id, token, new Error("handler failed"));
      expect(released?.status).toBe(attempt === 3 ? "failed" : "pending");
    }
    expect(store.claimInbound(inbox.id, "claim-4")).toBeUndefined();
  });

  test("releases queued work when the in-memory enqueue step fails", () => {
    const { store } = createStore();
    const inbox = store.insertInbound("msg-1", "{}").row;

    store.claimInbound(inbox.id, "claim-1");
    store.markInboundQueued(inbox.id, "claim-1", 42);
    const released = store.releaseInboundClaim(inbox.id, "claim-1", new Error("queue unavailable"));

    expect(released).toMatchObject({ status: "pending", messageId: 42, attemptCount: 1 });
  });

  test("replays queued work but interrupts work that already entered Backend", () => {
    const { store } = createStore();
    const pending = store.insertInbound("pending", "{}").row;
    const queued = store.insertInbound("queued", "{}").row;
    const processing = store.insertInbound("processing", "{}").row;
    const discarded = store.insertInbound("discarded", "{}").row;

    store.claimInbound(queued.id, "queued-claim");
    store.markInboundQueued(queued.id, "queued-claim", 1);
    store.claimInbound(processing.id, "processing-claim");
    store.markInboundQueued(processing.id, "processing-claim", 2);
    store.markInboundRunState([2], "run-2", "agent_running");
    store.claimInbound(discarded.id, "discarded-claim");
    store.markInboundTerminal(discarded.id, "discarded-claim", "discarded");

    const recovery = store.prepareInboundRecovery();

    expect(recovery.requeued).toBe(1);
    expect(recovery.interrupted).toBe(1);
    expect(recovery.pending.map((row) => row.id)).toEqual([pending.id, queued.id]);
    expect(store.getInbound(processing.id)?.status).toBe("interrupted");
    expect(store.getInbound(discarded.id)?.status).toBe("discarded");
  });

  test("does not revive messages explicitly discarded from the memory queue", () => {
    const { store } = createStore();
    const inbox = store.insertInbound("msg-1", "{}").row;
    store.claimInbound(inbox.id, "claim-1");
    store.markInboundQueued(inbox.id, "claim-1", 9);

    expect(store.discardInboundMessages([9])).toBe(1);
    expect(store.prepareInboundRecovery().pending).toHaveLength(0);
    expect(store.getInbound(inbox.id)?.status).toBe("discarded");
  });
});

describe("TransportStore outbox", () => {
  test("tracks successful delivery and exposes status counts", () => {
    const { store } = createStore();
    store.insertOutbound("req-1", { kind: "text", chatId: "chat-1", text: "hello" }, "{}");

    expect(store.markOutboundSending("req-1")).toBe(true);
    expect(store.markOutboundSent("req-1", "platform-1")).toBe(true);
    expect(store.getOutbound("req-1")).toMatchObject({
      status: "sent",
      attemptCount: 1,
      platformMsgId: "platform-1",
    });
    expect(store.getStatusCounts().outbox.sent).toBe(1);
  });

  test("only retries requests whose platform call never started", () => {
    const { store } = createStore();
    store.insertOutbound("pending", { kind: "text", chatId: "chat-1", text: "a" }, "{}");
    store.insertOutbound("sending", { kind: "text", chatId: "chat-1", text: "b" }, "{}");
    store.markOutboundSending("sending");

    const recovery = store.prepareOutboundRecovery();

    expect(recovery.unknown).toBe(1);
    expect(recovery.pending.map((row) => row.requestId)).toEqual(["pending"]);
    expect(store.getOutbound("sending")?.status).toBe("unknown");
  });

  test("accepts a late success for the same unknown request without creating a new send", () => {
    const { store } = createStore();
    store.insertOutbound("req-1", { kind: "text", chatId: "chat-1", text: "hello" }, "{}");
    store.markOutboundSending("req-1");
    store.markOutboundUnknown("req-1", new Error("timeout"));

    expect(store.markOutboundSent("req-1", "platform-1")).toBe(true);
    expect(store.getOutbound("req-1")).toMatchObject({ status: "sent", platformMsgId: "platform-1" });
  });
});
