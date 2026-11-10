import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import { closeTestDatabases, openTestDatabase } from "../../test-utils/database.js";
import { TZ } from "../tz.js";
import {
  addCronJob,
  claimDueCronJobs,
  CRON_FAILURE_LIMIT,
  CronScheduler,
  deleteCronJob,
  describeCronExpr,
  describeCronSchedule,
  everyToCronExpr,
  MAX_ACTIVE_CRON_JOBS_PER_CHAT,
  migrateLegacyCronTimezones,
  recoverInterruptedCronJobs,
  validateCronExpression,
} from "./cron.js";

const tempDirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  closeTestDatabases();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setupDatabase(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-cron-scheduler-"));
  tempDirs.push(dir);
  const db = openTestDatabase(path.join(dir, "niubot.db"));
  return db;
}

describe("describeCronSchedule", () => {
  test("translates common cron expressions to readable frequency", () => {
    expect(describeCronExpr("*/5 * * * *")).toBe("每 5 分钟");
    expect(describeCronExpr("0 * * * *")).toBe("每小时");
    expect(describeCronExpr("0 */2 * * *")).toBe("每 2 小时");
    expect(describeCronExpr("0 8 * * *")).toBe("每天 08:00");
    expect(describeCronExpr("0 10 * * 1-5")).toBe("工作日 10:00");
    expect(describeCronExpr("0 9 * * 1")).toBe("每周一 09:00");
    expect(describeCronExpr("30 8 * * 0")).toBe("每周日 08:30");
  });

  test("converts clock times from the job timezone to the display timezone", () => {
    expect(describeCronExpr("30 1 * * *", "UTC", "Asia/Shanghai")).toBe("每天 09:30");
    expect(describeCronExpr("0 20 * * 1", "UTC", "Asia/Shanghai")).toBe("每周二 04:00");
    expect(describeCronExpr("0 1 * * 1-5", "UTC", "Asia/Shanghai")).toBe("工作日 09:00");
    expect(describeCronSchedule("30 1 * * *", null, "UTC")).toBe(
      describeCronExpr("30 1 * * *", "UTC", TZ),
    );
  });

  test("falls back to raw expression for unrecognized patterns", () => {
    expect(describeCronExpr("0 8 15 * *")).toBe("0 8 15 * *");
    expect(describeCronExpr("0 8 * * 1,3,5")).toBe("0 8 * * 1,3,5");
  });

  test("one-off cron shows local time, missing schedule shows placeholder", () => {
    expect(describeCronSchedule(null, "2026-08-05 07:38:00", "Asia/Shanghai")).toContain("一次性");
    expect(describeCronSchedule(null, null)).toBe("未设置");
  });
});

describe("everyToCronExpr", () => {
  test("converts relative intervals to cron expressions", () => {
    expect(everyToCronExpr(60)).toBe("*/1 * * * *");
    expect(everyToCronExpr(5 * 60)).toBe("*/5 * * * *");
    expect(everyToCronExpr(3_600)).toBe("0 * * * *");
    expect(everyToCronExpr(2 * 3_600)).toBe("0 */2 * * *");
    expect(everyToCronExpr(86_400)).toBe("0 0 */1 * *");
  });

  test("rejects sub-minute and non-uniform intervals", () => {
    expect(everyToCronExpr(30)).toBeUndefined();
    expect(everyToCronExpr(90)).toBeUndefined();
    expect(everyToCronExpr(7_200 + 60)).toBeUndefined();
  });
});

describe("CronScheduler", () => {
  test("validates exactly the five-field Cron subset the scheduler implements", () => {
    for (const expression of [
      "0 9 * * 1-5",
      "*/5 * * * *",
      "0 9,18 * * 1,3,5",
      "0 9 * * 7",
    ]) {
      expect(() => validateCronExpression(expression)).not.toThrow();
    }

    for (const expression of [
      "0 0 9 * * 1-5",
      "0 9 L * *",
      "0 9 ? * *",
      "0 9 * JAN *",
      "60 9 * * *",
      "0 9 * * 5-1",
    ]) {
      expect(() => validateCronExpression(expression)).toThrow();
    }
  });

  test("rejects invalid Cron expressions before inserting a job", () => {
    const db = setupDatabase();
    expect(() => addCronJob(db, {
      chatId: "c1",
      creatorUserId: "u2",
      cronExpr: "0 9 * * MON",
      prompt: "invalid",
    })).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM cron_jobs").get()).toEqual({ count: 0 });
  });

  test("rejects an untilTime that is in the past or earlier than runAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T02:00:00Z"));
    const db = setupDatabase();
    expect(() => addCronJob(db, {
      chatId: "c1", creatorUserId: "u2",
      cronExpr: "0 9 * * *", prompt: "past-until",
      untilTime: "2026-07-20 01:00:00", timeZone: "UTC",
    })).toThrow("until_time");
    expect(() => addCronJob(db, {
      chatId: "c1", creatorUserId: "u2",
      runAt: "2026-07-21 09:00:00", prompt: "until-before-runat",
      untilTime: "2026-07-21 08:00:00", timeZone: "UTC",
    })).toThrow("until_time");
    expect(db.prepare("SELECT COUNT(*) AS count FROM cron_jobs").get()).toEqual({ count: 0 });
    vi.useRealTimers();
  });

  test("stores one-time instants as UTC and executes them in the job timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T01:59:00Z"));
    const db = setupDatabase();
    let calls = 0;
    const scheduler = new CronScheduler(db, async () => { calls++; });
    const jobId = addCronJob(db, {
      chatId: "c1",
      creatorUserId: "u2",
      runAt: "2026-07-20 10:00:00",
      timeZone: "Asia/Shanghai",
      prompt: "timezone test",
    });

    expect(db.prepare("SELECT run_at, timezone FROM cron_jobs WHERE id = ?").get(jobId)).toEqual({
      run_at: "2026-07-20 02:00:00",
      timezone: "Asia/Shanghai",
    });
    vi.setSystemTime(new Date("2026-07-20T02:00:00Z"));
    await (scheduler as any).tick();
    expect(calls).toBe(1);
  });

  test("matches recurring cron expressions in their configured timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T01:59:00Z"));
    const db = setupDatabase();
    let calls = 0;
    const scheduler = new CronScheduler(db, async () => { calls++; });
    addCronJob(db, {
      chatId: "c1",
      creatorUserId: "u2",
      cronExpr: "0 10 * * *",
      timeZone: "Asia/Shanghai",
      prompt: "timezone cron",
    });

    vi.setSystemTime(new Date("2026-07-20T02:00:00Z"));
    await (scheduler as any).tick();
    expect(calls).toBe(1);
  });

  test("matches comma combinations containing steps and wildcard parts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:07:00Z"));
    const db = setupDatabase();
    let calls = 0;
    const scheduler = new CronScheduler(db, async () => { calls++; });
    addCronJob(db, {
      chatId: "c1",
      creatorUserId: "u2",
      cronExpr: "*/5,7 * * * *",
      timeZone: "UTC",
      prompt: "combined cron field",
    });

    await (scheduler as any).tick();
    expect(calls).toBe(1);
  });

  test("starts day and month steps at 1 instead of 0", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-01T00:00:00Z"));
    const db = setupDatabase();
    let calls = 0;
    const scheduler = new CronScheduler(db, async () => { calls++; });
    addCronJob(db, {
      chatId: "c1", creatorUserId: "u2",
      cronExpr: "0 0 */2 */2 *", timeZone: "UTC", prompt: "odd days and months",
    });

    await (scheduler as any).tick();
    expect(calls).toBe(1);
  });

  test("uses standard day-of-month/weekday OR semantics and accepts Sunday as 7", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z")); // Monday, not the first day of month
    const db = setupDatabase();
    const calls: string[] = [];
    const scheduler = new CronScheduler(db, async (_chatId, _userId, prompt) => { calls.push(prompt); });
    addCronJob(db, {
      chatId: "c1", creatorUserId: "u2",
      cronExpr: "0 0 1 * 1", timeZone: "UTC", prompt: "monday or first",
    });
    addCronJob(db, {
      chatId: "c1", creatorUserId: "u2",
      cronExpr: "0 0 * * 7", timeZone: "UTC", prompt: "sunday",
    });

    await (scheduler as any).tick();
    expect(calls).toEqual(["monday or first"]);

    vi.setSystemTime(new Date("2026-07-26T00:00:00Z")); // Sunday
    await (scheduler as any).tick();
    expect(calls).toEqual(["monday or first", "sunday"]);
  });

  test("migrates legacy local cron timestamps to UTC once", () => {
    const db = setupDatabase();
    db.prepare(`
      INSERT INTO cron_jobs (
        chat_id, creator_user_id, run_at, prompt, until_time, last_run_at, timezone
      ) VALUES ('c1', 'u2', '2026-07-20 10:00:00', 'legacy', '2026-07-21 10:00:00', '2026-07-19 10:00:00', NULL)
    `).run();

    expect(migrateLegacyCronTimezones(db, "Asia/Shanghai")).toBe(1);
    expect(db.prepare(`
      SELECT run_at, until_time, last_run_at, timezone FROM cron_jobs WHERE prompt = 'legacy'
    `).get()).toEqual({
      run_at: "2026-07-20 02:00:00",
      until_time: "2026-07-21 02:00:00",
      last_run_at: "2026-07-19 02:00:00",
      timezone: "Asia/Shanghai",
    });
    expect(migrateLegacyCronTimezones(db, "Asia/Shanghai")).toBe(0);
  });

  test("runs a due one-time job once and marks it completed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    const db = setupDatabase();
    const calls: Array<{ chatId: string; userId: string; prompt: string; description: string }> = [];
    const scheduler = new CronScheduler(db, async (chatId, userId, prompt, description) => {
      calls.push({ chatId, userId, prompt, description });
    });
    const jobId = addCronJob(db, {
      chatId: "c1",
      creatorUserId: "u2",
      runAt: "2026-07-20 00:01:00",
      timeZone: "UTC",
      prompt: "run once",
      description: "one time",
    });

    vi.setSystemTime(new Date("2026-07-20T00:01:00Z"));
    await (scheduler as any).tick();
    await (scheduler as any).tick();

    expect(calls).toEqual([{
      chatId: "c1",
      userId: "u2",
      prompt: "run once",
      description: "one time",
    }]);
    expect(db.prepare("SELECT status, run_count FROM cron_jobs WHERE id = ?").get(jobId)).toEqual({
      status: "completed",
      run_count: 1,
    });
  });

  test("starts due jobs concurrently and does not repeat them in the same minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    const db = setupDatabase();
    const started: string[] = [];
    const resolvers: Array<() => void> = [];
    const scheduler = new CronScheduler(db, async (_chatId, _userId, prompt) => {
      started.push(prompt);
      await new Promise<void>((resolve) => resolvers.push(resolve));
    });
    for (const prompt of ["first", "second"]) {
      addCronJob(db, {
        chatId: "c1",
        creatorUserId: "u2",
        cronExpr: "* * * * *",
        timeZone: "UTC",
        prompt,
      });
    }

    const firstTick = (scheduler as any).tick();
    await Promise.resolve();
    expect(started).toEqual(["first", "second"]);
    resolvers.splice(0).forEach((resolve) => resolve());
    await firstTick;

    await (scheduler as any).tick();
    expect(started).toEqual(["first", "second"]);

    vi.setSystemTime(new Date("2026-07-20T00:01:00Z"));
    const secondTick = (scheduler as any).tick();
    await Promise.resolve();
    expect(started).toEqual(["first", "second", "first", "second"]);
    resolvers.splice(0).forEach((resolve) => resolve());
    await secondTick;

    expect(db.prepare("SELECT run_count FROM cron_jobs ORDER BY id").all()).toEqual([
      { run_count: 2 },
      { run_count: 2 },
    ]);
  });

  test("keeps a failed recurring job active so a later minute can retry it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    const db = setupDatabase();
    let attempts = 0;
    const scheduler = new CronScheduler(db, async () => {
      attempts++;
      if (attempts === 1) throw new Error("temporary failure");
    });
    const jobId = addCronJob(db, {
      chatId: "c1",
      creatorUserId: "u2",
      cronExpr: "* * * * *",
      timeZone: "UTC",
      prompt: "retry",
    });

    await (scheduler as any).tick();
    expect(db.prepare("SELECT status, run_count FROM cron_jobs WHERE id = ?").get(jobId)).toEqual({
      status: "active",
      run_count: 0,
    });

    vi.setSystemTime(new Date("2026-07-20T00:01:00Z"));
    await (scheduler as any).tick();
    expect(attempts).toBe(2);
    expect(db.prepare("SELECT status, run_count FROM cron_jobs WHERE id = ?").get(jobId)).toEqual({
      status: "active",
      run_count: 1,
    });
  });

  test("atomically claims a due job once across schedulers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    const db = setupDatabase();
    addCronJob(db, {
      chatId: "c1", creatorUserId: "u2", cronExpr: "* * * * *", timeZone: "UTC", prompt: "once",
    });

    expect(claimDueCronJobs(db).map((job) => job.prompt)).toEqual(["once"]);
    expect(claimDueCronJobs(db)).toEqual([]);
  });

  test("running cancellation invalidates the claim and fences the stale executor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    const db = setupDatabase();
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const scheduler = new CronScheduler(db, async () => {
      markStarted();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    const id = addCronJob(db, {
      chatId: "c1", creatorUserId: "u2", cronExpr: "* * * * *", timeZone: "UTC", prompt: "cancel me",
    });
    const tick = (scheduler as any).tick() as Promise<void>;
    await started;
    expect(deleteCronJob(db, id)).toBe(true);
    expect(db.prepare("SELECT status, claim_token FROM cron_jobs WHERE id = ?").get(id)).toEqual({
      status: "cancelled",
      claim_token: null,
    });
    release();
    await tick;
    expect(db.prepare("SELECT status, run_count FROM cron_jobs WHERE id = ?").get(id)).toEqual({
      status: "cancelled",
      run_count: 0,
    });
  });

  test("overlapping ticks never execute the same job twice", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    const db = setupDatabase();
    const calls: string[] = [];
    const scheduler = new CronScheduler(db, async (_chatId, _userId, prompt) => { calls.push(prompt); });
    addCronJob(db, {
      chatId: "c1", creatorUserId: "u2", cronExpr: "* * * * *", timeZone: "UTC", prompt: "once per minute",
    });

    await Promise.all([(scheduler as any).tick(), (scheduler as any).tick(), (scheduler as any).tick()]);
    expect(calls).toEqual(["once per minute"]);
    expect(db.prepare("SELECT run_count FROM cron_jobs WHERE id = 1").get()).toEqual({ run_count: 1 });
  });

  test("limits concurrent Cron executions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    const db = setupDatabase();
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new CronScheduler(db, async () => {
      active++;
      peak = Math.max(peak, active);
      await gate;
      active--;
    }, { maxConcurrent: 2 });
    for (let i = 0; i < 5; i++) {
      addCronJob(db, {
        chatId: "c1", creatorUserId: "u2", cronExpr: "* * * * *", timeZone: "UTC", prompt: `job ${i}`,
      });
    }

    const tick = (scheduler as any).tick();
    await vi.waitFor(() => expect(active).toBe(2));
    release();
    await tick;
    expect(peak).toBe(2);
  });

  test("keeps claiming later jobs while an earlier one is still running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T23:59:00Z"));
    const db = setupDatabase();
    const started: string[] = [];
    const resolvers: Array<() => void> = [];
    const scheduler = new CronScheduler(db, async (_chatId, _userId, prompt) => {
      started.push(prompt);
      await new Promise<void>((resolve) => resolvers.push(resolve));
    }, { maxConcurrent: 2 });
    addCronJob(db, {
      chatId: "c1", creatorUserId: "u2", cronExpr: "0 0 * * *", timeZone: "UTC", prompt: "long",
    });
    addCronJob(db, {
      chatId: "c1", creatorUserId: "u2", cronExpr: "1 0 * * *", timeZone: "UTC", prompt: "later",
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000); // 00:00 — long 开始跑并且不结束
    await vi.waitFor(() => expect(started).toEqual(["long"]));

    await vi.advanceTimersByTimeAsync(60_000); // 00:01 — 不能被上一个 tick 挡住
    await vi.waitFor(() => expect(started).toEqual(["long", "later"]));

    resolvers.splice(0).forEach((resolve) => resolve());
    await scheduler.stop();
    expect(db.prepare("SELECT prompt, status, run_count FROM cron_jobs ORDER BY id").all()).toEqual([
      { prompt: "long", status: "active", run_count: 1 },
      { prompt: "later", status: "active", run_count: 1 },
    ]);
  });

  test("caps concurrent executions across ticks instead of per tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T23:59:00Z"));
    const db = setupDatabase();
    let active = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];
    const scheduler = new CronScheduler(db, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      active--;
    }, { maxConcurrent: 2 });
    for (const prompt of ["a", "b", "c"]) {
      addCronJob(db, {
        chatId: "c1", creatorUserId: "u2", cronExpr: "* * * * *", timeZone: "UTC", prompt,
      });
    }

    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(active).toBe(2));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(active).toBe(2);
    expect(peak).toBe(2);

    resolvers.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(active).toBe(2)); // 排队的第三个补上空出的槽位
    resolvers.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(active).toBe(0));
    await scheduler.stop();
  });

  test("hands run slots to queued jobs without leaking the concurrency budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:30Z"));
    const db = setupDatabase();
    const calls: string[] = [];
    const resolvers: Array<() => void> = [];
    const scheduler = new CronScheduler(db, async (_chatId, _userId, prompt) => {
      calls.push(prompt);
      await new Promise<void>((resolve) => resolvers.push(resolve));
    }, { maxConcurrent: 1 });
    for (const prompt of ["a", "b"]) {
      addCronJob(db, {
        chatId: "c1", creatorUserId: "u2", cronExpr: "* * * * *", timeZone: "UTC", prompt,
      });
    }

    const firstTick = (scheduler as any).tick() as Promise<void>;
    await vi.waitFor(() => expect(calls).toEqual(["a"]));
    resolvers.shift()!(); // a 结束，槽位转交给排队的 b
    await vi.waitFor(() => expect(calls).toEqual(["a", "b"]));
    resolvers.shift()!();
    await firstTick;
    expect((scheduler as any).activeRuns).toBe(0);

    // 下一分钟还能正常拿到槽位；计数一旦泄漏，这里会永远排队。
    vi.setSystemTime(new Date("2026-07-20T00:01:30Z"));
    const secondTick = (scheduler as any).tick() as Promise<void>;
    await vi.waitFor(() => expect(calls).toEqual(["a", "b", "a"]));
    resolvers.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(calls).toEqual(["a", "b", "a", "b"]));
    resolvers.splice(0).forEach((resolve) => resolve());
    await secondTick;
    expect((scheduler as any).activeRuns).toBe(0);
  });

  test("catches up a run missed inside the grace window on the first tick after start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T05:00:00Z"));
    const db = setupDatabase();
    const calls: string[] = [];
    const scheduler = new CronScheduler(db, async (_chatId, _userId, prompt) => { calls.push(prompt); });
    const jobId = addCronJob(db, {
      chatId: "c1", creatorUserId: "u2", cronExpr: "0 6 * * *", timeZone: "UTC", prompt: "missed fix",
    });

    vi.setSystemTime(new Date("2026-07-20T06:03:00Z")); // job 06:00 前就存在，只错过这一分钟
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(calls).toEqual(["missed fix"]));
    await scheduler.stop();
    expect(db.prepare("SELECT status, run_count FROM cron_jobs WHERE id = ?").get(jobId)).toEqual({
      status: "active",
      run_count: 1,
    });
  });

  test("does not catch up runs older than the grace window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T05:00:00Z"));
    const db = setupDatabase();
    const calls: string[] = [];
    const scheduler = new CronScheduler(db, async (_chatId, _userId, prompt) => { calls.push(prompt); });
    addCronJob(db, {
      chatId: "c1", creatorUserId: "u2", cronExpr: "0 6 * * *", timeZone: "UTC", prompt: "stale",
    });

    vi.setSystemTime(new Date("2026-07-20T06:30:00Z")); // 06:00 已经超出 10 分钟窗口
    scheduler.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toEqual([]);
    await scheduler.stop();
  });

  test("does not catch up a minute that already ran", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T05:00:00Z"));
    const db = setupDatabase();
    const calls: string[] = [];
    const scheduler = new CronScheduler(db, async (_chatId, _userId, prompt) => { calls.push(prompt); });
    const jobId = addCronJob(db, {
      chatId: "c1", creatorUserId: "u2", cronExpr: "0 6 * * *", timeZone: "UTC", prompt: "already ran",
    });
    db.prepare("UPDATE cron_jobs SET last_run_at = '2026-07-20 06:00:00' WHERE id = ?").run(jobId);

    vi.setSystemTime(new Date("2026-07-20T06:03:00Z"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual([]);
    await scheduler.stop();
  });

  test("catch-up can be disabled with catchUpGraceMs: 0", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T05:00:00Z"));
    const db = setupDatabase();
    const calls: string[] = [];
    const scheduler = new CronScheduler(db, async (_chatId, _userId, prompt) => { calls.push(prompt); }, {
      catchUpGraceMs: 0,
    });
    addCronJob(db, {
      chatId: "c1", creatorUserId: "u2", cronExpr: "0 6 * * *", timeZone: "UTC", prompt: "no catch-up",
    });

    vi.setSystemTime(new Date("2026-07-20T06:03:00Z"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toEqual([]);
    await scheduler.stop();
  });

  test("does not catch up a minute that predates the job", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T06:03:00Z")); // 06:00 那一分钟 job 还不存在
    const db = setupDatabase();
    const calls: string[] = [];
    const scheduler = new CronScheduler(db, async (_chatId, _userId, prompt) => { calls.push(prompt); });
    addCronJob(db, {
      chatId: "c1", creatorUserId: "u2", cronExpr: "0 6 * * *", timeZone: "UTC", prompt: "too new",
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toEqual([]);
    await scheduler.stop();
  });

  test("catches up a minute skipped by a stalled tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T23:50:00Z"));
    const db = setupDatabase();
    const calls: string[] = [];
    const scheduler = new CronScheduler(db, async (_chatId, _userId, prompt) => { calls.push(prompt); });
    addCronJob(db, {
      chatId: "c1", creatorUserId: "u2", cronExpr: "0 0 * * *", timeZone: "UTC", prompt: "midnight",
    });

    await (scheduler as any).tick(); // 23:50 — 还没到点
    expect(calls).toEqual([]);

    // 进程挂起 13 分钟，00:03 才恢复：中间 00:00 这一分钟不能被吞掉
    vi.setSystemTime(new Date("2026-07-20T00:03:00Z"));
    await (scheduler as any).tick();
    expect(calls).toEqual(["midnight"]);
  });

  test("runs a catch-up at most once per tick for a high-frequency job", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T06:00:00Z"));
    const db = setupDatabase();
    const calls: string[] = [];
    const jobId = addCronJob(db, {
      chatId: "c1", creatorUserId: "u2", cronExpr: "* * * * *", timeZone: "UTC", prompt: "every minute",
    });
    db.prepare("UPDATE cron_jobs SET last_run_at = '2026-07-20 06:00:00' WHERE id = ?").run(jobId);
    vi.setSystemTime(new Date("2026-07-20T06:03:00Z"));

    const scheduler = new CronScheduler(db, async (_chatId, _userId, prompt) => { calls.push(prompt); });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000); // 06:04 第一次 tick，回看窗口有 10 分钟
    await vi.waitFor(() => expect(calls).toEqual(["every minute"]));
    await scheduler.stop();
  });

  test("catches up using the job timezone instead of the server timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T21:00:00Z")); // Asia/Shanghai 05:00
    const db = setupDatabase();
    const calls: string[] = [];
    const scheduler = new CronScheduler(db, async (_chatId, _userId, prompt) => { calls.push(prompt); });
    addCronJob(db, {
      chatId: "c1", creatorUserId: "u2", cronExpr: "0 6 * * *", timeZone: "Asia/Shanghai", prompt: "shanghai",
    });

    vi.setSystemTime(new Date("2026-07-20T22:03:00Z")); // Asia/Shanghai 06:03
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(calls).toEqual(["shanghai"]));
    await scheduler.stop();
  });

  test("skips a queued job that expired before it could start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    const db = setupDatabase();
    const calls: string[] = [];
    const resolvers: Array<() => void> = [];
    const scheduler = new CronScheduler(db, async (_chatId, _userId, prompt) => {
      calls.push(prompt);
      await new Promise<void>((resolve) => resolvers.push(resolve));
    }, { maxConcurrent: 1 });
    addCronJob(db, {
      chatId: "c1", creatorUserId: "u2", cronExpr: "* * * * *", timeZone: "UTC", prompt: "long",
    });
    const queuedId = addCronJob(db, {
      chatId: "c1", creatorUserId: "u2", cronExpr: "* * * * *", timeZone: "UTC",
      prompt: "queued", untilTime: "2026-07-20 00:01:00",
    });

    const tick = (scheduler as any).tick() as Promise<void>;
    await vi.waitFor(() => expect(calls).toEqual(["long"]));

    vi.setSystemTime(new Date("2026-07-20T00:05:00Z")); // 排队期间过了截止时间
    resolvers.shift()!(); // long 结束，queued 拿到槽位
    await tick;

    expect(calls).toEqual(["long"]); // 过期的任务不能放出去
    expect(db.prepare("SELECT status, run_count, last_run_at FROM cron_jobs WHERE id = ?").get(queuedId)).toEqual({
      status: "active",
      run_count: 0,
      last_run_at: null,
    });
  });

  test("a claim that never started can be claimed again after a restart", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T05:00:00Z"));
    const db = setupDatabase();
    const jobId = addCronJob(db, {
      chatId: "c1", creatorUserId: "u2", cronExpr: "0 6 * * *", timeZone: "UTC", prompt: "queued crash",
    });

    vi.setSystemTime(new Date("2026-07-20T06:00:10Z"));
    expect(claimDueCronJobs(db).map((job) => job.prompt)).toEqual(["queued crash"]);
    // claim 不再推进 last_run_at：否则排队时崩溃会被当成"这一分钟已经跑过"
    expect(db.prepare("SELECT status, last_run_at FROM cron_jobs WHERE id = ?").get(jobId)).toEqual({
      status: "running",
      last_run_at: null,
    });

    expect(recoverInterruptedCronJobs(db)).toBe(1);
    vi.setSystemTime(new Date("2026-07-20T06:04:00Z"));
    expect(claimDueCronJobs(db, new Date(), { catchUpMs: 10 * 60_000 }).map((job) => job.prompt)).toEqual([
      "queued crash",
    ]);
  });

  test("a run interrupted after starting does not repeat within its minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T05:00:00Z"));
    const db = setupDatabase();
    const jobId = addCronJob(db, {
      chatId: "c1", creatorUserId: "u2", cronExpr: "0 6 * * *", timeZone: "UTC", prompt: "started crash",
    });

    vi.setSystemTime(new Date("2026-07-20T06:00:10Z"));
    expect(claimDueCronJobs(db)).toHaveLength(1);
    db.prepare("UPDATE cron_jobs SET last_run_at = '2026-07-20 06:00:10' WHERE id = ?").run(jobId); // 已经开始执行

    expect(recoverInterruptedCronJobs(db)).toBe(1);
    expect(claimDueCronJobs(db, new Date("2026-07-20T06:00:40Z"))).toEqual([]);
  });

  test("a null created_at row does not break the whole claim", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    const db = setupDatabase();
    addCronJob(db, {
      chatId: "c1", creatorUserId: "u2", cronExpr: "* * * * *", timeZone: "UTC", prompt: "healthy",
    });
    db.prepare(`
      INSERT INTO cron_jobs (chat_id, creator_user_id, cron_expr, prompt, status, created_at)
      VALUES ('c1', 'u2', '* * * * *', 'dirty row', 'active', NULL)
    `).run();

    const claimed = claimDueCronJobs(db, new Date("2026-07-20T00:00:00Z")).map((job) => job.prompt);
    expect(claimed).toEqual(["healthy", "dirty row"]);
  });

  test("pauses after repeated failures and reports the terminal failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    const db = setupDatabase();
    const reports: boolean[] = [];
    const scheduler = new CronScheduler(db, async () => {
      throw new Error("backend unavailable");
    }, {
      reportFailure: (_chatId, _description, _error, paused) => { reports.push(paused); },
    });
    const id = addCronJob(db, {
      chatId: "c1", creatorUserId: "u2", cronExpr: "* * * * *", timeZone: "UTC", prompt: "fail",
    });

    for (let attempt = 0; attempt < CRON_FAILURE_LIMIT; attempt++) {
      vi.setSystemTime(new Date(`2026-07-20T00:0${attempt}:00Z`));
      await (scheduler as any).tick();
    }
    expect(reports).toEqual([false, false, true]);
    expect(db.prepare("SELECT status, consecutive_failures, last_error FROM cron_jobs WHERE id = ?").get(id)).toEqual({
      status: "paused",
      consecutive_failures: CRON_FAILURE_LIMIT,
      last_error: "Error: backend unavailable",
    });
  });

  test("caps active Cron jobs per chat and recovers interrupted claims", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    const db = setupDatabase();
    for (let i = 0; i < MAX_ACTIVE_CRON_JOBS_PER_CHAT; i++) {
      addCronJob(db, {
        chatId: "c1", creatorUserId: "u2", cronExpr: "0 0 * * *", timeZone: "UTC", prompt: `job ${i}`,
      });
    }
    expect(() => addCronJob(db, {
      chatId: "c1", creatorUserId: "u2", cronExpr: "0 0 * * *", timeZone: "UTC", prompt: "overflow",
    })).toThrow("最多保留");

    db.prepare("UPDATE cron_jobs SET status = 'running', claimed_at = datetime('now'), claim_token = 'stale' WHERE id = 1").run();
    expect(recoverInterruptedCronJobs(db)).toBe(1);
    expect(db.prepare("SELECT status, claimed_at, claim_token FROM cron_jobs WHERE id = 1").get()).toEqual({
      status: "active",
      claimed_at: null,
      claim_token: null,
    });
  });

  test("stop releases claimed jobs that have not started", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    const db = setupDatabase();
    for (const prompt of ["first", "second"]) {
      addCronJob(db, {
        chatId: "c1", creatorUserId: "u2", cronExpr: "* * * * *", timeZone: "UTC", prompt,
      });
    }
    let release!: () => void;
    let started = 0;
    const scheduler = new CronScheduler(db, async () => {
      started++;
      await new Promise<void>((resolve) => { release = resolve; });
    }, { maxConcurrent: 1 });
    const tick = (scheduler as any).tick() as Promise<void>;
    await vi.waitFor(() => expect(started).toBe(1));

    const stop = scheduler.stop();
    release();
    await stop;
    await tick;
    expect(started).toBe(1);
    // 排队没执行的 job 要连 claim 一起归还，不能留下"已跑过这一分钟"的假记录。
    expect(db.prepare("SELECT status, last_run_at FROM cron_jobs WHERE prompt = 'second'").get()).toEqual({
      status: "active",
      last_run_at: null,
    });
  });
});
