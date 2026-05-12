import { describe, expect, test, vi, afterEach } from "vitest";
import type { BotInstance } from "./bot-instance.js";
import { startBotRuntime } from "./bot-startup.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("startBotRuntime", () => {
  test("starts API and cron without waiting for Feishu websocket", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const warnings: Array<Record<string, unknown> | undefined> = [];
    const bot = {
      id: "NiuBot",
      pipeline: {
        start: async () => { order.push("pipeline.start"); },
        recover: async () => { order.push("pipeline.recover"); },
      },
      im: {
        start: async () => {
          order.push("im.start");
          await new Promise<void>(() => {});
        },
      },
      apiServer: {
        start: async () => { order.push("api.start"); },
      },
      cronScheduler: {
        start: () => { order.push("cron.start"); },
      },
    } as unknown as BotInstance;

    await startBotRuntime(bot, {
      imStartTimeoutMs: 100,
      log: {
        info: () => {},
        warn: (_msg, data) => { warnings.push(data); },
        error: () => {},
      },
    });

    expect(order).toEqual([
      "pipeline.start",
      "pipeline.recover",
      "api.start",
      "cron.start",
      "im.start",
    ]);

    await vi.advanceTimersByTimeAsync(100);
    expect(warnings).toContainEqual(expect.objectContaining({
      name: "NiuBot",
      error: "TimeoutError: im.start timed out after 100ms",
    }));
  });
});
