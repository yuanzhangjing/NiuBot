import { afterEach, describe, expect, test, vi } from "vitest";
import { MessageQueue, type QueuedMessage } from "./queue.js";

afterEach(() => {
  vi.useRealTimers();
});

function message(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    chatId: "c1",
    text: "hello",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("MessageQueue error isolation", () => {
  test("continues delayed processing when state callback throws", async () => {
    vi.useFakeTimers();
    const queue = new MessageQueue(10);
    const processed: string[] = [];

    queue.onStateChange(() => {
      throw new Error("state failed");
    });
    queue.onProcess(async (_chatId, mergedText) => {
      processed.push(mergedText);
    });

    expect(() => queue.push(message())).not.toThrow();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(["hello"]);
    expect(queue.hasBusyChats()).toBe(false);
  });

  test("keeps queue usable when pending callback throws", async () => {
    vi.useFakeTimers();
    const queue = new MessageQueue(10);

    queue.onPending(() => {
      throw new Error("pending failed");
    });
    queue.onProcess(async () => {
      await new Promise<void>(() => {});
    });

    queue.push(message({ text: "first" }));
    await vi.advanceTimersByTimeAsync(10);

    expect(() => queue.push(message({ text: "second" }))).not.toThrow();
    expect(queue.pendingCount("c1")).toBe(1);

    queue.stop();
  });
});

describe("MessageQueue discard semantics", () => {
  test("reports messages removed by an explicit drain", () => {
    const queue = new MessageQueue(10_000);
    const discarded: QueuedMessage[] = [];
    queue.onDiscard((messages) => discarded.push(...messages));
    queue.push(message({ dbMsgId: 1 }));
    queue.push(message({ dbMsgId: 2 }));

    expect(queue.drain("c1")).toBe(2);
    expect(discarded.map((item) => item.dbMsgId)).toEqual([1, 2]);
  });

  test("does not mark buffered work discarded during service shutdown", () => {
    const queue = new MessageQueue(10_000);
    const discarded: QueuedMessage[] = [];
    queue.onDiscard((messages) => discarded.push(...messages));
    queue.push(message({ dbMsgId: 1 }));

    queue.stop();

    expect(discarded).toEqual([]);
  });
});

describe("MessageQueue loop continuation FIFO", () => {
  function loopMsg(id: number): QueuedMessage {
    return message({
      text: `[loop continuation: ${id}]`,
      triggerKind: "loop_continuation",
      loopJobId: id,
    });
  }

  test("keeps user, loop, user in arrival order and never merges the loop", async () => {
    const queue = new MessageQueue(0);
    const seen: Array<{ kind: string; count: number }> = [];
    const resolvers: Array<() => void> = [];
    queue.onProcess(async (_chatId, _text, messages) => {
      seen.push({ kind: messages[0]?.triggerKind ?? "user", count: messages.length });
      await new Promise<void>((resolve) => resolvers.push(resolve));
    });

    queue.push(message({ text: "first", dbMsgId: 1 }));
    queue.push(loopMsg(7));
    queue.push(message({ text: "second", dbMsgId: 2 }));
    expect(seen).toEqual([{ kind: "user", count: 1 }]);

    resolvers.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual([
      { kind: "user", count: 1 },
      { kind: "loop_continuation", count: 1 },
    ]);

    resolvers.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual([
      { kind: "user", count: 1 },
      { kind: "loop_continuation", count: 1 },
      { kind: "user", count: 1 },
    ]);
    resolvers.shift()?.();
  });
});

describe("MessageQueue schedule command isolation", () => {
  test("never merges a schedule command with another user or schedule command", async () => {
    const queue = new MessageQueue(0);
    const seen: Array<Array<{ senderId?: string; scheduleCommand?: boolean }>> = [];
    const resolvers: Array<() => void> = [];
    queue.onProcess(async (_chatId, _text, messages) => {
      seen.push(messages.map(({ senderId, scheduleCommand }) => ({ senderId, scheduleCommand })));
      await new Promise<void>((resolve) => resolvers.push(resolve));
    });

    queue.push(message({ text: "/loop first", senderId: "u1", scheduleCommand: true }));
    queue.push(message({ text: "ordinary", senderId: "u2" }));
    queue.push(message({ text: "/cron second", senderId: "u2", scheduleCommand: true }));
    expect(seen).toEqual([[{ senderId: "u1", scheduleCommand: true }]]);

    resolvers.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen[1]).toEqual([{ senderId: "u2", scheduleCommand: undefined }]);
    resolvers.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen[2]).toEqual([{ senderId: "u2", scheduleCommand: true }]);
    resolvers.shift()?.();
  });
});

describe("MessageQueue collaboration turn isolation", () => {
  test("never merges a collaboration turn with another user or collaboration turn", async () => {
    const queue = new MessageQueue(0);
    const seen: Array<Array<{ text: string; collabTurn?: boolean }>> = [];
    const resolvers: Array<() => void> = [];
    queue.onProcess(async (_chatId, _text, messages) => {
      seen.push(messages.map(({ text, collabTurn }) => ({ text, collabTurn })));
      await new Promise<void>((resolve) => resolvers.push(resolve));
    });

    queue.push(message({ text: "handoff-1", collabTurn: true }));
    queue.push(message({ text: "ordinary" }));
    queue.push(message({ text: "handoff-2", collabTurn: true }));
    expect(seen).toEqual([[{ text: "handoff-1", collabTurn: true }]]);

    resolvers.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen[1]).toEqual([{ text: "ordinary", collabTurn: undefined }]);

    resolvers.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen[2]).toEqual([{ text: "handoff-2", collabTurn: true }]);
    resolvers.shift()?.();
  });
});
