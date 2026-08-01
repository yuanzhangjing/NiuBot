import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { initDatabase } from "../database/schema.js";
import { SqliteJobService } from "./job-service.js";
import { WorkerProfileRegistry } from "./profiles.js";
import { WorkerRuntime, type RunningJobExecution } from "./runtime.js";
import { WorkerScheduler, JOB_CANCEL_CONFIRM_TIMEOUT_MS } from "./scheduler.js";
import type { JobService } from "./types.js";

const BOT_ID = "test-bot";

let db: Database.Database;
let service: JobService;
let registry: WorkerProfileRegistry;
let scheduler: WorkerScheduler;

/** 不实际执行的 stub runtime：只暴露 watchdog/调度需要的接口。 */
class StubRuntime {
  running = new Map<string, RunningJobExecution>();
  readonly runJobCalls: string[] = [];

  runningCount(): number {
    return this.running.size;
  }
  inspectAll(): string[] {
    return [...this.running.keys()];
  }
  inspect(jobId: string): RunningJobExecution | undefined {
    return this.running.get(jobId);
  }
  async cancel(jobId: string, _reason: string): Promise<boolean> {
    return this.running.delete(jobId);
  }
  async runJob(jobId: string): Promise<void> {
    this.runJobCalls.push(jobId);
  }
}

let runtime: StubRuntime;

beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "worker-scheduler-"));
  db = initDatabase(path.join(dir, "test.db"));
  service = new SqliteJobService(db, BOT_ID);
  registry = new WorkerProfileRegistry();
  runtime = new StubRuntime();
  scheduler = new WorkerScheduler({
    runtime: runtime as unknown as WorkerRuntime,
    jobService: service,
    maxConcurrent: 2,
    tickMs: 30,
  });
});

afterEach(() => {
  scheduler.stop();
  db.close();
});

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function makeWorkAndJob() {
  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: "user-1",
    sourceChatId: "chat-1",
    visibility: "private",
    request: "测试任务",
  });
  const job = service.createJob({
    workId: work.id,
    workerProfileId: "general",
    prompt: "任务内容",
    workdir: "/tmp",
  });
  return { work, job };
}

test("cancelling 超时后强制终态（不再无限等待）", async () => {
  const { work, job } = makeWorkAndJob();
  service.claimJob({ jobId: job.id, claimToken: "l" });
  service.requestCancel(job.id);
  expect(service.getJob(job.id)?.status).toBe("cancelling");

  // 把 updated_at 改到超时之前
  db.prepare(
    `UPDATE worker_jobs SET updated_at = datetime('now', '-${Math.floor(JOB_CANCEL_CONFIRM_TIMEOUT_MS / 1000) + 60} seconds') WHERE id = ?`,
  ).run(job.id);

  scheduler.start();
  await waitFor(() => service.getJob(job.id)?.status === "cancelled");
  expect(service.getJob(job.id)?.error).toMatch(/cancel confirmation timed out/);
  expect(service.claimContinuations("chat-1", "t")).toHaveLength(1);
});

test("调度把 queued Job 交给 runtime 执行", async () => {
  const { job } = makeWorkAndJob();
  scheduler.start();
  await waitFor(() => runtime.runJobCalls.includes(job.id));
});

test("超过并发上限不认领", async () => {
  const { job } = makeWorkAndJob();
  runtime.running.set("fake-running", {
    jobId: "fake-running",
    session: { id: "s" },
    startedAt: Date.now(),
    lastActivity: Date.now(),
    controller: new AbortController(),
  });
  scheduler.start();
  // 给 tick 一点时间，仍应保持 queued（并发已满）
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(service.getJob(job.id)?.status).toBe("queued");
});
