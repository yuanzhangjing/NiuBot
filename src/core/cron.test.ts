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
    const tick = (scheduler as any).tick();
    (scheduler as any).currentTick = tick;
    await vi.waitFor(() => expect(started).toBe(1));

    const stop = scheduler.stop();
    release();
    await stop;
    expect(started).toBe(1);
    expect(db.prepare("SELECT status FROM cron_jobs WHERE prompt = 'second'").get()).toEqual({ status: "active" });
  });
});
