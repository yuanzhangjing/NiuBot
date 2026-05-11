import { afterEach, describe, expect, test, vi } from "vitest";
import { ChatManager } from "./chat-manager.js";
import { RuntimeStateStore } from "./runtime-state.js";
import type { QueuedMessage } from "./queue.js";

function createStore(): RuntimeStateStore {
  let runSeq = 0;
  let now = 1_000;
  return new RuntimeStateStore({
    now: () => now++,
    createRunId: () => `run-${++runSeq}`,
  });
}

function message(input: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    chatId: "c1",
    text: "hello",
    timestamp: 1,
    dbMsgId: 1,
    platformMsgId: "m1",
    ...input,
  };
}

function waitMicrotask(): Promise<void> {
  return Promise.resolve();
}

describe("ChatManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("moves an idle chat into buffering when a message is enqueued", () => {
    const store = createStore();
    const manager = new ChatManager(100, store);

    const pending = manager.enqueue(message());

    expect(pending).toBe(false);
    expect(manager.getState("c1")).toMatchObject({
      state: "buffering",
      activeRunId: null,
      bufferMessageIds: [1],
    });
  });

  test("creates a run when the buffer flushes", async () => {
    vi.useFakeTimers();
    const store = createStore();
    const manager = new ChatManager(10, store);
    const calls: Array<{ runId: string; mergedText: string; messageIds: number[] }> = [];
    manager.onProcess(async (runId, _chatId, mergedText, messages) => {
      calls.push({
        runId,
        mergedText,
        messageIds: messages.map((m) => m.dbMsgId).filter((id): id is number => id != null),
      });
    });

    manager.enqueue(message());
    await vi.advanceTimersByTimeAsync(10);

    expect(calls).toEqual([{ runId: "run-1", mergedText: "hello", messageIds: [1] }]);
    expect(store.getRunsForChat("c1")[0]).toMatchObject({
      runId: "run-1",
      stage: "queued",
      triggerMessageIds: [1],
      triggerPlatformMsgIds: ["m1"],
      replyToPlatformMsgId: "m1",
    });
  });

  test("queues new messages as pending while the chat is busy", async () => {
    vi.useFakeTimers();
    const store = createStore();
    const manager = new ChatManager(10, store);
    let releaseFirst!: () => void;
    manager.onProcess(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));

    manager.enqueue(message({ text: "first", dbMsgId: 1, platformMsgId: "m1" }));
    await vi.advanceTimersByTimeAsync(10);
    const pending = manager.enqueue(message({ text: "second", dbMsgId: 2, platformMsgId: "m2" }));

    expect(pending).toBe(true);
    expect(manager.pendingCount("c1")).toBe(1);
    expect(manager.getState("c1")).toMatchObject({
      state: "busy",
      activeRunId: "run-1",
    });

    releaseFirst();
  });

  test("starts pending messages after the active run completes", async () => {
    vi.useFakeTimers();
    const store = createStore();
    const manager = new ChatManager(10, store);
    const calls: string[] = [];
    let releaseFirst!: () => void;
    manager.onProcess((_runId, _chatId, mergedText) => {
      calls.push(mergedText);
      if (calls.length === 1) {
        return new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      return Promise.resolve();
    });

    manager.enqueue(message({ text: "first", dbMsgId: 1, platformMsgId: "m1" }));
    await vi.advanceTimersByTimeAsync(10);
    manager.enqueue(message({ text: "second", dbMsgId: 2, platformMsgId: "m2" }));
    releaseFirst();
    await waitMicrotask();
    await vi.advanceTimersByTimeAsync(10);

    expect(calls).toEqual(["first", "second"]);
    expect(store.getRunsForChat("c1").map((run) => run.runId)).toEqual(["run-1", "run-2"]);
  });

  test("stopChat aborts the active run and clears pending messages", async () => {
    vi.useFakeTimers();
    const store = createStore();
    const manager = new ChatManager(10, store);
    manager.onProcess((_runId, _chatId, _mergedText, _messages, signal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }));

    manager.enqueue(message({ text: "first", dbMsgId: 1, platformMsgId: "m1" }));
    await vi.advanceTimersByTimeAsync(10);
    manager.enqueue(message({ text: "second", dbMsgId: 2, platformMsgId: "m2" }));

    const dropped = manager.stopChat("c1");
    await waitMicrotask();

    expect(dropped).toBe(1);
    expect(manager.pendingCount("c1")).toBe(0);
    expect(store.getRunsForChat("c1")[0].stage).toBe("stopped");
  });

  test("flushChat aborts the active run and keeps pending messages for a new run", async () => {
    vi.useFakeTimers();
    const store = createStore();
    const manager = new ChatManager(10, store);
    const calls: string[] = [];
    manager.onProcess((_runId, _chatId, mergedText, _messages, signal) => {
      calls.push(mergedText);
      if (calls.length === 1) {
        return new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return Promise.resolve();
    });

    manager.enqueue(message({ text: "first", dbMsgId: 1, platformMsgId: "m1" }));
    await vi.advanceTimersByTimeAsync(10);
    manager.enqueue(message({ text: "second", dbMsgId: 2, platformMsgId: "m2" }));

    const pending = manager.flushChat("c1");
    await waitMicrotask();
    await vi.advanceTimersByTimeAsync(10);

    expect(pending).toBe(1);
    expect(calls).toEqual(["first", "second"]);
    expect(store.getRunsForChat("c1").map((run) => run.stage)).toEqual(["stopped", "queued"]);
  });
});
