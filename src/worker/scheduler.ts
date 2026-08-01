/**
 * WorkerScheduler：确定性调度（方案 §7.3）。
 *
 * 周期扫描 queued Job 认领并交给 WorkerRuntime 执行（受全局 maxConcurrent 限制），
 * 同时检查运行中 Job 的活动 watchdog（无输出 30 分钟或总运行 2 小时终止）。
 * 任务拆解和 Worker 选择由主 Agent 完成，Scheduler 不做业务决策。
 */

import { createLogger } from "../logger.js";
import type { JobService } from "./types.js";
import { WorkerRuntime } from "./runtime.js";
import { ResourceLeaseManager } from "./lease.js";

const log = createLogger("worker-scheduler");

export const JOB_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const JOB_WALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** cancelling 状态无进展（进程未确认退出）超过该时间后强制终态 */
export const JOB_CANCEL_CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

export interface WorkerSchedulerOptions {
  runtime: WorkerRuntime;
  jobService: JobService;
  /** 全局并发上限（防失控，不是业务编排规则） */
  maxConcurrent: number;
  tickMs?: number;
  /** pending Continuation 投递回调（Pipeline 提供：入队主 Agent 队列，内存去重） */
  onContinuations?: (chatId: string, continuationIds: string[]) => void;
  /** 写任务租约管理（存在时定期清理过期租约） */
  leaseManager?: ResourceLeaseManager;
  /** 是否允许调度新 Job（/teams off 时返回 false；watchdog 和投递继续） */
  isSchedulingEnabled?: () => boolean;
}

export class WorkerScheduler {
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: WorkerSchedulerOptions) {
    this.tickMs = options.tickMs ?? 5_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tickSafely(), this.tickMs);
    log.info("worker scheduler started", {
      maxConcurrent: this.options.maxConcurrent,
      tickMs: this.tickMs,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 主动唤醒（Job 创建后立即调度，不必等下一个 tick） */
  kick(): void {
    void this.tickSafely();
  }

  private async tickSafely(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      log.error("worker scheduler tick failed", { error: String(err) });
    }
  }

  private async tick(): Promise<void> {
    const { runtime, jobService, maxConcurrent } = this.options;

    // 0. 清理过期写租约（进程残留不会永久占住资源）
    const expired = this.options.leaseManager?.cleanupExpired() ?? 0;
    if (expired > 0) {
      log.info("expired worker leases cleaned", { count: expired });
    }

    // 1. watchdog：超时运行中 Job 强制取消
    const now = Date.now();
    for (const jobId of [...runtime.inspectAll()]) {
      const exec = runtime.inspect(jobId);
      if (!exec) continue;
      const idleMs = now - exec.lastActivity;
      const wallMs = now - exec.startedAt;
      if (idleMs > JOB_IDLE_TIMEOUT_MS || wallMs > JOB_WALL_TIMEOUT_MS) {
        log.warn("worker job timed out, cancelling", {
          jobId,
          idleMs,
          wallMs,
        });
        await runtime.cancel(jobId, idleMs > JOB_IDLE_TIMEOUT_MS ? "idle_timeout" : "wall_timeout");
      }
    }

    // 1b. cancelling 超时兜底：进程确认退出超时后强制终态（不再无限等待）
    const cancelDeadline = new Date(Date.now() - JOB_CANCEL_CONFIRM_TIMEOUT_MS).toISOString();
    for (const job of jobService.listJobsByStatus("cancelling")) {
      const updatedAt = job.updatedAt.replace(" ", "T") + "Z";
      if (updatedAt < cancelDeadline) {
        log.warn("worker job cancel confirmation timed out, forcing terminal state", { jobId: job.id });
        if (runtime.inspect(job.id)) {
          await runtime.cancel(job.id, "cancel_confirm_timeout");
        }
        jobService.confirmCancelled(job.id, {
          status: "cancelled",
          responseText: "",
          error: "cancel confirmation timed out",
          changedFiles: [],
          artifacts: [],
          startedAt: job.startedAt ?? new Date().toISOString(),
          endedAt: new Date().toISOString(),
        });
      }
    }

    // 2. 调度：/teams off 时不认领新 Job（running 继续，watchdog 和投递不受影响）
    const schedulingEnabled = this.options.isSchedulingEnabled?.() ?? true;
    if (!schedulingEnabled) return;
    const freeSlots = Math.max(0, maxConcurrent - runtime.runningCount());
    if (freeSlots > 0) {
      const queued = jobService.listJobsByStatus("queued");
      for (const job of queued.slice(0, freeSlots)) {
        // runJob 内部 claim 失败会静默返回（并发安全），无需额外处理
        void runtime.runJob(job.id);
      }
    }

    // 3. 投递：pending Continuation 按 chat 分组交给主 Agent 队列（调用方去重）
    if (this.options.onContinuations) {
      const byChat = new Map<string, string[]>();
      for (const continuation of jobService.listPendingContinuations()) {
        const list = byChat.get(continuation.chatId) ?? [];
        list.push(continuation.id);
        byChat.set(continuation.chatId, list);
      }
      for (const [chatId, ids] of byChat) {
        this.options.onContinuations(chatId, ids);
      }
    }
  }
}
