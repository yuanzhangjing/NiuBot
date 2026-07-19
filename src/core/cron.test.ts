import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import { initDatabase } from "../database/schema.js";
import { addCronJob, CronScheduler } from "./cron.js";

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
  test("runs a due one-time job once and marks it completed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00"));
    const db = setupDatabase();
    const calls: Array<{ chatId: string; userId: string; prompt: string; description: string }> = [];
    const scheduler = new CronScheduler(db, async (chatId, userId, prompt, description) => {
      calls.push({ chatId, userId, prompt, description });
    });
    const jobId = addCronJob(db, {
      chatId: "c1",
      creatorUserId: "u2",
      runAt: "2026-07-20 00:01:00",
      prompt: "run once",
      description: "one time",
    });

    vi.setSystemTime(new Date("2026-07-20T00:01:00"));
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
    vi.setSystemTime(new Date("2026-07-20T00:00:00"));
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

    vi.setSystemTime(new Date("2026-07-20T00:01:00"));
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
    vi.setSystemTime(new Date("2026-07-20T00:00:00"));
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
      prompt: "retry",
    });

    await (scheduler as any).tick();
    expect(db.prepare("SELECT status, run_count FROM cron_jobs WHERE id = ?").get(jobId)).toEqual({
      status: "active",
      run_count: 0,
    });

    vi.setSystemTime(new Date("2026-07-20T00:01:00"));
    await (scheduler as any).tick();
    expect(attempts).toBe(2);
    expect(db.prepare("SELECT status, run_count FROM cron_jobs WHERE id = ?").get(jobId)).toEqual({
      status: "active",
      run_count: 1,
    });
  });
});
