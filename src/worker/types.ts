/**
 * NiuBot Worker — Work / Job / Continuation 类型与状态常量。
 *
 * 第一版（最小 Job 模型）：
 * - Work 是用户需求层的薄分组，不做复杂调度；
 * - Job = 给一个 Worker 的一个明确 Prompt + 一个工作目录 + 一次独立 backend session，
 *   直到这次调用结束；没有 Attempt、自动重试、Session 复用和追加指令。
 *
 * 对应方案：tasks/NiuBot 内部 Worker/worker-runtime-design.md（v3.1）。
 */

export type WorkStatus =
  | "active"
  | "completing"
  | "completed"
  | "failing"
  | "failed"
  | "cancelling"
  | "cancelled";

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelling"
  | "cancelled";

/** 终态判断；interrupted 是崩溃恢复专用的失败终态，语义与 failed 分开只用于诊断。 */
export const WORK_TERMINAL_STATUSES: readonly WorkStatus[] = ["completed", "failed", "cancelled"];
export const JOB_TERMINAL_STATUSES: readonly JobStatus[] = [
  "completed",
  "failed",
  "interrupted",
  "cancelled",
];

export type WorkVisibility = "private" | "public";

/** 工作空间策略（§12）：read_only 直接访问目标目录；scratch 独立临时目录；git_worktree 独立 worktree。 */
export type WorkspacePolicy = "read_only" | "scratch" | "git_worktree";

export interface ArtifactEntry {
  kind: string;
  relativePath: string;
}

export interface Work {
  id: string;
  botId: string;
  ownerUserId: string;
  sourceChatId: string;
  visibility: WorkVisibility;
  /** 用户原始需求 */
  request: string;
  /** 触发本 Work 的用户消息平台侧 ID（验收回合回复引用原始问题时用） */
  triggerMsgPlatformId?: string;
  status: WorkStatus;
  /** 关联 Job ID，按创建顺序 */
  jobIds: string[];
  /** 主 Agent 验收后的最终结论（终态时填写） */
  finalConclusion?: string;
  /** 因重启/崩溃产生 interrupted 的累计次数，达到上限后 Work 直接 failed（防静默循环） */
  interruptedCount: number;
  /** 连续失败次数（Job failed 时 +1，completed 时清零；达到上限 Work 直接 failed） */
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
  /** CAS 乐观锁版本号 */
  version: number;
}

export interface Job {
  id: string;
  workId: string;
  /** 绑定的 Worker Profile ID */
  workerProfileId: string;
  /**
   * Profile / Skill 快照（Phase 2 起由 WorkerRuntime 在启动时固化；第一版先记录 profileId）。
   * 以 JSON 字符串存储，结构按需演进，不参与状态机。
   */
  profileSnapshotJson: string | null;
  /** 给 Worker 的明确 Prompt（含完成标准和必要上下文） */
  prompt: string;
  /** 工作目录（同一 Work 的后续 Job 复用同一工作区） */
  workdir: string;
  backendSessionId?: string;
  status: JobStatus;
  /** Worker 最终文本（自由 Markdown） */
  responseText?: string;
  exitCode?: number;
  error?: string;
  changedFilesJson: string;
  artifactsJson: string;
  startedAt?: string;
  endedAt?: string;
  /** 调度认领令牌（fencing），Phase 2 起用于确认结果提交者是最新持有者 */
  claimToken?: string;
  claimedAt?: string;
  workspacePolicy: WorkspacePolicy;
  /** 依赖的 Job ID（全部 completed 后才能被认领；任一依赖 failed 则本 Job 自动 failed） */
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** Worker 执行结束后 Runtime 生成的客观执行记录（§5.5）。 */
export type JobExecutionStatus = "completed" | "failed" | "cancelled" | "interrupted";

export interface JobExecutionRecord {
  status: JobExecutionStatus;
  responseText: string;
  backendSessionId?: string;
  exitCode?: number;
  error?: string;
  changedFiles: string[];
  artifacts: ArtifactEntry[];
  startedAt: string;
  endedAt: string;
}

export type ContinuationStatus = "pending" | "claimed" | "completed" | "failed";

/**
 * Continuation：内部续接事件，用来重新唤醒主 Agent。
 * 不是用户消息，也不是 Worker 的用户可见回复。
 */
export interface AgentContinuation {
  id: string;
  botId: string;
  chatId: string;
  /** 稳定去重键，例如 work:<work-id>:job:<job-id>:terminal */
  dedupeKey: string;
  kind: "job_terminal";
  workId: string;
  /** 本 Continuation 覆盖的 Job（合并验收时多个 Job 共用一个去重键？不——每 Job 一个键，批量认领） */
  jobIds: string[];
  /** 触发消息平台侧 ID（来自 Work，验收回合回复引用原始问题） */
  triggerMsgPlatformId?: string;
  status: ContinuationStatus;
  /** 主 Agent 回合标识，重跑时注入已执行动作用于幂等 */
  agentTurnId?: string;
  /** 认领令牌：主 Agent 回合处理中 */
  claimToken?: string;
  claimedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export type WorkerEventName =
  | "work_created"
  | "job_created"
  | "job_claimed"
  | "job_completed"
  | "job_failed"
  | "job_interrupted"
  | "job_cancel_requested"
  | "job_cancelled"
  | "work_completed"
  | "work_failed"
  | "work_cancelled"
  | "continuation_created"
  | "continuation_completed";

export interface WorkerEvent {
  id: number;
  botId: string;
  workId: string;
  jobId?: string;
  event: WorkerEventName;
  detail?: string;
  createdAt: string;
}

/** 达到该次数后 Work 直接 failed（§14 interrupted 计数上限） */
export const MAX_WORK_INTERRUPTED_COUNT = 3;

/** 同一 Work 生命周期内累计 Job 上限（内部防失控，不作为用户配置） */
export const MAX_JOBS_PER_WORK = 10;

export interface CreateWorkInput {
  botId: string;
  ownerUserId: string;
  sourceChatId: string;
  visibility: WorkVisibility;
  request: string;
  /** 触发本 Work 的用户消息平台侧 ID（验收回合回复引用用） */
  triggerMsgPlatformId?: string;
}

export interface CreateJobInput {
  workId: string;
  workerProfileId: string;
  prompt: string;
  /** 目标目录（git_worktree 时为目标 repo 路径；scratch 时忽略） */
  workdir: string;
  workspacePolicy?: WorkspacePolicy;
  /** 依赖的 Job ID（同一 Work 内；全部完成后本 Job 才能执行） */
  dependsOn?: string[];
}

export interface ClaimJobInput {
  jobId: string;
  /** Phase 2 的 fencing token / lease 标识，第一版由调度方传入唯一值即可 */
  claimToken: string;
}

export type ClaimJobResult =
  | { ok: true; job: Job }
  | { ok: false; reason: "not_queued" | "work_not_active" | "job_limit_reached" | "dependencies_pending" };

export interface CompleteWorkInput {
  conclusion: string;
}

/**
 * JobService 是 Worker 状态的唯一写入口（§7.2）。
 * 第一版接口：状态机、CAS、幂等、事件记录、Continuation 去重认领。
 * 调度（Scheduler）、执行（WorkerRuntime）和 CLI 是 Phase 2 的内容，不在此接口内。
 */
export interface JobService {
  createWork(input: CreateWorkInput): Work;
  getWork(workId: string): Work | undefined;
  listWorks(query: { botId: string; ownerUserId?: string; status?: WorkStatus }): Work[];
  /** 幂等键由 CLI 层派生（agent_turn_id + 命令 + 规范化参数 hash）；相同键返回原 Job */
  createJob(input: CreateJobInput, idempotencyKey?: string): Job;
  getJob(jobId: string): Job | undefined;
  listJobs(workId: string): Job[];
  listJobsByStatus(status: JobStatus): Job[];

  /** queued → running（CAS），并检查 Work 状态与 Job 上限 */
  claimJob(input: ClaimJobInput): ClaimJobResult;
  /** running → completed */
  completeJob(jobId: string, record: JobExecutionRecord): Job | undefined;
  /** running → failed */
  failJob(jobId: string, record: JobExecutionRecord): Job | undefined;
  /** running → interrupted（崩溃恢复专用） */
  interruptJob(jobId: string): Job | undefined;
  /** queued Job 因依赖失败直接终态（不经过执行；连续失败预算照常累计） */
  failQueuedJob(jobId: string, error: string): Job | undefined;
  /** queued/running → cancelling */
  requestCancel(jobId: string): Job | undefined;
  /** cancelling → cancelled（确认进程真实退出后） */
  confirmCancelled(jobId: string, record: JobExecutionRecord): Job | undefined;

  /** 用户取消整个 Work：所有非终态 Job 进入 cancelling，Work → cancelling */
  cancelWork(workId: string): Work | undefined;
  /** 主 Agent 验收完成（仅 Work 处于 active/cancelling 且所有 Job 终态时允许） */
  completeWork(workId: string, input: CompleteWorkInput): Work | undefined;
  /** 主 Agent 判定无法继续 */
  failWork(workId: string, reason: string): Work | undefined;

  /** Job 终态后创建去重 Continuation（每 Job 一个去重键） */
  createJobTerminalContinuation(jobId: string): AgentContinuation | undefined;
  getContinuation(id: string): AgentContinuation | undefined;
  /** 全部待处理 Continuation（Scheduler 投递扫描用） */
  listPendingContinuations(): AgentContinuation[];
  /** 批量认领某 chat 的待处理 Continuation（同一 Work 合并成一次验收） */
  claimContinuations(chatId: string, claimToken: string): AgentContinuation[];
  /** 投递时认领单个 Continuation（pending → claimed；超限时标记 failed 不再投递） */
  claimContinuation(id: string, claimToken: string): boolean;
  /** 主 Agent 回合失败/取消后释放认领（claimed → pending，允许重新投递） */
  releaseContinuationClaim(id: string): boolean;
  /** claimed 超时兜底：超过阈值分钟未完成（进程被杀等）→ 重置 pending */
  resetStaleClaimedContinuations(staleMinutes: number): number;
  /** 主 Agent 回合事务提交后标记完成 */
  markContinuationCompleted(id: string, agentTurnId: string): void;
  /** 重启恢复：claimed Continuation 重置为 pending（§7.5 重新投递） */
  resetClaimedContinuations(): number;

  recordEvent(event: Omit<WorkerEvent, "id" | "createdAt" | "botId">): void;
  listEvents(workId: string): WorkerEvent[];
}
