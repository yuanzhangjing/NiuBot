/**
 * WorkerRuntime：一个 Job 的完整生命周期执行（方案 §7.4）。
 *
 * 第一版：认领 Job → 创建独立 backend session → 组装 Worker 上下文 →
 * 执行到结束 → 收集结果提交 JobService（终态自动生成去重 Continuation）→
 * 关闭并归档 session。不做 Attempt、Session 复用和追加指令。
 */

import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { AgentBackend, AgentSession, SessionConfig } from "../agent/types.js";
import { createLogger } from "../logger.js";
import { terminateSpawnedProcessTree, waitForProcessExit } from "../platform/process.js";
import type { ArtifactEntry, Job, JobExecutionRecord, JobService } from "./types.js";
import { WorkerProfileRegistry } from "./profiles.js";
import { WORKER_MARKER_FILENAME, WorkspaceProvider, type PreparedWorkspace } from "./workspace.js";
import { ResourceLeaseManager } from "./lease.js";
import { SkillResolver } from "./skills.js";

const log = createLogger("worker-runtime");

/** 收集产物目录下的文件列表（排除 marker，递归收集相对路径）。 */
function collectArtifacts(artifactDir?: string): ArtifactEntry[] {
  if (!artifactDir) return [];
  const entries: ArtifactEntry[] = [];
  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === WORKER_MARKER_FILENAME) continue;
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(full, rel);
      else entries.push({ kind: "file", relativePath: rel });
    }
  };
  walk(artifactDir, "");
  return entries;
}

export interface RunningJobExecution {
  jobId: string;
  session: AgentSession;
  /** 本 Job 实际使用的 backend（角色可配置专属 backend） */
  backend: AgentBackend;
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
  /** Job 上下文组装（由 Pipeline 注入：stable context + job prompt + 实际执行目录 + 产物目录；角色内容已在 system prompt） */
  buildPrompt: (job: Job, execDir: string, artifactDir?: string) => string | Promise<string>;
  /** 工作区准备（read_only Job 可不提供） */
  workspaceProvider?: WorkspaceProvider;
  /** 写任务资源互斥（git_worktree Job 必须提供） */
  leaseManager?: ResourceLeaseManager;
  /** Skill 校验（Phase 5；默认内置 resolver） */
  skillResolver?: SkillResolver;
  /** 按类型解析专属 backend（角色配置 backend 时使用；未配置则用 options.backend） */
  resolveBackend?: (type: string) => Promise<AgentBackend> | AgentBackend;
}

export class WorkerRuntime {
  private readonly running = new Map<string, RunningJobExecution>();

  constructor(private readonly options: WorkerRuntimeOptions) {}

  /** 当前运行中的 Job 数 */
  runningCount(): number {
    return this.running.size;
  }

  /**
   * 解析 Job 使用的 backend：profile 配置了类型时按类型解析，否则复用主 Agent backend。
   * 实例缓存/去重由 resolveBackend 实现（index 的 getOrCreateBackend 已按类型单例 + single-flight）。
   */
  private async resolveJobBackend(backendType?: string): Promise<AgentBackend> {
    if (!backendType || !this.options.resolveBackend) return this.options.backend;
    return await this.options.resolveBackend(backendType);
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
    const { jobService } = this.options;
    const job = jobService.getJob(jobId);
    const workId = job?.workId ?? "";
    jobService.recordEvent({ workId, jobId, event: "job_cancel_requested", detail: reason });
    exec.controller.abort();

    try {
      await exec.backend.cancelSession(exec.session);
    } catch (err) {
      jobService.recordEvent({ workId, jobId, event: "job_failed", detail: `cancel failed: ${String(err)}` });
      return false;
    }

    // 进程身份：从 backend activity 读取 PID，等待真实退出，超时升级强制终止
    const getActivity = (exec.backend as unknown as {
      getActivity?: (id: string) => { pid?: number } | undefined;
    }).getActivity;
    const activity = getActivity?.call(exec.backend, exec.session.id);
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
    // Skill 校验（§11）：required skill 缺失或引用未知 skill 时拒绝执行
    const skillResult = (this.options.skillResolver ?? new SkillResolver()).resolve(profile.id, profile.skills);
    if (!skillResult.ok) {
      jobService.failJob(jobId, {
        status: "failed",
        responseText: "",
        error: skillResult.error,
        changedFiles: [],
        artifacts: [],
        startedAt: job.startedAt ?? new Date().toISOString(),
        endedAt: new Date().toISOString(),
      });
      return;
    }

    let session: AgentSession | undefined;
    let jobBackend: AgentBackend | undefined;
    let prepared: PreparedWorkspace | undefined;
    let leaseHeld = false;
    const controller = new AbortController();
    const startedAt = Date.now();
    const work = jobService.getWork(job.workId);
    try {
      // 先解析 backend（冷解析可能耗时秒级），再准备工作区——避免解析期间占用 repo 写租约
      try {
        jobBackend = await this.resolveJobBackend(profile.backend);
      } catch (err) {
        // 错误带角色上下文，便于定位配置问题
        throw new Error(`profile ${profile.id} 的 backend 解析失败: ${String(err)}`);
      }
      // 解析期间用户可能已取消：job 已进入 cancelling 则放弃执行（确认终态由 cancel 流程负责）
      if (jobService.getJob(jobId)?.status === "cancelling") {
        return;
      }

      // 工作区准备（§12）：read_only 直接用目标目录；scratch/git_worktree 由 Runtime 管理
      const { workspaceProvider, leaseManager } = this.options;
      if (job.workspacePolicy === "read_only" || !workspaceProvider) {
        prepared = await workspaceProvider?.prepare(job.id, job.workspacePolicy, job.workdir)
          ?? { execDir: job.workdir, managed: false };
      } else {
        prepared = await workspaceProvider.prepare(job.id, job.workspacePolicy, job.workdir);
        if (prepared.repoPath && leaseManager) {
          const lease = leaseManager.acquire(`repo-write:${prepared.repoPath}`, job.id);
          if (!lease.ok) {
            jobService.failJob(jobId, {
              status: "failed",
              responseText: "",
              error: `resource busy: repo ${prepared.repoPath} held by job ${lease.holderJobId}`,
              changedFiles: [],
              artifacts: [],
              startedAt: new Date(startedAt).toISOString(),
              endedAt: new Date().toISOString(),
            });
            return;
          }
          leaseHeld = true;
        }
      }

      // 角色完整内容（定义 + 原则 + 工作流）作为 system prompt 注入，静态固定；
      // user prompt 只装任务详情（由 buildPrompt 组装）
      const importantContext = [profile.prompt, profile.principles, profile.workflow].filter(Boolean).join("\n\n");
      session = await jobBackend.createSession({
        ...sessionConfig,
        chatId: work?.sourceChatId,
        workingDirectory: prepared.execDir,
        importantContext,
        model: profile.model ?? sessionConfig.model,
      });
      this.running.set(jobId, {
        jobId,
        session,
        backend: jobBackend,
        startedAt,
        lastActivity: startedAt,
        controller,
      });

      const prompt = await buildPrompt(job, prepared.execDir, prepared.artifactDir);

      // 活动心跳：watchdog 依据 lastActivity 判断"无输出超时"（backend 不支持时跳过）
      const getActivity = (jobBackend as unknown as {
        getActivity?: (id: string) => { lastActiveAt: number } | undefined;
      }).getActivity;
      const heartbeat = setInterval(() => {
        const activity = getActivity?.call(jobBackend, session!.id);
        if (activity) {
          const exec = this.running.get(jobId);
          if (exec) exec.lastActivity = Math.max(exec.lastActivity, activity.lastActiveAt);
        }
      }, 30_000);

      let response;
      try {
        response = await jobBackend.sendMessage(session, prompt);
      } finally {
        clearInterval(heartbeat);
      }

      const record: JobExecutionRecord = {
        status: response.cancelled ? "cancelled" : "completed",
        responseText: response.text,
        backendSessionId: jobBackend.getAgentSessionId?.(session.id),
        changedFiles: response.filesChanged ?? [],
        artifacts: collectArtifacts(prepared.artifactDir),
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
      if (session && jobBackend) {
        try {
          jobBackend.closeSession?.(session);
        } catch {
          // session 清理失败不阻断主流程
        }
      }
      // 释放写租约（工作区保留，marker 标记来源，不自动删除）
      if (leaseHeld) {
        this.options.leaseManager?.release(jobId);
      }
    }
  }
}
