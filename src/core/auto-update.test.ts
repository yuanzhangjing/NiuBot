import { describe, expect, it } from "vitest";
import {
  acquireUpgradeLock,
  cronSource,
  goalSource,
  isInUpgradeWindow,
  isSafeForUpgrade,
  loopSource,
  mainRunSource,
  readUpgradeLock,
  releaseUpgradeLock,
  workerSource,
  type AutoUpdateConfig,
} from "./auto-update.js";

const now = new Date("2026-08-08T03:30:00+08:00").getTime();

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

  it("cross-midnight window", () => {
    const cross: AutoUpdateConfig = { ...config, windowStartHour: 22, windowEndHour: 2 };
    expect(isInUpgradeWindow(new Date("2026-08-08T23:00:00+08:00"), cross)).toBe(true);
    expect(isInUpgradeWindow(new Date("2026-08-08T01:00:00+08:00"), cross)).toBe(true);
    expect(isInUpgradeWindow(new Date("2026-08-08T12:00:00+08:00"), cross)).toBe(false);
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

describe("upgrade lock", () => {
  it("acquire, read, release roundtrip", () => {
    const db = {} as never;
    const storage = new Map<string, string>();
    const fakeDb = {
      prepare: (sql: string) => ({
        get: () => {
          const key = sql.includes("key = ?") ? "auto_update_lock" : undefined;
          const v = key ? storage.get(key) : undefined;
          return v ? { value: v } : undefined;
        },
        run: (...args: unknown[]) => {
          storage.set(args[0] as string, args[1] as string);
          return { changes: 1 };
        },
      }),
    } as never;

    expect(acquireUpgradeLock(fakeDb as never, "1.2.3")).toBe(true);
    expect(acquireUpgradeLock(fakeDb as never, "1.2.4")).toBe(false);
    const lock = readUpgradeLock(fakeDb as never);
    expect(lock?.version).toBe("1.2.3");
    releaseUpgradeLock(fakeDb as never);
    expect(readUpgradeLock(fakeDb as never)).toBeNull();
    void db;
  });
});
