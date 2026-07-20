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
