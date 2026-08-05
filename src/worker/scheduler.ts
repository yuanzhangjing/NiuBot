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

const log = createLogger("worker-scheduler");

export const JOB_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const JOB_WALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** cancelling 状态无进展（进程未确认退出）超过该时间后强制终态 */
export const JOB_CANCEL_CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Continuation 认领悬挂超时：必须长于主会话 2 小时硬超时，避免正常长验收被并发重投。
 * 进程重启会立即 resetClaimedContinuations，不依赖此兜底。
 */
export const CLAIMED_CONTINUATION_STALE_MS = 150 * 60 * 1000;
/** DB running 但 Runtime 无执行（进程丢失/确认链路断裂）超过该时间后强制打断 */
export const JOB_ORPHAN_TIMEOUT_MS = 30 * 60 * 1000;
/** pending Continuation 停留超时（投递失效）告警阈值 */
export const PENDING_CONTINUATION_STALE_MS = 15 * 60 * 1000;

export interface WorkerSchedulerOptions {
  runtime: WorkerRuntime;
  jobService: JobService;
  /** 全局并发上限（防失控，不是业务编排规则） */
  maxConcurrent: number;
  tickMs?: number;
  /** pending Continuation 投递回调（Pipeline 提供：入队主 Agent 队列，内存去重） */
  onContinuations?: (chatId: string, continuationIds: string[]) => void;
  /** 是否允许调度新 Job（/worker off 时返回 false；watchdog 和投递继续） */
  isSchedulingEnabled?: () => boolean;
}

export class WorkerScheduler {
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** tick 防重入：异步 tick（含 runtime.cancel 等待）未完成时，后续 tick 直接跳过 */
  private tickInFlight = false;
  /** tick 执行期间收到 kick 时记账，当前 tick 结束后立即再跑一次。 */
  private kickPending = false;

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
    if (this.tickInFlight) {
      this.kickPending = true;
      return;
    }
    void this.tickSafely();
  }

  private async tickSafely(): Promise<void> {
    // tick 防重入：上一轮尚未完成（可能正在等待进程退出）时跳过本轮，避免并发重复取消/调度
    if (this.tickInFlight) {
      log.debug("worker scheduler tick skipped, previous tick in flight", { tickMs: this.tickMs });
      return;
    }
    this.tickInFlight = true;
    try {
      await this.tick();
    } catch (err) {
      log.error("worker scheduler tick failed", { error: String(err) });
    } finally {
      this.tickInFlight = false;
      if (this.kickPending) {
        this.kickPending = false;
        void this.tickSafely();
      }
    }
  }

  private async tick(): Promise<void> {
    const { runtime, jobService, maxConcurrent } = this.options;

    // 0b. claimed 超时兜底：主 Agent 回合进程被杀等导致认领悬挂 → 重置 pending 重新投递
    const staleClaimed = this.options.jobService.resetStaleClaimedContinuations(
      Math.floor(CLAIMED_CONTINUATION_STALE_MS / 60_000),
    );
    if (staleClaimed > 0) {
      log.warn("stale claimed continuations reset for redelivery", { count: staleClaimed });
    }

    // 1. 投递：pending Continuation 按 chat 分组交给主 Agent 队列（调用方去重）。
    // 放在 tick 最前：即使后续（取消等待等）慢操作阻塞 tick 防重入，投递也不受影响。
    if (this.options.onContinuations) {
      const now = Date.now();
      for (const continuation of jobService.listPendingContinuations()) {
        const createdAt = parseUtcDatetime(continuation.createdAt);
        if (createdAt !== undefined && now - createdAt > PENDING_CONTINUATION_STALE_MS) {
          log.warn("pending continuation has been undelivered for a long time", {
            continuationId: continuation.id,
            workId: continuation.workId,
          });
        }
      }
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

    // 2. 孤儿 Job 兜底：DB running 但 Runtime 无执行（进程丢失/确认链路断裂、
    // 重启后未恢复）→ 超时强制打断，防止「运行中」永远残留。
    const now = Date.now();
    for (const job of jobService.listJobsByStatus("running")) {
      if (runtime.inspect(job.id)) continue;
      if (runtime.hasInFlight(job.id)) continue;
      const updatedAt = parseUtcDatetime(job.updatedAt);
      if (updatedAt === undefined || now - updatedAt <= JOB_ORPHAN_TIMEOUT_MS) continue;
      log.warn("orphaned running job interrupted (no runtime execution)", { jobId: job.id, workId: job.workId });
      jobService.interruptJob(job.id, "execution lost: no runtime execution found");
    }

    // 3. watchdog：超时运行中 Job 强制取消（不阻塞 tick，取消在后台完成）
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
        void runtime.cancel(jobId, idleMs > JOB_IDLE_TIMEOUT_MS ? "idle_timeout" : "wall_timeout");
      }
    }

    // 4. cancelling 处理：用户取消（requestCancel/cancelWork）只改 DB 状态，
    // 这里把“取消意图”转化为实际进程取消。不等 10 分钟兜底。
    // - running 且有 runtime exec → 立即 runtime.cancel（幂等，后台完成）
    // - 准备阶段（inFlight）→ 已通过 cancel abort，交给 runJob 收敛，跳过
    // - queued（从未启动，无 startedAt）→ 直接确认终态
    // - running 但 runtime 已丢（Engine 重启等）→ 超时兜底确认
    for (const job of jobService.listJobsByStatus("cancelling")) {
      const exec = runtime.inspect(job.id);
      const inFlight = !exec && runtime.hasInFlight(job.id);
      if (exec) {
        // 有活动进程：立即取消（幂等，重复 tick 复用同一个 cancel Promise）
        void runtime.cancel(job.id, "user_cancel");
        continue;
      }
      if (inFlight) {
        // 准备阶段：abort 准备流程，runJob 将在检查点收敛为 cancelled。
        // 不立即确认（runJob 正在收敛）；runJob 卡在准备阶段（backend 挂起）时走下方超时兜底。
        void runtime.cancel(job.id, "user_cancel");
      }
      const updatedAt = job.updatedAt.replace(" ", "T") + "Z";
      const cancelDeadline = new Date(Date.now() - JOB_CANCEL_CONFIRM_TIMEOUT_MS).toISOString();
      if (!job.startedAt && !inFlight) {
        // 从未启动（queued 阶段被取消）且不在准备中：没有进程，直接确认终态
        const ok = jobService.confirmCancelled(job.id, {
          status: "cancelled",
          responseText: "",
          error: "cancelled before execution",
          changedFiles: [],
          artifacts: [],
          startedAt: job.startedAt ?? new Date().toISOString(),
          endedAt: new Date().toISOString(),
        });
        if (ok) {
          log.info("worker job cancelled before execution", { jobId: job.id });
        }
      } else if (updatedAt < cancelDeadline) {
        // 已启动但 runtime 丢失（Engine 重启等）：超时兜底确认终态
        log.warn("worker job cancel confirmation timed out, forcing terminal state", { jobId: job.id });
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
      // 已启动且有 startedAt、runtime 暂时不在（进程刚退出，sendMessage 正要确认）→ 交给 sendMessage 的 cancelled 结果确认
    }

    // 5. 依赖失败传播：queued Job 的任一依赖已失败/中断/取消 → 本 Job 自动失败。
    // 依赖 queued/running 是正常等待态，不判失败（running 是调度中常见中间态）。
    for (const job of jobService.listJobsByStatus("queued")) {
      const failedDep = job.dependsOn.find((depId) => {
        const dep = jobService.getJob(depId);
        return dep && dep.status !== "completed" && dep.status !== "queued" && dep.status !== "running";
      });
      if (failedDep) {
        jobService.failQueuedJob(job.id, `dependency ${failedDep} not completed`);
        log.warn("worker job failed due to dependency", { jobId: job.id, failedDep });
      }
    }

    // 6. 调度：/worker off 时不认领新 Job（running 继续，watchdog 和投递不受影响）
    const schedulingEnabled = this.options.isSchedulingEnabled?.() ?? true;
    if (!schedulingEnabled) return;
    const freeSlots = Math.max(0, maxConcurrent - runtime.runningCount());
    if (freeSlots > 0) {
      const queued = jobService.listJobsByStatus("queued");
      for (const job of queued.slice(0, freeSlots)) {
        // runJob 内部 claim 失败会静默返回（并发安全），无需额外处理
        void runtime.runJob(job.id).finally(() => {
          const status = jobService.getJob(job.id)?.status;
          if (status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled") {
            this.kick();
          }
        });
      }
    }
  }
}

function parseUtcDatetime(value: string): number | undefined {
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
