/**
 * WorkerRuntime：一个 Job 的完整生命周期执行（方案 §7.4）。
 *
 * 第一版：认领 Job → 创建独立 backend session → 组装 Worker 上下文 →
 * 执行到结束 → 收集结果提交 JobService（终态自动生成去重 Continuation）→
 * 关闭并归档 session。不做 Attempt、Session 复用和追加指令。
 */

import { randomUUID } from "node:crypto";

import type { AgentBackend, AgentSession, SessionConfig } from "../agent/types.js";
import { createLogger } from "../logger.js";
import { terminateSpawnedProcessTree, waitForProcessExit } from "../platform/process.js";
import type { Job, JobExecutionRecord, JobService } from "./types.js";
import { WorkerProfileRegistry } from "./profiles.js";

const log = createLogger("worker-runtime");

export interface RunningJobExecution {
  jobId: string;
  session: AgentSession;
  startedAt: number;
  lastActivity: number;
  /** 用于取消的信号；取消后等待 backend 进程树真实退出 */
  controller: AbortController;
}

export interface WorkerRuntimeOptions {
  backend: AgentBackend;
  jobService: JobService;
  registry: WorkerProfileRegistry;
  /**
   * Worker session 的基础配置（dbPath/botId/platform 等；chatId 和
   * workingDirectory 按 Job 动态填充，来自 Work 的来源会话）
   */
  sessionConfig: Omit<SessionConfig, "workingDirectory" | "chatId">;
  /** Job 上下文组装（由 Pipeline 注入：stable context + profile + job prompt） */
  buildPrompt: (job: Job, profilePrompt: string) => string | Promise<string>;
}

export class WorkerRuntime {
  private readonly running = new Map<string, RunningJobExecution>();

  constructor(private readonly options: WorkerRuntimeOptions) {}

  /** 当前运行中的 Job 数 */
  runningCount(): number {
    return this.running.size;
  }

  /** 当前运行中的 Job ID 列表（watchdog 用） */
  inspectAll(): string[] {
    return [...this.running.keys()];
  }

  inspect(jobId: string): RunningJobExecution | undefined {
    return this.running.get(jobId);
  }

  /**
   * 取消：温和终止进程树 → 等待退出确认 → 超时后强制 SIGKILL。
   * 真实退出由 sendMessage 的 cancelled 结果最终确认（终态由确认后提交）。
   */
  async cancel(jobId: string, reason: string): Promise<boolean> {
    const exec = this.running.get(jobId);
    if (!exec) return false;
    const { jobService, backend } = this.options;
    const job = jobService.getJob(jobId);
    const workId = job?.workId ?? "";
    jobService.recordEvent({ workId, jobId, event: "job_cancel_requested", detail: reason });
    exec.controller.abort();

    try {
      await backend.cancelSession(exec.session);
    } catch (err) {
      jobService.recordEvent({ workId, jobId, event: "job_failed", detail: `cancel failed: ${String(err)}` });
      return false;
    }

    // 进程身份：从 backend activity 读取 PID，等待真实退出，超时升级强制终止
    const activity = (backend as { getActivity?: (id: string) => { pid?: number } | undefined }).getActivity?.(
      exec.session.id,
    );
    const pid = activity?.pid;
    if (pid) {
      const exited = await waitForProcessExit(pid, 10_000);
      if (!exited) {
        log.warn("worker job did not exit after graceful cancel, forcing kill", { jobId, pid });
        terminateSpawnedProcessTree(pid, true);
        jobService.recordEvent({ workId, jobId, event: "job_cancel_requested", detail: `force kill pid=${pid}` });
      }
    }
    return true;
  }

  /** 执行一个 Job（认领成功后调用，直到终态）。 */
  async runJob(jobId: string): Promise<void> {
    const { jobService, backend, registry, sessionConfig, buildPrompt } = this.options;
    const claimToken = randomUUID();

    const claim = jobService.claimJob({ jobId, claimToken });
    if (!claim.ok) {
      // 已被并发认领或 Work 已结束，静默跳过
      return;
    }
    const job: Job = claim.job;
    const profile = registry.get(job.workerProfileId);
    if (!profile) {
      jobService.failJob(jobId, {
        status: "failed",
        responseText: "",
        error: `unknown worker profile: ${job.workerProfileId}`,
        changedFiles: [],
        artifacts: [],
        startedAt: job.startedAt ?? new Date().toISOString(),
        endedAt: new Date().toISOString(),
      });
      return;
    }

    let session: AgentSession | undefined;
    const controller = new AbortController();
    const startedAt = Date.now();
    const work = jobService.getWork(job.workId);
    try {
      session = await backend.createSession({
        ...sessionConfig,
        chatId: work?.sourceChatId,
        workingDirectory: job.workdir,
        importantContext: profile.prompt,
      });
      this.running.set(jobId, {
        jobId,
        session,
        startedAt,
        lastActivity: startedAt,
        controller,
      });

      const prompt = await buildPrompt(job, profile.prompt);

      // 活动心跳：watchdog 依据 lastActivity 判断"无输出超时"（backend 不支持时跳过）
      const heartbeat = setInterval(() => {
        const getActivity = (backend as { getActivity?: (id: string) => { lastActiveAt: number } | undefined }).getActivity;
        const activity = getActivity?.(session!.id);
        if (activity) {
          const exec = this.running.get(jobId);
          if (exec) exec.lastActivity = Math.max(exec.lastActivity, activity.lastActiveAt);
        }
      }, 30_000);

      let response;
      try {
        response = await backend.sendMessage(session, prompt);
      } finally {
        clearInterval(heartbeat);
      }

      const record: JobExecutionRecord = {
        status: response.cancelled ? "cancelled" : "completed",
        responseText: response.text,
        backendSessionId: backend.getAgentSessionId?.(session.id),
        changedFiles: response.filesChanged ?? [],
        artifacts: [],
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date().toISOString(),
      };

      if (response.cancelled) {
        // 取消确认：Job 处于 cancelling 才允许终态
        jobService.confirmCancelled(jobId, record);
      } else {
        jobService.completeJob(jobId, record);
      }
    } catch (err) {
      const record: JobExecutionRecord = {
        status: "failed",
        responseText: "",
        error: String(err),
        changedFiles: [],
        artifacts: [],
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date().toISOString(),
      };
      jobService.failJob(jobId, record);
    } finally {
      this.running.delete(jobId);
      if (session) {
        try {
          backend.closeSession?.(session);
        } catch {
          // session 清理失败不阻断主流程
        }
      }
    }
  }
}
