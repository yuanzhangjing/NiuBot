import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import { initDatabase } from "../database/schema.js";
import { addCronJob, CronScheduler, migrateLegacyCronTimezones } from "./cron.js";

const tempDirs: string[] = [];
const databases: Database.Database[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const db of databases.splice(0)) {
    if (db.open) db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setupDatabase(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-cron-scheduler-"));
  tempDirs.push(dir);
  const db = initDatabase(path.join(dir, "niubot.db"));
  databases.push(db);
  return db;
}

describe("CronScheduler", () => {
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
});
