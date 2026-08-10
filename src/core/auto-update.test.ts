import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../database/schema.js";
import {
  cronSource,
  goalSource,
  isInUpgradeWindow,
  isSafeForUpgrade,
  loopSource,
  mainRunSource,
  minutesUntilUpgradeWindowEnd,
  workerSource,
  type AutoUpdateConfig,
} from "./auto-update.js";

const now = new Date("2026-08-08T03:30:00+08:00").getTime();

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("isSafeForUpgrade", () => {
  it("safe when all sources idle", () => {
    const result = isSafeForUpgrade([
      mainRunSource({ inflightRunCount: () => 0, pendingMessageCount: () => 0 }),
      workerSource({ nonTerminalJobCount: () => 0, nonTerminalContinuationCount: () => 0 }),
      goalSource({ activeGoalCount: () => 0 }),
    ], now, 30 * 60_000);
    expect(result.safe).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("blocked when any source is busy, with reasons", () => {
    const result = isSafeForUpgrade([
      mainRunSource({ inflightRunCount: () => 1, pendingMessageCount: () => 0 }),
      workerSource({ nonTerminalJobCount: () => 2, nonTerminalContinuationCount: () => 0 }),
      goalSource({ activeGoalCount: () => 0 }),
    ], now, 30 * 60_000);
    expect(result.safe).toBe(false);
    expect(result.blockers[0]).toContain("1 个 run 进行中");
    expect(result.blockers[1]).toContain("2 个 job 未完成");
  });

  it("main session blocks on pending messages", () => {
    const source = mainRunSource({ inflightRunCount: () => 0, pendingMessageCount: () => 3 });
    expect(source.isIdle(now, 60_000)).toBe(false);
    expect(source.describeBlockers(now, 60_000)).toContain("3 条消息排队");
  });
});

describe("window check", () => {
  const config: AutoUpdateConfig = {
    enabled: true,
    windowStartHour: 2,
    windowEndHour: 5,
    timezone: "Asia/Shanghai",
    marginMinutes: 10,
    notifyOnResult: true,
  };

  it("inside window", () => {
    expect(isInUpgradeWindow(new Date("2026-08-08T03:30:00+08:00"), config)).toBe(true);
  });

  it("outside window", () => {
    expect(isInUpgradeWindow(new Date("2026-08-08T10:30:00+08:00"), config)).toBe(false);
  });

  it("boundary: end hour excluded, start hour included", () => {
    expect(isInUpgradeWindow(new Date("2026-08-08T02:00:00+08:00"), config)).toBe(true);
    expect(isInUpgradeWindow(new Date("2026-08-08T05:00:00+08:00"), config)).toBe(false);
  });

  it("handles a window that starts at local midnight", () => {
    const midnight: AutoUpdateConfig = { ...config, windowStartHour: 0, windowEndHour: 3 };
    expect(isInUpgradeWindow(new Date("2026-08-08T00:30:00+08:00"), midnight)).toBe(true);
    expect(isInUpgradeWindow(new Date("2026-08-08T03:00:00+08:00"), midnight)).toBe(false);
  });

  it("cross-midnight window", () => {
    const cross: AutoUpdateConfig = { ...config, windowStartHour: 22, windowEndHour: 2 };
    expect(isInUpgradeWindow(new Date("2026-08-08T23:00:00+08:00"), cross)).toBe(true);
    expect(isInUpgradeWindow(new Date("2026-08-08T01:00:00+08:00"), cross)).toBe(true);
    expect(isInUpgradeWindow(new Date("2026-08-08T12:00:00+08:00"), cross)).toBe(false);
  });

  it("computes minutes until window end with margin semantics", () => {
    expect(minutesUntilUpgradeWindowEnd(new Date("2026-08-08T03:30:00+08:00"), config)).toBe(90);
    expect(minutesUntilUpgradeWindowEnd(new Date("2026-08-08T04:55:00+08:00"), config)).toBe(5);
    expect(minutesUntilUpgradeWindowEnd(new Date("2026-08-08T10:00:00+08:00"), config)).toBe(0);
    expect(minutesUntilUpgradeWindowEnd(new Date("2026-08-08T04:50:59+08:00"), config)).toBeLessThan(10);
    // 跨天窗口：23:00 在 22:00-02:00 内，距结束 02:00 = 3 小时 = 180 分钟
    const cross: AutoUpdateConfig = { ...config, windowStartHour: 22, windowEndHour: 2 };
    expect(minutesUntilUpgradeWindowEnd(new Date("2026-08-08T23:00:00+08:00"), cross)).toBe(180);
  });
});

describe("cron source", () => {
  it("idle when no cron will trigger in window", () => {
    const source = cronSource({} as never, {
      listJobs: () => [{ cronExpr: "0 6 * * *", runAt: null, timezone: "Asia/Shanghai" }],
    });
    expect(source.isIdle(new Date("2026-08-08T03:00:00+08:00").getTime(), 30 * 60_000)).toBe(true);
  });

  it("blocked when cron triggers within window", () => {
    const source = cronSource({} as never, {
      listJobs: () => [{ cronExpr: "*/10 * * * *", runAt: null, timezone: "Asia/Shanghai" }],
    });
    expect(source.isIdle(new Date("2026-08-08T03:00:00+08:00").getTime(), 30 * 60_000)).toBe(false);
  });

  it("blocked when one-shot runAt falls in window", () => {
    // runAt 在 DB 中存 UTC：03:15+08:00 = 19:15Z，now = 19:00Z，窗口内命中
    const source = cronSource({} as never, {
      listJobs: () => [{ cronExpr: null, runAt: "2026-08-07T19:15:00Z", timezone: null }],
    });
    expect(source.isIdle(new Date("2026-08-07T19:00:00Z").getTime(), 30 * 60_000)).toBe(false);
  });
});

describe("loop source", () => {
  it("blocked while a loop is running", () => {
    const source = loopSource({} as never, {
      listJobs: () => [{ status: "running", nextRunAt: null }],
    });
    expect(source.isIdle(now, 30 * 60_000)).toBe(false);
  });

  it("blocked when next loop trigger falls in window", () => {
    // nextRunAt 存 UTC：03:20+08:00 = 19:20Z，now = 19:00Z，窗口内命中
    const source = loopSource({} as never, {
      listJobs: () => [{ status: "active", nextRunAt: "2026-08-07T19:20:00Z" }],
    });
    expect(source.isIdle(new Date("2026-08-07T19:00:00Z").getTime(), 30 * 60_000)).toBe(false);
  });

  it("idle when next loop trigger is beyond window", () => {
    const source = loopSource({} as never, {
      listJobs: () => [{ status: "active", nextRunAt: "2026-08-07T22:00:00Z" }],
    });
    expect(source.isIdle(new Date("2026-08-07T19:00:00Z").getTime(), 30 * 60_000)).toBe(true);
  });
});
