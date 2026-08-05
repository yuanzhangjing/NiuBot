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

/** 同一 Work 连续失败达到该次数后 Work 直接 failed（§6 maxConsecutiveFailures 内部上限） */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** Continuation 认领次数上限：超过后标记 failed 不再投递（防失败重投死循环） */
export const MAX_CONTINUATION_ATTEMPTS = 5;
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
  claimContinuationById,
  claimPendingContinuations,
  continuationRowToContinuation,
  countJobs,
  eventRowToEvent,
  failContinuationByAttemptLimit,
  releaseContinuationClaim,
  resetStaleClaimedContinuations,
  getContinuationByDedupeKey,
  getJob,
  getJobByJobIdempotencyKey,
  getWork,
  incrementWorkConsecutiveFailures,
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
  resetWorkConsecutiveFailures,
  updateJobStatus,
  updateRunningJobSession,
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

  listWorks(query: { botId: string; ownerUserId?: string; sourceChatId?: string; status?: Work["status"] }): Work[] {
    return listWorkRows(this.db, query).map(workRowToWork);
  }

  // -----------------------------------------------------------------------
  // Job
  // -----------------------------------------------------------------------

  createJob(input: CreateJobInput, idempotencyKey?: string): Job {
    return this.db.transaction(() => {
      if (idempotencyKey) {
        const existing = getJobByJobIdempotencyKey(this.db, idempotencyKey);
        if (existing) {
          if (existing.work_id !== input.workId) {
            throw new Error(`Job idempotency key belongs to another Work: ${existing.work_id}`);
          }
          if (existing.worker_profile_id !== input.workerProfileId || existing.prompt !== input.prompt) {
            throw new Error("Job idempotency key was reused for different job content");
          }
          return jobRowToJob(existing);
        }
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
      // 依赖必须属于同一 Work
      if (input.dependsOn) {
        for (const depId of input.dependsOn) {
          const dep = getJob(this.db, depId);
          if (!dep || dep.work_id !== input.workId) {
            throw new Error(`依赖 Job ${depId} 不存在或不属于 Work ${input.workId}`);
          }
        }
      }
      const row = insertJob(this.db, {
        workId: input.workId,
        workerProfileId: input.workerProfileId,
        prompt: input.prompt,
        workdir: input.workdir,
        dependsOn: input.dependsOn,
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

  recordJobSession(
    jobId: string,
    input: { backendSessionId: string; backendType: string; sources: import("../agent/types.js").NativeTranscriptSource[] },
  ): Job | undefined {
    if (!updateRunningJobSession(this.db, jobId, input)) return undefined;
    return this.getJob(jobId);
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
      // 依赖检查：全部依赖必须已 completed
      for (const depId of job.dependsOn) {
        const dep = this.getJobDomain(depId);
        if (!dep || dep.status !== "completed") {
          return { ok: false, reason: "dependencies_pending" } satisfies ClaimJobResult;
        }
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

  interruptJob(jobId: string, reason?: string): Job | undefined {
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
          error: reason ?? "interrupted by engine restart",
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

  /** queued Job 因依赖失败直接终态（不经过执行；连续失败预算照常累计）。 */
  failQueuedJob(jobId: string, error: string): Job | undefined {
    return this.db.transaction(() => {
      const job = this.getJobDomain(jobId);
      if (!job || job.status !== "queued") return undefined;
      const updated = updateJobStatus(this.db, jobId, {
        from: "queued",
        to: "failed",
        version: job.version,
        fields: { error, endedAt: new Date().toISOString() },
      });
      if (!updated) return undefined;
      this.recordEvent({ workId: job.workId, jobId, event: "job_failed", detail: error });
      this.applyFailureBudget(job.workId);
      this.maybeSettleCancellingWork(job.workId);
      this.createTerminalContinuation(this.db, jobId);
      return this.getJobDomain(jobId);
    })();
  }

  cancelWork(workId: string): Work | undefined {
    return this.db.transaction(() => {
      const work = getWork(this.db, workId);
      if (!work) return undefined;
      if (work.status !== "active" && work.status !== "cancelling") return undefined;
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
      this.recordEvent({ workId, event: "work_cancel_requested" });
      // 空 Work 或所有 Job 已经终态时，不等待 Scheduler，立即结束取消状态。
      this.maybeSettleCancellingWork(workId);
      const after = getWork(this.db, workId)!;
      return workRowToWork(after);
    })();
  }

  completeWork(workId: string, input: CompleteWorkInput): Work | undefined {
    return this.db.transaction(() => {
      const work = getWork(this.db, workId);
      if (!work) return undefined;
      // 仅供人工修复异常悬挂的 Work；运行中的 Job 不能被提前截断。
      if (work.status !== "active" && work.status !== "cancelling") return undefined;
      if (!this.allJobsTerminal(workId)) return undefined;
      const updated = updateWorkStatus(this.db, workId, {
        from: work.status,
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

  /** 投递时认领单个 Continuation（pending → claimed；超限时标记 failed 不再投递）。 */
  claimContinuation(id: string, claimToken: string): boolean {
    return this.db.transaction(() => {
      const exhausted = failContinuationByAttemptLimit(this.db, id, MAX_CONTINUATION_ATTEMPTS);
      if (exhausted) {
        const continuation = this.getContinuation(id);
        if (continuation) {
          const hasOtherDeliverable = !!this.db.prepare(`
            SELECT 1 FROM agent_continuations
            WHERE work_id = ? AND id <> ? AND status IN ('pending', 'claimed')
            LIMIT 1
          `).get(continuation.workId, id);
          const work = this.getWork(continuation.workId);
          if (work?.status === "active" && this.allJobsTerminal(continuation.workId) && !hasOtherDeliverable) {
            this.failWork(continuation.workId, `Worker 结果连续 ${MAX_CONTINUATION_ATTEMPTS} 次未能交付，已停止重试`);
          }
        }
        return false;
      }
      return claimContinuationById(this.db, id, claimToken);
    })();
  }

  /** 主 Agent 回合失败/取消后释放认领（claimed → pending，允许重新投递）。 */
  releaseContinuationClaim(id: string): boolean {
    return releaseContinuationClaim(this.db, id);
  }

  /** claimed 超时兜底：超过阈值未完成（进程被杀等）→ 重置 pending。 */
  resetStaleClaimedContinuations(staleMinutes: number): number {
    return resetStaleClaimedContinuations(this.db, staleMinutes);
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

  failOrphanedEmptyWorks(reason: string): number {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT w.id
        FROM worker_works w
        WHERE w.bot_id = ? AND w.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM worker_jobs j WHERE j.work_id = w.id)
      `).all(this.botId) as Array<{ id: string }>;
      let failed = 0;
      for (const row of rows) {
        const work = getWork(this.db, row.id);
        if (!work) continue;
        if (!updateWorkStatus(this.db, row.id, { from: "active", to: "failed", version: work.version })) continue;
        updateWorkConclusion(this.db, row.id, reason);
        this.recordEvent({ workId: row.id, event: "work_failed", detail: reason });
        failed += 1;
      }
      return failed;
    })();
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

  completeDeliveredContinuations(input: {
    continuationIds: string[];
    agentTurnId: string;
    conclusion: string;
    workerEventCursor?: number;
  }): { completedWorkIds: string[]; continuedWorkIds: string[] } {
    const settle = this.db.transaction(() => {
      const deliveredWorkIds = new Set<string>();
      for (const id of input.continuationIds) {
        const row = this.db.prepare(
          "SELECT work_id FROM agent_continuations WHERE id = ? AND status = 'claimed'",
        ).get(id) as { work_id: string } | undefined;
        if (!row || !markContinuationCompleted(this.db, id, input.agentTurnId)) continue;
        deliveredWorkIds.add(row.work_id);
        this.recordEvent({ workId: row.work_id, event: "continuation_completed", detail: id });
      }

      const completedWorkIds: string[] = [];
      const continuedWorkIds: string[] = [];
      for (const workId of deliveredWorkIds) {
        const work = getWork(this.db, workId);
        if (!work || (work.status !== "active" && work.status !== "cancelling")) continue;

        // 游标不可用时拒绝自动完成：无法排除 Agent 本回合已经追加后续 Job。
        const createdFollowup = input.workerEventCursor === undefined || !!this.db.prepare(`
          SELECT 1 FROM worker_events
          WHERE work_id = ? AND event = 'job_created' AND id > ?
          LIMIT 1
        `).get(workId, input.workerEventCursor ?? 0);
        const hasUndeliveredContinuation = !!this.db.prepare(`
          SELECT 1 FROM agent_continuations
          WHERE work_id = ? AND status IN ('pending', 'claimed')
          LIMIT 1
        `).get(workId);
        if (createdFollowup || hasUndeliveredContinuation || !this.allJobsTerminal(workId)) {
          continuedWorkIds.push(workId);
          continue;
        }

        const updated = updateWorkStatus(this.db, workId, {
          from: work.status,
          to: "completed",
          version: work.version,
        });
        if (!updated) {
          continuedWorkIds.push(workId);
          continue;
        }
        updateWorkConclusion(this.db, workId, input.conclusion);
        this.recordEvent({ workId, event: "work_completed", detail: "final response delivered" });
        completedWorkIds.push(workId);
      }
      return { completedWorkIds, continuedWorkIds };
    });
    // nbt CLI 可能从另一进程并发创建后续 Job；IMMEDIATE 在任何读取前取得写锁，
    // 避免 deferred 事务读后升级写锁时 SQLITE_BUSY，或漏看刚创建的 Job。
    return settle.immediate();
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
      // 连续失败预算：completed 清零；failed 计数并检查上限
      if (to === "completed") {
        resetWorkConsecutiveFailures(this.db, job.workId);
      } else if (to === "failed") {
        this.applyFailureBudget(job.workId);
      }
      // cancelling 的 Work：所有 Job 终态后自动收敛到 cancelled（不再卡住）
      this.maybeSettleCancellingWork(job.workId);
      this.createTerminalContinuation(this.db, jobId);
      return this.getJobDomain(jobId);
    })();
  }

  /** 取消中的 Work 全部 Job 终态后自动 → cancelled（兜底，防止永远 cancelling）。 */
  private maybeSettleCancellingWork(workId: string): void {
    const work = getWork(this.db, workId);
    if (!work || work.status !== "cancelling") return;
    if (!this.allJobsTerminal(workId)) return;
    updateWorkStatus(this.db, workId, { from: "cancelling", to: "cancelled", version: work.version });
    updateWorkConclusion(this.db, workId, "任务已取消（所有 Job 已结束）。");
    this.recordEvent({ workId, event: "work_cancelled", detail: "all jobs terminal" });
  }

  private allJobsTerminal(workId: string): boolean {
    return listJobs(this.db, workId).every((job) =>
      (JOB_TERMINAL_STATUSES as readonly string[]).includes(job.status),
    );
  }

  /** 连续失败计数 + 上限检查（达到上限 Work 直接 failed）。 */
  private applyFailureBudget(workId: string): void {
    incrementWorkConsecutiveFailures(this.db, workId);
    const workAfter = getWork(this.db, workId);
    if (workAfter && workAfter.consecutive_failures >= MAX_CONSECUTIVE_FAILURES && workAfter.status === "active") {
      updateWorkStatus(this.db, workId, { from: "active", to: "failed", version: workAfter.version });
      updateWorkConclusion(
        this.db,
        workId,
        `该任务已连续失败 ${workAfter.consecutive_failures} 次，达到上限，需用户重新发起。`,
      );
      this.recordEvent({ workId, event: "work_failed", detail: `consecutive_failures=${workAfter.consecutive_failures}` });
    }
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
        triggerMsgPlatformId: work.trigger_msg_platform_id ?? undefined,
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
