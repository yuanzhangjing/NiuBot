import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import { initDatabase } from "../database/schema.js";
import {
  addLoopJob,
  claimDueLoopJobs,
  completeLoopRun,
  getLoopJob,
  LoopScheduler,
  formatLoopInterval,
  parseLoopDuration,
  recoverInterruptedLoopJobs,
  releaseQueuedLoopJob,
  startLoopRun,
} from "./loop.js";

const dirs: string[] = [];
const dbs: Database.Database[] = [];

afterEach(() => {
  for (const db of dbs) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dbs.length = 0;
  dirs.length = 0;
});

function fixture(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-loop-test-"));
  dirs.push(dir);
  const db = initDatabase(path.join(dir, "niubot.db"));
  dbs.push(db);
  db.prepare("INSERT INTO users (id, name, platform, platform_id) VALUES ('u1', 'user', 'feishu', 'pu1')").run();
  db.prepare("INSERT INTO chats (id, type, platform, platform_id, user_id) VALUES ('c1', 'p2p', 'feishu', 'pc1', 'pu1')").run();
  return db;
}

function addDue(db: Database.Database, options: { maxTimes?: number } = {}): number {
  const id = addLoopJob(db, {
    chatId: "c1",
    creatorUserId: "u1",
    intervalSeconds: 60,
    prompt: "check status",
    maxTimes: options.maxTimes,
    now: new Date("2026-01-01T00:00:00Z"),
  });
  return id;
}

describe("Loop state machine", () => {
  test("parses durations and rejects an interval longer than its lifetime", () => {
    expect(parseLoopDuration("5m")).toBe(300);
    expect(parseLoopDuration("2h")).toBe(7_200);
    expect(parseLoopDuration("bad")).toBeUndefined();
    expect(formatLoopInterval(300)).toBe("5 分钟");
    const db = fixture();
    expect(() => addLoopJob(db, {
      chatId: "c1", creatorUserId: "u1",
      intervalSeconds: 120, durationSeconds: 60, prompt: "x",
    })).toThrow("不能短于执行间隔");
  });

  test("claims a due run once and completes at max-times", () => {
    const db = fixture();
    const id = addDue(db, { maxTimes: 1 });
    const due = new Date("2026-01-01T00:01:00Z");
    expect(claimDueLoopJobs(db, due).map((job) => job.id)).toEqual([id]);
    expect(claimDueLoopJobs(db, due)).toEqual([]);
    expect(startLoopRun(db, id, due)?.status).toBe("running");
    expect(completeLoopRun(db, id, { success: true, now: due })).toMatchObject({
      status: "completed",
      runCount: 1,
      consecutiveFailures: 0,
    });
  });

  test("pauses after three consecutive failures", () => {
    const db = fixture();
    const id = addDue(db);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const now = new Date(`2026-01-01T00:0${attempt}:00Z`);
      db.prepare("UPDATE loop_jobs SET status = 'queued' WHERE id = ?").run(id);
      expect(startLoopRun(db, id, now)?.status).toBe("running");
      completeLoopRun(db, id, { success: false, error: `failure ${attempt}`, now });
    }
    expect(getLoopJob(db, id)).toMatchObject({
      status: "paused",
      consecutiveFailures: 3,
      lastError: "failure 3",
    });
  });

  test("recovers interrupted rows without depending on a session", () => {
    const db = fixture();
    const id = addDue(db);
    db.prepare("UPDATE loop_jobs SET status = 'running' WHERE id = ?").run(id);
    expect(recoverInterruptedLoopJobs(db, new Date("2026-01-01T00:02:00Z"))).toBe(1);
    expect(getLoopJob(db, id)?.status).toBe("active");

    recoverInterruptedLoopJobs(db, new Date("2026-01-01T00:03:00Z"));
    expect(getLoopJob(db, id)?.status).toBe("active");
  });

  test("scheduler hands due jobs to the executor and releases an enqueue failure", async () => {
    const db = fixture();
    const id = addDue(db);
    const seen: number[] = [];
    const scheduler = new LoopScheduler(db, async (job) => {
      seen.push(job.id);
      throw new Error("queue unavailable");
    });
    await scheduler.tick(new Date("2026-01-01T00:01:00Z"));
    expect(seen).toEqual([id]);
    expect(getLoopJob(db, id)?.status).toBe("active");
  });

  test("a discarded queued event is rescheduled", () => {
    const db = fixture();
    const id = addDue(db);
    claimDueLoopJobs(db, new Date("2026-01-01T00:01:00Z"));
    expect(releaseQueuedLoopJob(db, id, new Date("2026-01-01T00:01:10Z"))).toBe(true);
    expect(getLoopJob(db, id)).toMatchObject({ status: "active" });
  });

  test("runs once when the first due time exactly equals the deadline", () => {
    const db = fixture();
    const id = addLoopJob(db, {
      chatId: "c1", creatorUserId: "u1",
      intervalSeconds: 60, durationSeconds: 60, prompt: "boundary",
      now: new Date("2026-01-01T00:00:00Z"),
    });
    const deadline = new Date("2026-01-01T00:01:00Z");
    expect(claimDueLoopJobs(db, deadline).map((job) => job.id)).toEqual([id]);
    expect(startLoopRun(db, id, deadline)?.status).toBe("running");
    expect(completeLoopRun(db, id, { success: true, now: deadline })).toMatchObject({
      status: "completed",
      runCount: 1,
    });
  });

  test("does not start a queued run after its deadline", () => {
    const db = fixture();
    const id = addDue(db);
    claimDueLoopJobs(db, new Date("2026-01-01T00:01:00Z"));
    expect(startLoopRun(db, id, new Date("2026-01-02T00:00:01Z"))).toBeUndefined();
    expect(getLoopJob(db, id)?.status).toBe("completed");
  });

  test("stop waits for the current scheduler tick", async () => {
    const db = fixture();
    for (const prompt of ["slow enqueue", "not started"]) {
      addLoopJob(db, {
        chatId: "c1", creatorUserId: "u1", intervalSeconds: 60, durationSeconds: 3_600,
        prompt, now: new Date(Date.now() - 60_000),
      });
    }
    let release!: () => void;
    let started = false;
    const scheduler = new LoopScheduler(db, async () => {
      started = true;
      await new Promise<void>((resolve) => { release = resolve; });
    }, 60_000);
    scheduler.start();
    await vi.waitFor(() => expect(started).toBe(true));

    let stopped = false;
    const stop = scheduler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stop;
    expect(stopped).toBe(true);
    expect(getLoopJob(db, 2)?.status).toBe("active");
  });
});
