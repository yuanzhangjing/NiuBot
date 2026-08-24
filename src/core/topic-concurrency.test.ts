import { describe, expect, test } from "vitest";
import { TopicConcurrencyLimiter } from "./topic-concurrency.js";

describe("TopicConcurrencyLimiter", () => {
  test("allows up to cap topics and defers the next without new input", () => {
    const limiter = new TopicConcurrencyLimiter(2);
    expect(limiter.tryAcquire("c5", "c5#omt_a")).toBe(true);
    expect(limiter.tryAcquire("c5", "c5#omt_b")).toBe(true);
    expect(limiter.tryAcquire("c5", "c5#omt_c")).toBe(false);

    expect(limiter.release("c5", "c5#omt_a")).toEqual(["c5#omt_c"]);
    expect(limiter.hasRunning("c5", "c5#omt_c")).toBe(true);
  });

  test("re-enters a running scope instead of deferring it", () => {
    const limiter = new TopicConcurrencyLimiter(1);
    expect(limiter.tryAcquire("c5", "c5#omt_a")).toBe(true);
    expect(limiter.tryAcquire("c5", "c5#omt_a")).toBe(true);
    expect(limiter.tryAcquire("c5", "c5#omt_b")).toBe(false);
  });

  test("wakes multiple deferred scopes only when capacity allows", () => {
    const limiter = new TopicConcurrencyLimiter(3);
    limiter.tryAcquire("c5", "c5#a");
    limiter.tryAcquire("c5", "c5#b");
    limiter.tryAcquire("c5", "c5#c");
    limiter.tryAcquire("c5", "c5#d");
    limiter.tryAcquire("c5", "c5#e");

    expect(limiter.release("c5", "c5#a")).toEqual(["c5#d"]);
    expect(limiter.release("c5", "c5#b")).toEqual(["c5#e"]);
    expect(limiter.release("c5", "c5#c")).toEqual([]);
  });
});
