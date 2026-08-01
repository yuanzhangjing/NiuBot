/**
 * JobService：Worker 状态的唯一写入口（方案 §7.2）。
 *
 * 职责：创建 Work/Job、校验状态转换（CAS）、幂等、事件记录、Job 终态生成去重
 * Continuation、批量认领与完成标记。所有写入在事务内完成。
 *
 * 第一版不包含调度（Scheduler）与执行（WorkerRuntime）——那是 Phase 2 的内容。
 */

import type Database from "better-sqlite3";

import { MAX_JOBS_PER_WORK, MAX_WORK_INTERRUPTED_COUNT } from "./types.js";
import type {
  AgentContinuation,
  ClaimJobInput,
  ClaimJobResult,
  CompleteWorkInput,
  CreateJobInput,
  CreateWorkInput,
  Job,
  JobExecutionRecord,
  JobService,
  Work,
  WorkerEvent,
  WorkerEventName,
} from "./types.js";
import {
  appendWorkJobId,
  claimPendingContinuations,
  continuationRowToContinuation,
  countJobs,
  eventRowToEvent,
  getContinuationByDedupeKey,
  getJob,
  getJobByJobIdempotencyKey,
  getWork,
  incrementWorkInterruptedCount,
  insertContinuation,
  insertJob,
  insertJobIdempotencyKey,
  insertWork,
  insertWorkerEvent,
  jobRowToJob,
  listJobs,
  listJobsByStatus,
  listPendingContinuations,
  listWorkerEvents,
  listWorks as listWorkRows,
  markContinuationCompleted,
  resetClaimedContinuations,
  updateJobStatus,
  updateWorkConclusion,
  updateWorkStatus,
  workRowToWork,
} from "./store.js";

const JOB_TERMINAL_STATUSES = ["completed", "failed", "interrupted", "cancelled"] as const;

function continuationDedupeKey(workId: string, jobId: string): string {
  return `work:${workId}:job:${jobId}:terminal`;
}

function executionFields(record: JobExecutionRecord) {
  return {
    responseText: record.responseText,
    backendSessionId: record.backendSessionId,
    exitCode: record.exitCode,
    error: record.error,
    changedFiles: record.changedFiles,
    artifacts: record.artifacts,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
  };
}

export class SqliteJobService implements JobService {
  constructor(
    private readonly db: Database.Database,
    private readonly botId: string,
  ) {}

  // -----------------------------------------------------------------------
  // Work
  // -----------------------------------------------------------------------

  createWork(input: CreateWorkInput): Work {
    return this.db.transaction(() => {
      const row = insertWork(this.db, input);
      this.recordEvent({ workId: row.id, event: "work_created" });
      return workRowToWork(row);
    })();
  }

  getWork(workId: string): Work | undefined {
    const row = getWork(this.db, workId);
    return row ? workRowToWork(row) : undefined;
  }

  listWorks(query: { botId: string; ownerUserId?: string; status?: Work["status"] }): Work[] {
    return listWorkRows(this.db, query).map(workRowToWork);
  }

  // -----------------------------------------------------------------------
  // Job
  // -----------------------------------------------------------------------

  createJob(input: CreateJobInput, idempotencyKey?: string): Job {
    return this.db.transaction(() => {
      if (idempotencyKey) {
        const existing = getJobByJobIdempotencyKey(this.db, idempotencyKey);
        if (existing) return jobRowToJob(existing);
      }
      const work = getWork(this.db, input.workId);
      if (!work) {
        throw new Error(`Work ${input.workId} not found`);
      }
      if (work.status !== "active") {
        throw new Error(`Work ${input.workId} is not active (status=${work.status})`);
      }
      if (countJobs(this.db, input.workId) >= MAX_JOBS_PER_WORK) {
        throw new Error(`Work ${input.workId} reached job limit ${MAX_JOBS_PER_WORK}`);
      }
      const row = insertJob(this.db, {
        workId: input.workId,
        workerProfileId: input.workerProfileId,
        prompt: input.prompt,
        workdir: input.workdir,
      });
      appendWorkJobId(this.db, input.workId, row.id);
      if (idempotencyKey) {
        insertJobIdempotencyKey(this.db, idempotencyKey, row.id);
      }
      this.recordEvent({ workId: input.workId, jobId: row.id, event: "job_created" });
      return jobRowToJob(row);
    })();
  }

  getJob(jobId: string): Job | undefined {
    const row = getJob(this.db, jobId);
    return row ? jobRowToJob(row) : undefined;
  }

  listJobs(workId: string): Job[] {
    return listJobs(this.db, workId).map(jobRowToJob);
  }

  listJobsByStatus(status: Job["status"]): Job[] {
    return listJobsByStatus(this.db, status).map(jobRowToJob);
  }

  claimJob(input: ClaimJobInput): ClaimJobResult {
    return this.db.transaction(() => {
      const job = this.getJobDomain(input.jobId);
      if (!job) return { ok: false, reason: "not_queued" } satisfies ClaimJobResult;
      if (job.status !== "queued") return { ok: false, reason: "not_queued" } satisfies ClaimJobResult;
      const work = this.getWorkDomain(job.workId);
      if (!work || work.status !== "active") {
        return { ok: false, reason: "work_not_active" } satisfies ClaimJobResult;
      }
      const updated = updateJobStatus(this.db, input.jobId, {
        from: "queued",
        to: "running",
        version: job.version,
        fields: {
          claimToken: input.claimToken,
          claimedAt: new Date().toISOString(),
        },
      });
      if (!updated) return { ok: false, reason: "not_queued" } satisfies ClaimJobResult;
      this.recordEvent({
        workId: job.workId,
        jobId: input.jobId,
        event: "job_claimed",
        detail: `token=${input.claimToken}`,
      });
      return { ok: true, job: this.getJobDomain(input.jobId)! } satisfies ClaimJobResult;
    })();
  }

  completeJob(jobId: string, record: JobExecutionRecord): Job | undefined {
    return this.finishJob(jobId, record, "completed");
  }

  failJob(jobId: string, record: JobExecutionRecord): Job | undefined {
    return this.finishJob(jobId, record, "failed");
  }

  interruptJob(jobId: string): Job | undefined {
    return this.db.transaction(() => {
      const job = this.getJobDomain(jobId);
      if (!job || job.status !== "running") return undefined;
      const work = getWork(this.db, job.workId);
      if (!work) return undefined;
      const updated = updateJobStatus(this.db, jobId, {
        from: "running",
        to: "interrupted",
        version: job.version,
        fields: {
          endedAt: new Date().toISOString(),
          error: "interrupted by engine restart",
        },
      });
      if (!updated) return undefined;
      incrementWorkInterruptedCount(this.db, work.id);
      this.recordEvent({ workId: work.id, jobId, event: "job_interrupted" });
      // 达到上限后 Work 直接 failed，通知用户而不是无限重建
      const workAfter = getWork(this.db, work.id)!;
      if (workAfter.interrupted_count >= MAX_WORK_INTERRUPTED_COUNT && workAfter.status === "active") {
        updateWorkStatus(this.db, work.id, {
          from: "active",
          to: "failed",
          version: workAfter.version,
        });
        updateWorkConclusion(
          this.db,
          work.id,
          `该任务已 ${workAfter.interrupted_count} 次因 Engine 重启中断，已达到上限，需用户重新发起。`,
        );
        this.recordEvent({
          workId: work.id,
          event: "work_failed",
          detail: `interrupted_count=${workAfter.interrupted_count}`,
        });
      }
      this.createTerminalContinuation(this.db, jobId);
      return this.getJobDomain(jobId);
    })();
  }

  requestCancel(jobId: string): Job | undefined {
    return this.db.transaction(() => {
      const job = this.getJobDomain(jobId);
      if (!job) return undefined;
      const from: Job["status"] = job.status;
      if (from !== "queued" && from !== "running") return undefined;
      const updated = updateJobStatus(this.db, jobId, { from, to: "cancelling", version: job.version });
      if (!updated) return undefined;
      this.recordEvent({ workId: job.workId, jobId, event: "job_cancel_requested" });
      return this.getJobDomain(jobId);
    })();
  }

  confirmCancelled(jobId: string, record: JobExecutionRecord): Job | undefined {
    return this.finishJob(jobId, record, "cancelled");
  }

  cancelWork(workId: string): Work | undefined {
    return this.db.transaction(() => {
      const work = getWork(this.db, workId);
      if (!work) return undefined;
      if (work.status === "active") {
        updateWorkStatus(this.db, workId, { from: "active", to: "cancelling", version: work.version });
      }
      // 所有未终态 Job 进入 cancelling
      for (const jobRow of listJobs(this.db, workId)) {
        if (jobRow.status === "queued" || jobRow.status === "running") {
          updateJobStatus(this.db, jobRow.id, {
            from: jobRow.status,
            to: "cancelling",
            version: jobRow.version,
          });
          this.recordEvent({ workId, jobId: jobRow.id, event: "job_cancel_requested" });
        }
      }
      this.recordEvent({ workId, event: "work_cancelled", detail: "cancel requested" });
      const after = getWork(this.db, workId)!;
      return workRowToWork(after);
    })();
  }

  completeWork(workId: string, input: CompleteWorkInput): Work | undefined {
    return this.db.transaction(() => {
      const work = getWork(this.db, workId);
      if (!work || work.status !== "active") return undefined;
      const updated = updateWorkStatus(this.db, workId, {
        from: "active",
        to: "completed",
        version: work.version,
      });
      if (!updated) return undefined;
      updateWorkConclusion(this.db, workId, input.conclusion);
      this.recordEvent({ workId, event: "work_completed" });
      return workRowToWork(getWork(this.db, workId)!);
    })();
  }

  failWork(workId: string, reason: string): Work | undefined {
    return this.db.transaction(() => {
      const work = getWork(this.db, workId);
      if (!work) return undefined;
      if (work.status !== "active" && work.status !== "cancelling") return undefined;
      const updated = updateWorkStatus(this.db, workId, {
        from: work.status,
        to: "failed",
        version: work.version,
      });
      if (!updated) return undefined;
      updateWorkConclusion(this.db, workId, reason);
      this.recordEvent({ workId, event: "work_failed", detail: reason });
      return workRowToWork(getWork(this.db, workId)!);
    })();
  }

  // -----------------------------------------------------------------------
  // Continuation
  // -----------------------------------------------------------------------

  createJobTerminalContinuation(jobId: string): AgentContinuation | undefined {
    return this.db.transaction(() => this.createTerminalContinuation(this.db, jobId))();
  }

  getContinuation(id: string): AgentContinuation | undefined {
    const row = this.db.prepare("SELECT * FROM agent_continuations WHERE id = ?").get(id) as
      | import("./store.js").ContinuationRow
      | undefined;
    return row ? continuationRowToContinuation(row) : undefined;
  }

  listPendingContinuations(): AgentContinuation[] {
    return listPendingContinuations(this.db).map(continuationRowToContinuation);
  }

  claimContinuations(chatId: string, claimToken: string): AgentContinuation[] {
    return claimPendingContinuations(this.db, chatId, claimToken).map(continuationRowToContinuation);
  }

  resetClaimedContinuations(): number {
    return resetClaimedContinuations(this.db);
  }

  markContinuationCompleted(id: string, agentTurnId: string): void {
    this.db.transaction(() => {
      if (markContinuationCompleted(this.db, id, agentTurnId)) {
        const row = this.db
          .prepare("SELECT * FROM agent_continuations WHERE id = ?")
          .get(id) as { work_id: string } | undefined;
        if (row) {
          this.recordEvent({ workId: row.work_id, event: "continuation_completed", detail: id });
        }
      }
    })();
  }

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  recordEvent(input: Omit<WorkerEvent, "id" | "createdAt" | "botId">): void {
    insertWorkerEvent(this.db, { botId: this.botId, ...input });
  }

  listEvents(workId: string): WorkerEvent[] {
    return listWorkerEvents(this.db, workId).map(eventRowToEvent);
  }

  // -----------------------------------------------------------------------
  // internal
  // -----------------------------------------------------------------------

  /** Job 终态落库 + 生成去重 Continuation（同一事务）。 */
  private finishJob(
    jobId: string,
    record: JobExecutionRecord,
    to: "completed" | "failed" | "cancelled",
  ): Job | undefined {
    return this.db.transaction(() => {
      const job = this.getJobDomain(jobId);
      if (!job) return undefined;
      const from: Job["status"] = job.status;
      if (from !== "running" && from !== "cancelling") return undefined;
      if (to === "cancelled" && from !== "cancelling") return undefined;
      const updated = updateJobStatus(this.db, jobId, {
        from,
        to,
        version: job.version,
        fields: executionFields(record),
      });
      if (!updated) return undefined;
      this.recordEvent({
        workId: job.workId,
        jobId,
        event: to === "completed" ? "job_completed" : to === "failed" ? "job_failed" : "job_cancelled",
      });
      this.createTerminalContinuation(this.db, jobId);
      return this.getJobDomain(jobId);
    })();
  }

  private createTerminalContinuation(db: Database.Database, jobId: string): AgentContinuation | undefined {
    const row = getJob(db, jobId);
    if (!row) return undefined;
    if (!(JOB_TERMINAL_STATUSES as readonly string[]).includes(row.status)) return undefined;
    const work = getWork(db, row.work_id);
    if (!work) return undefined;
    const dedupeKey = continuationDedupeKey(row.work_id, jobId);
    let continuation = getContinuationByDedupeKey(db, dedupeKey);
    if (!continuation) {
      continuation = insertContinuation(db, {
        botId: this.botId,
        chatId: work.source_chat_id,
        dedupeKey,
        workId: row.work_id,
        jobIds: [jobId],
      });
      insertWorkerEvent(db, {
        botId: this.botId,
        workId: row.work_id,
        jobId,
        event: "continuation_created",
        detail: continuation.id,
      });
    }
    return continuationRowToContinuation(continuation);
  }

  private getJobDomain(jobId: string): Job | undefined {
    const row = getJob(this.db, jobId);
    return row ? jobRowToJob(row) : undefined;
  }

  private getWorkDomain(workId: string): Work | undefined {
    const row = getWork(this.db, workId);
    return row ? workRowToWork(row) : undefined;
  }
}
