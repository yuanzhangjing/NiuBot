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

describe("MessageQueue worker continuation FIFO", () => {
  function continuationMsg(ids: string[]): QueuedMessage {
    return message({
      text: `[worker continuation: ${ids.join(",")}]`,
      triggerKind: "worker_continuation",
      continuationIds: ids,
    });
  }

  test("continuation 先到时，后到的用户消息等待 continuation 完成", async () => {
    const queue = new MessageQueue(0);
    const seen: string[] = [];
    let releaseFirst: () => void = () => {};
    queue.onProcess(async (_chatId, _text, messages) => {
      seen.push(messages[0]?.triggerKind ?? "user");
      if (seen.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });

    queue.push(continuationMsg(["ctn-1"]));
    queue.push(message({ dbMsgId: 1 }));
    expect(seen).toEqual(["worker_continuation"]);

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual(["worker_continuation", "user"]);
  });

  test("用户消息先到时，后到的 continuation 不跨过用户消息", async () => {
    const queue = new MessageQueue(10_000);
    const seen: string[] = [];
    let releaseFirst: () => void = () => {};
    queue.onProcess(async (_chatId, _text, messages) => {
      seen.push(messages[0]?.triggerKind ?? "user");
      if (seen.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });

    queue.push(message({ dbMsgId: 1 }));
    queue.push(continuationMsg(["ctn-2"]));
    expect(seen).toEqual(["user"]);

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual(["user", "worker_continuation"]);
  });
});
