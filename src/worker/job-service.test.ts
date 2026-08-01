import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { initDatabase } from "../database/schema.js";
import { SqliteJobService } from "./job-service.js";
import { WorkerScheduler } from "./scheduler.js";
import { MAX_JOBS_PER_WORK, MAX_WORK_INTERRUPTED_COUNT } from "./types.js";
import type { JobExecutionRecord } from "./types.js";

const BOT_ID = "test-bot";
const CHAT_ID = "chat-1";
const OWNER = "user-1";

let db: Database.Database;
let service: SqliteJobService;
let tempDirs: string[] = [];

function record(status: JobExecutionRecord["status"] = "completed"): JobExecutionRecord {
  return {
    status,
    responseText: "done",
    changedFiles: [],
    artifacts: [],
    startedAt: "2026-07-31 10:00:00",
    endedAt: "2026-07-31 10:01:00",
  };
}

function makeWork() {
  return service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "调研登录模块现状",
  });
}

function makeJob(workId: string, idempotencyKey?: string) {
  return service.createJob(
    {
      workId,
      workerProfileId: "reviewer",
      prompt: "检查登录模块的并发和错误恢复问题，给出证据。",
      workdir: "/tmp/work",
    },
    idempotencyKey,
  );
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "worker-test-"));
  tempDirs.push(dir);
  db = initDatabase(path.join(dir, "test.db"));
  service = new SqliteJobService(db, BOT_ID);
});

afterEach(() => {
  db.close();
});

describe("Work / Job 创建", () => {
  test("createWork 落库并记录事件", () => {
    const work = makeWork();
    expect(work.id).toMatch(/^wrk_/);
    expect(work.status).toBe("active");
    expect(work.jobIds).toEqual([]);
    expect(work.interruptedCount).toBe(0);
    expect(service.getWork(work.id)?.request).toBe("调研登录模块现状");
    expect(service.listEvents(work.id).map((e) => e.event)).toContain("work_created");
  });

  test("createJob 追加到 Work.jobIds", () => {
    const work = makeWork();
    const job = makeJob(work.id);
    expect(job.status).toBe("queued");
    expect(service.getWork(work.id)?.jobIds).toEqual([job.id]);
    expect(service.listJobs(work.id)).toHaveLength(1);
  });

  test("不存在的 Work 创建 Job 抛错", () => {
    expect(() => makeJob("wrk_missing")).toThrow(/not found/);
  });

  test("非 active Work 拒绝创建 Job", () => {
    const work = makeWork();
    service.completeWork(work.id, { conclusion: "done" });
    expect(() => makeJob(work.id)).toThrow(/not active/);
  });

  test("达到 Job 上限后拒绝创建", () => {
    const work = makeWork();
    for (let i = 0; i < MAX_JOBS_PER_WORK; i++) {
      service.createJob({ workId: work.id, workerProfileId: "w", prompt: `p${i}`, workdir: "/tmp" });
    }
    expect(() => makeJob(work.id)).toThrow(/job limit/);
  });

  test("相同幂等键返回原 Job，不重复创建", () => {
    const work = makeWork();
    const job1 = makeJob(work.id, "key-1");
    const job2 = makeJob(work.id, "key-1");
    expect(job2.id).toBe(job1.id);
    expect(service.listJobs(work.id)).toHaveLength(1);
  });
});

describe("Job 状态机", () => {
  test("完整生命周期 queued → running → completed，并生成去重 Continuation", () => {
    const work = makeWork();
    const job = makeJob(work.id);

    const claim = service.claimJob({ jobId: job.id, claimToken: "lease-1" });
    expect(claim.ok).toBe(true);
    expect(claim.ok && claim.job.status).toBe("running");
    expect(claim.ok && claim.job.claimToken).toBe("lease-1");

    const done = service.completeJob(job.id, record());
    expect(done?.status).toBe("completed");
    expect(done?.responseText).toBe("done");

    const continuations = service.claimContinuations(CHAT_ID, "turn-1");
    expect(continuations).toHaveLength(1);
    expect(continuations[0].dedupeKey).toBe(`work:${work.id}:job:${job.id}:terminal`);
    expect(continuations[0].jobIds).toEqual([job.id]);

    // 重复创建 Continuation 去重：同一 Job 不会产生第二个
    service.createJobTerminalContinuation(job.id);
    expect(service.claimContinuations(CHAT_ID, "turn-2")).toHaveLength(0);
  });

  test("queued 不能直接 completed（跳过 running）", () => {
    const work = makeWork();
    const job = makeJob(work.id);
    expect(service.completeJob(job.id, record())).toBeUndefined();
    expect(service.getJob(job.id)?.status).toBe("queued");
  });

  test("已终态 Job 的重复 complete 返回 undefined", () => {
    const work = makeWork();
    const job = makeJob(work.id);
    service.claimJob({ jobId: job.id, claimToken: "l" });
    service.completeJob(job.id, record());
    expect(service.completeJob(job.id, record())).toBeUndefined();
  });

  test("claim 竞态：第二次认领失败（状态已变）", () => {
    const work = makeWork();
    const job = makeJob(work.id);
    const first = service.claimJob({ jobId: job.id, claimToken: "l1" });
    expect(first.ok).toBe(true);
    const second = service.claimJob({ jobId: job.id, claimToken: "l2" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("not_queued");
  });

  test("cancelWork 使 Work 与全部 Job 进入 cancelling，confirm 后终态并生成 Continuation", () => {
    const work = makeWork();
    const job = makeJob(work.id);
    service.claimJob({ jobId: job.id, claimToken: "l" });

    service.cancelWork(work.id);
    expect(service.getWork(work.id)?.status).toBe("cancelling");
    expect(service.getJob(job.id)?.status).toBe("cancelling");

    const cancelled = service.confirmCancelled(job.id, record("cancelled"));
    expect(cancelled?.status).toBe("cancelled");

    const continuations = service.claimContinuations(CHAT_ID, "t");
    expect(continuations).toHaveLength(1);
    expect(continuations[0].jobIds).toEqual([job.id]);
  });

  test("running Job 直接 confirmCancelled 被拒绝（必须先 requestCancel）", () => {
    const work = makeWork();
    const job = makeJob(work.id);
    service.claimJob({ jobId: job.id, claimToken: "l" });
    expect(service.confirmCancelled(job.id, record("cancelled"))).toBeUndefined();
  });
});

describe("Work 终态", () => {
  test("completeWork 写结论并终态", () => {
    const work = makeWork();
    const done = service.completeWork(work.id, { conclusion: "结论：无问题" });
    expect(done?.status).toBe("completed");
    expect(done?.finalConclusion).toBe("结论：无问题");
  });

  test("failWork 支持 active 和 cancelling", () => {
    const work = makeWork();
    service.failWork(work.id, "无法继续");
    expect(service.getWork(work.id)?.status).toBe("failed");

    const work2 = makeWork();
    service.cancelWork(work2.id);
    service.failWork(work2.id, "用户放弃");
    expect(service.getWork(work2.id)?.status).toBe("failed");
  });
});

describe("interruptJob 与防循环上限", () => {
  test("interrupt 计数并生成 Continuation", () => {
    const work = makeWork();
    const job = makeJob(work.id);
    service.claimJob({ jobId: job.id, claimToken: "l" });

    const interrupted = service.interruptJob(job.id);
    expect(interrupted?.status).toBe("interrupted");
    expect(service.getWork(work.id)?.interruptedCount).toBe(1);
    expect(service.claimContinuations(CHAT_ID, "t")).toHaveLength(1);
  });

  test(`累计 ${MAX_WORK_INTERRUPTED_COUNT} 次后 Work 直接 failed`, () => {
    const work = makeWork();
    for (let i = 0; i < MAX_WORK_INTERRUPTED_COUNT; i++) {
      const job = makeJob(work.id);
      service.claimJob({ jobId: job.id, claimToken: `l${i}` });
      service.interruptJob(job.id);
    }
    expect(service.getWork(work.id)?.status).toBe("failed");
    expect(service.getWork(work.id)?.interruptedCount).toBe(MAX_WORK_INTERRUPTED_COUNT);
    expect(service.getWork(work.id)?.finalConclusion).toMatch(/中断/);
  });
});

describe("Job 依赖", () => {
  test("依赖未完成时 claim 返回 dependencies_pending", () => {
    const work = makeWork();
    const jobA = makeJob(work.id);
    const jobB = service.createJob({
      workId: work.id,
      workerProfileId: "w",
      prompt: "B",
      workdir: "/tmp",
      dependsOn: [jobA.id],
    });

    const claimB = service.claimJob({ jobId: jobB.id, claimToken: "l" });
    expect(claimB.ok).toBe(false);
    if (!claimB.ok) expect(claimB.reason).toBe("dependencies_pending");

    // A 完成后 B 可认领
    service.claimJob({ jobId: jobA.id, claimToken: "l1" });
    service.completeJob(jobA.id, record());
    const claimB2 = service.claimJob({ jobId: jobB.id, claimToken: "l2" });
    expect(claimB2.ok).toBe(true);
  });

  test("依赖必须属于同一 Work，否则创建拒绝", () => {
    const work1 = makeWork();
    const work2 = makeWork();
    const jobA = makeJob(work1.id);
    expect(() =>
      service.createJob({
        workId: work2.id,
        workerProfileId: "w",
        prompt: "B",
        workdir: "/tmp",
        dependsOn: [jobA.id],
      }),
    ).toThrow(/不属于 Work/);
  });

  test("依赖失败后本 Job 自动失败（Scheduler 传播）", async () => {
    const work = makeWork();
    const jobA = makeJob(work.id);
    const jobB = service.createJob({
      workId: work.id,
      workerProfileId: "w",
      prompt: "B",
      workdir: "/tmp",
      dependsOn: [jobA.id],
    });
    service.claimJob({ jobId: jobA.id, claimToken: "l" });
    service.failJob(jobA.id, record("failed"));

    // 等价于 Scheduler tick 1c 步骤（依赖失败传播）
    const stubRuntime = {
      runningCount: () => 0,
      inspectAll: () => [],
      inspect: () => undefined,
      cancel: async () => true,
      runJob: async () => {},
    };
    const scheduler = new WorkerScheduler({
      runtime: stubRuntime as never,
      jobService: service,
      maxConcurrent: 2,
      tickMs: 20,
    });
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    scheduler.stop();
    expect(service.getJob(jobB.id)?.status).toBe("failed");
    expect(service.getJob(jobB.id)?.error).toMatch(/dependency/);
  });
});

describe("连续失败上限", () => {
  test("连续失败 3 次后 Work 直接 failed", () => {
    const work = makeWork();
    for (let i = 0; i < 3; i++) {
      const job = makeJob(work.id);
      service.claimJob({ jobId: job.id, claimToken: `l${i}` });
      service.failJob(job.id, record("failed"));
    }
    expect(service.getWork(work.id)?.status).toBe("failed");
    expect(service.getWork(work.id)?.finalConclusion).toMatch(/连续失败/);
  });

  test("中途成功清零连续失败计数", () => {
    const work = makeWork();
    const job1 = makeJob(work.id);
    service.claimJob({ jobId: job1.id, claimToken: "l1" });
    service.failJob(job1.id, record("failed"));
    expect(service.getWork(work.id)?.consecutiveFailures).toBe(1);

    const job2 = makeJob(work.id);
    service.claimJob({ jobId: job2.id, claimToken: "l2" });
    service.completeJob(job2.id, record());
    expect(service.getWork(work.id)?.consecutiveFailures).toBe(0);
  });
});

describe("Continuation 死循环防护", () => {
  test("认领次数达到上限后标记 failed，不再投递", () => {
    const work = makeWork();
    const job = makeJob(work.id);
    service.claimJob({ jobId: job.id, claimToken: "l" });
    service.completeJob(job.id, record());
    const continuation = service.claimContinuations(CHAT_ID, "t")[0]!;

    // 模拟失败重投：release → claim 循环（初始 claim 已算 1 次）
    for (let i = 1; i < 5; i++) {
      service.releaseContinuationClaim(continuation.id);
      expect(service.claimContinuation(continuation.id, `d${i}`)).toBe(true);
    }
    // 第 6 次尝试：达到上限 → failed，claim 失败
    service.releaseContinuationClaim(continuation.id);
    expect(service.claimContinuation(continuation.id, "d-last")).toBe(false);
    expect(service.getContinuation(continuation.id)?.status).toBe("failed");
  });

  test("claimed 超时后重置为 pending（进程被杀兜底）", () => {
    const work = makeWork();
    const job = makeJob(work.id);
    service.claimJob({ jobId: job.id, claimToken: "l" });
    service.completeJob(job.id, record());
    const continuation = service.claimContinuations(CHAT_ID, "t")[0]!;
    expect(continuation.status).toBe("claimed");

    // 把 claimed_at 改到 1 小时前
    db.prepare("UPDATE agent_continuations SET claimed_at = datetime('now', '-1 hour') WHERE id = ?").run(continuation.id);
    const reset = service.resetStaleClaimedContinuations(30);
    expect(reset).toBe(1);
    expect(service.getContinuation(continuation.id)?.status).toBe("pending");
  });

  test("未超时的 claimed 不被重置", () => {
    const work = makeWork();
    const job = makeJob(work.id);
    service.claimJob({ jobId: job.id, claimToken: "l" });
    service.completeJob(job.id, record());
    service.claimContinuations(CHAT_ID, "t");
    const reset = service.resetStaleClaimedContinuations(30);
    expect(reset).toBe(0);
  });
});

describe("Work 终态后 Continuation 不再投递", () => {
  test("Work 已终态：claimed continuation 重启恢复时直接收敛，不重置重投", () => {
    const work = makeWork();
    const job = makeJob(work.id);
    service.claimJob({ jobId: job.id, claimToken: "l" });
    service.completeJob(job.id, record());
    const continuation = service.claimContinuations(CHAT_ID, "t")[0]!;
    expect(continuation.status).toBe("claimed");

    // 主 Agent 验收完成 Work
    service.completeWork(work.id, { conclusion: "完成" });

    // 重启恢复：Work 已终态 → 不重置，直接收敛 completed
    const reset = service.resetClaimedContinuations();
    expect(service.getContinuation(continuation.id)?.status).toBe("completed");
    expect(reset).toBe(0);
    // 不再出现在待投递列表
    expect(service.listPendingContinuations()).toHaveLength(0);
  });

  test("Work 终态后 pending continuation 不再被投递（Scheduler 扫描跳过）", () => {
    const work = makeWork();
    const job = makeJob(work.id);
    service.claimJob({ jobId: job.id, claimToken: "l" });
    service.completeJob(job.id, record());
    // 不认领（保持 pending），主 Agent 直接完成 Work
    service.completeWork(work.id, { conclusion: "完成" });

    const pending = service.listPendingContinuations();
    expect(pending).toHaveLength(0);
    // 原 continuation 已收敛
    const continuations = service.claimContinuations(CHAT_ID, "t");
    expect(continuations).toHaveLength(0);
  });
});

describe("Continuation 认领与完成", () => {
  test("批量认领同一 chat 的多个 Continuation（合并验收）", () => {
    const work = makeWork();
    const jobA = makeJob(work.id);
    const jobB = makeJob(work.id);
    service.claimJob({ jobId: jobA.id, claimToken: "l1" });
    service.claimJob({ jobId: jobB.id, claimToken: "l2" });
    service.completeJob(jobA.id, record());
    service.completeJob(jobB.id, record());

    const batch = service.claimContinuations(CHAT_ID, "turn-1");
    expect(batch).toHaveLength(2);

    for (const c of batch) {
      service.markContinuationCompleted(c.id, "turn-1");
    }
    // 已完成的不能再认领
    expect(service.claimContinuations(CHAT_ID, "turn-2")).toHaveLength(0);
  });

  test("不同 chat 的 Continuation 互不可见", () => {
    const work = makeWork();
    const job = makeJob(work.id);
    service.claimJob({ jobId: job.id, claimToken: "l" });
    service.completeJob(job.id, record());
    expect(service.claimContinuations("other-chat", "t")).toHaveLength(0);
  });

  test("claim 后未完成，其他 claimToken 不能再次认领", () => {
    const work = makeWork();
    const job = makeJob(work.id);
    service.claimJob({ jobId: job.id, claimToken: "l" });
    service.completeJob(job.id, record());
    service.claimContinuations(CHAT_ID, "turn-1");
    expect(service.claimContinuations(CHAT_ID, "turn-2")).toHaveLength(0);
  });
});
