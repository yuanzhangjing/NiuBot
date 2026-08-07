import { randomUUID } from "node:crypto";
import { exec, execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { escapeYamlContent, renderMessageNodes } from "../im/render.js";
import { findLatestUserPlatformMsgId } from "../messages/store.js";
import type { InboundDelivery, NormalizedMessage, TransportClient } from "../transport/types.js";
import { ERROR_DISPLAY_MAX_LEN } from "../agent/types.js";
import { AgentSessionNotStartedError, type AgentBackend, type AgentResponse, type AgentSession, type AgentSessionActivity, type SessionConfig } from "../agent/types.js";
import { CliAgentBackend, buildNiubotEnv } from "../agent/cli-base.js";
import { BUILTIN_BACKEND_LIST, NIUBOT_HOME, normalizeBackend, type AgentBackendType, type RestartConfig } from "../config.js";
import { ChatManager } from "./chat-manager.js";
import type { QueuedMessage } from "./queue.js";
import { WorkerRuntime } from "../worker/runtime.js";
import { WorkerScheduler } from "../worker/scheduler.js";

import { stripInternalWorkerTags } from "../worker/redact.js";
import { WorkspaceProvider } from "../worker/workspace.js";
import type { Job, JobService, Work } from "../worker/types.js";
import { WorkerProfileRegistry, teamProfileToWorkerProfile, type WorkerProfile } from "../worker/profiles.js";
import { TeamConfigStore, type TeamConfig } from "../worker/team-config.js";
import type {
  WorkerAgentCommandRequest,
  WorkerAgentCommandResult,
} from "../worker/agent-command.js";
import {
  ensureUser, ensureChat, storeMessage, updateChatName,
  getUserShortLabel, getChatShortLabel, getMessageByPlatformId, updateMessageContent, updateMessagePlatformId,
  setUserAdminRole, getAdminUserIds, getUserAdminRole, type AdminRole,
  getBotBackendModelState, setBotBackendModelState, setBotRuntimeState, clearBotRuntimeModels,
  hasUpdateNotification, recordUpdateNotification,
  getRecentRuntimeEvents,
  markUnfinishedRuntimeRunsFailedByRestart,
  recordRuntimeEvent,
} from "../database/schema.js";
import { isNewerPackageVersion, isPrereleaseOrUnrecognizedVersion } from "../version.js";
import {
  buildActiveTaskContext,
  buildImportantContext,
  buildNormalContext,
  buildSessionArchiveContext,
  buildSpeakerContext,
  buildStableSystemContext,
  COMPACT_RECOVERY_REMINDER,
  NEW_SESSION_SEARCH_REMINDER,
  WORKER_DISABLED_REMINDER,
  type SceneInfo,
  type SpeakerInfo,
  type StableSystemContextOptions,
} from "../memory/inject.js";
import {
  dateTimeInTimeZone,
  formatLocalDateTimeWithTZ,
  isInLocalHourWindow,
  millisecondsUntilLocalHour,
  TZ,
  userDateTimeToUtcSql,
  utcDateTimeForSql,
} from "../tz.js";
import {
  addCronJob,
  CRON_FAILURE_LIMIT,
  deleteCronJobForAccess,
  describeCronExpr,
  describeCronSchedule,
  everyToCronExpr,
  getCronJob,
  listCronJobs,
} from "./cron.js";
import {
  addLoopJob,
  cancelLoopJobForAccess,
  completeLoopRun,
  formatLoopInterval,
  getLoopJob,
  listLoopJobs,
  releaseQueuedLoopJob,
  startLoopRun,
  type LoopJob,
} from "./loop.js";
import {
  parseScheduleAgentCommand,
  type ScheduleAgentCommand,
  type ScheduleAgentCommandResult,
} from "./schedule-command.js";
import { createLogger } from "../logger.js";
import {
  type ActiveGoal,
  type GoalFinishCommand,
  GOAL_DEFAULTS,
} from "./goal.js";
import { launchRestartWorker } from "../restart-launcher.js";
import {
  resolveExecutable,
  resolveNpmExecutableForNode,
  withNodeRuntimeOnPath,
} from "../platform/executable.js";
import { runCommand } from "../platform/command.js";
import type { BackendCapability } from "../agent/backend-capability.js";
import { buildResponseFooter } from "./footer.js";
import { ResponseSender } from "./response-sender.js";
import { withTimeout } from "./timeout.js";
import { RuntimeStateStore, type RunStage, type RuntimeStateEvent } from "./runtime-state.js";
import { RunManager, type RunAgentResult } from "./run-manager.js";
import { archiveAgentSession, getSessionArchiveDirectory } from "../session-archive/archive.js";
import { wrapInjectedUserMessage } from "../session-archive/native-transcript.js";

const execAsync = promisify(exec);

const PROCESSING_EMOJI = "Get";
const MERGED_EMOJI = "Pin";
const EMPTY_RESPONSE_FALLBACK = "（处理完成，但未生成回复。如果没收到预期结果，请重试）";
const UPDATE_CONFIRM_COMMAND = "/update 1";
const UPDATE_PACKAGE_NAME = "@yuanzhangjing/niubot";
/** /effort 可选级别（与 claude --effort 值域一致） */
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
/** 支持 effort 透传的内置 backend（CLI 能力静态声明；不支持的 backend 保存但不生效） */
const EFFORT_SUPPORTED_BACKENDS = new Set(["claude", "cursor-agent", "codex", "pi", "opencode", "traecli"]);
export const SHELL_COMMAND_TIMEOUT_MS = 300_000;

export function resolveUpdateCommandCwd(niubotHome: string, fallbackHome = os.homedir()): string {
  const candidates = [niubotHome, fallbackHome];
  try { candidates.push(process.cwd()); } catch { /* current directory may have been deleted */ }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    } catch { /* try the next stable directory */ }
  }
  throw new Error("No existing directory is available for the npm update check");
}

/** 过期消息阈值（ms）：超过 2 分钟的消息丢弃 */
const STALE_MESSAGE_THRESHOLD_MS = 2 * 60 * 1000;

/** 短词打断关键词 */
const INTERRUPT_WORDS = new Set([
  "停", "停下", "停止", "打住", "够了", "算了", "算了吧", "取消",
  "等等", "等一下", "稍等",
  "stop", "cancel", "abort",
]);

const BUILTIN_COMMANDS = new Set([
  "/restart", "/update", "/service", "/new", "/agent", "/model", "/effort",
  "/admin", "/help", "/stop", "/clear", "/flush", "/task", "/status", "/history",
  "/worker",
]);
const HYBRID_SCHEDULE_COMMANDS = new Set(["/loop", "/cron"]);
const SCHEDULE_BUILTIN_SUBCOMMANDS = new Set([
  "list", "ls", "help", "--help", "cancel", "stop", "del", "delete", "rm",
]);
/** /worker 本地管理子命令；其余参数视为派发任务（翻译转发给 Agent） */
const WORKER_BUILTIN_SUBCOMMANDS = new Set(["on", "off", "config"]);

/**
 * hybrid 创建命令翻译：用户命令 → 「任务原文 + nbt 命令建议」。
 * 返回 null 表示非创建命令（无需改写）。Agent 收到后自主决定执行或澄清（用户可能发错）。
 */
function rewriteHybridCreationCommand(text: string): string | null {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0]!.toLowerCase();
  const rest = parts.slice(1).join(" ").trim();
  if (!rest) return null;
  switch (cmd) {
    case "/goal":
      return `${rest}（用户要求进入 Goal 模式，请使用 nbt goal start）`;
    case "/worker":
      // 派发引导：Work + Job 两步由 Agent 回合内完成；任务与派工不匹配时以 Agent 判断为准
      return `${rest}（用户要求派发 Worker 任务。请按需拆分并派工：先 nbt worker work create 建需求，再用 nbt worker job create 派工；简单任务可直接自己做，不必强派 Worker）`;
    case "/loop":
      return `${rest}（用户要求创建循环任务，请使用 nbt schedule create --mode current_session）`;
    case "/cron":
      return `${rest}（用户要求创建定时任务，请使用 nbt schedule create --mode new_session）`;
    default:
      return null;
  }
}
// ── Watchdog 常量 ──
const AGENT_WATCHDOG_INTERVAL_MS = 15_000;     // 15 秒检测间隔
const AGENT_IDLE_THRESHOLD_MS = 600_000;       // 10 分钟：第一次 idle 通知
const AGENT_IDLE_THRESHOLD_2_MS = 1_800_000;   // 30 分钟：第二次 idle 通知
const AGENT_LONG_RUNNING_FIRST_NOTIFY_MS = 3_600_000;  // 1 小时：主会话长运行提醒
const AGENT_LONG_RUNNING_REPEAT_NOTIFY_MS = 3_600_000; // 1 小时：主会话长运行重复提醒
const AGENT_RUN_HARD_TIMEOUT_MS = 7_200_000;  // 2 小时：主会话 run 硬超时，无 completion 时强制中止（防进程挂起卡死队列）
const INDEPENDENT_IDLE_KILL_MS = 3_600_000;    // 1 小时：独立 session 无活动自动 kill
const INDEPENDENT_LONG_RUNNING_NOTIFY_MS = 3_600_000;  // 1 小时：独立 session 仍活跃时提醒
const UPDATE_CHECK_HOUR = 10;                  // 本地时间 10:00 检查 npm latest
const WORKER_DELIVERY_MARKER = "> ⚙️ 本回复基于 Worker 后台任务结果整理";
const WORKER_DISPATCH_MARKER = "> ⚙️ 已交由 Worker 后台执行";
const LOOP_TASK_PREVIEW_MAX_CHARS = 80;
const UPDATE_NOTIFY_END_HOUR = 18;             // 10:00-18:00 启动时允许立即通知
const STARTUP_PLATFORM_TIMEOUT_MS = 5_000;      // 平台启动探测超时后降级继续启动

/** 关闭阶段取消/关闭 backend session 的超时保护：后端卡住时不让 shutdown 永久阻塞。 */
function withShutdownTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

/** Engine 强制添加的 Loop 来源信息，不依赖模型自行说明。 */
function buildTaskPreview(prompt: string): string {
  const normalizedPrompt = stripInternalWorkerTags(prompt).replace(/\s+/g, " ").trim();
  const promptChars = Array.from(normalizedPrompt);
  return promptChars.length > LOOP_TASK_PREVIEW_MAX_CHARS
    ? `${promptChars.slice(0, LOOP_TASK_PREVIEW_MAX_CHARS).join("")}…`
    : normalizedPrompt || "（无任务描述）";
}

/** Loop 卡片标题：固定展示会话模式 + ID + 进度 + 频率。 */
function buildLoopCardHeader(job: LoopJob): string {
  const iteration = job.runCount + 1;
  const progress = job.maxTimes === null
    ? `第 ${iteration} 次`
    : `第 ${iteration}/${job.maxTimes} 次`;
  return `🔁 主会话 loop:${job.id} · ${progress} · 每 ${formatLoopInterval(job.intervalSeconds)}`;
}

/** Loop 任务内容引用（正文开头 2-3 行）。 */
function buildLoopTaskQuote(job: LoopJob): string {
  return `> 任务：${escapeLarkMarkdownText(buildTaskPreview(job.prompt))}`;
}

/** Loop 完整投递标记（标题行 + 任务引用），用于无卡片降级时的纯文本。 */
function buildLoopDeliveryMarker(job: LoopJob): string {
  return `> ${buildLoopCardHeader(job)}\n${buildLoopTaskQuote(job)}`;
}

/** Goal 卡片标题：固定展示目标来源 + 结局 + 轮次 + 耗时。 */
function buildGoalCardHeader(goal: ActiveGoal, elapsedMs: number): string {
  const outcomeLabel = goal.outcome === "achieved" ? "✅ 已达成"
    : goal.outcome === "not_achieved" ? "⛔ 未达成"
    : goal.outcome === "stopped" ? "🛑 已停止"
    : "❌ 失败";
  return `🎯 Goal ${outcomeLabel} · ${goal.turnCount} 轮 · ${formatUptime(elapsedMs)}`;
}

function formatLongRunningHours(runningMs: number): number {
  return Math.max(1, Math.round(runningMs / 3_600_000));
}

function formatOutputActivity(idleMs: number): string {
  const idleMin = Math.max(1, Math.round(idleMs / 60_000));
  if (idleMs <= AGENT_IDLE_THRESHOLD_MS) {
    return `输出状态：最近 ${idleMin} 分钟内有输出，按输出看任务还活跃。`;
  }
  return `输出状态：已经 ${idleMin} 分钟没有输出，按输出看任务不活跃，可能卡住。`;
}

function isUpdateConfirmedArg(arg?: string): boolean {
  const normalized = arg?.toLowerCase();
  return normalized === "1" || normalized === "confirm";
}

/** Bot 身份信息，由外部传入 */
export interface BotIdentity {
  /** Bot 显示名称（如 "CowBot"，从平台 API 获取或 config 指定） */
  name: string;
  /** IM 平台标识（如 "feishu"） */
  platform: string;
  /** Bot 在平台上的唯一标识（用于 DB 中的 bot 用户记录） */
  platformBotId: string;
  /** 主模型 ID（可选，覆盖 backend 默认值） */
  model?: string;
  /** 推理强度运行时选择（low/medium/high/xhigh/max），backend 支持时生效 */
  effort?: string;
}

interface ChatSession {
  agentSession: AgentSession;
  sessionId: string;
  platformChatId: string;
  userId: string;
  /** 触发消息的 platform msg ID（用于首条回复时引用） */
  triggerPlatformMsgId?: string;
  /** 是否已发送过回复（首条用 reply，后续用普通 send） */
  hasReplied: boolean;
}

interface RunningTask {
  agentSession: AgentSession;
  backend: AgentBackend;
  backendType: AgentBackendType;
  chatId: string;
  description: string;
  startedAt: number;
  source: "cron" | "task";
  cronJobId?: number;
  cronClaimToken?: string;
}

interface PendingTransitionMessage {
  msg: NormalizedMessage;
  inboxId?: number;
  claimToken?: string;
  recoveredMessageId?: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface ActiveWorkerAgentCommandContext {
  runId: string;
  userId: string;
  chatType: "p2p" | "group";
  continuationTurn: boolean;
  createdWorkIds: string[];
  /** 主会话能力令牌：请求必须携带同一令牌才能借用本回合身份 */
  token: string;
}

interface ActiveScheduleAgentCommandContext {
  runId: string;
  userId: string;
  chatType: "p2p" | "group";
  userTurn: boolean;
  /** 主会话能力令牌：请求必须携带同一令牌才能借用本回合身份 */
  token: string;
}

type SessionEndStatus = "archived" | "archive_failed" | "discarded";

export interface WorkerPipelineConfig {
  jobService: JobService;
  registry: WorkerProfileRegistry;
  /** 全局 Worker 并发上限（内部防失控，默认 4） */
  maxConcurrent?: number;
  /** Scheduler 扫描周期（默认 5000ms；测试可调小） */
  tickMs?: number;
  /** 产物/临时文件根目录（默认 $NIUBOT_HOME/<bot>/tmp） */
  artifactRoot?: string;
  /** /worker 配置体系（启用开关、配置版本、草案） */
  teamConfigStore?: TeamConfigStore;
  /** 按类型解析专属 backend（角色配置 backend 时使用；未配置则复用主 Agent backend） */
  resolveBackend?: (type: string) => Promise<AgentBackend> | AgentBackend;
}

export class Pipeline {
  private db: Database.Database;
  private transport: TransportClient;
  private agent: AgentBackend;
  private backendType: AgentBackendType;
  private backendResolver?: (type: AgentBackendType) => Promise<AgentBackend>;
  private getAvailableBackends: () => string[];
  private getBackendCapabilities: () => BackendCapability[] | Promise<BackendCapability[]>;
  private queue: ChatManager;
  private responseSender: ResponseSender;
  private runtimeState: RuntimeStateStore;
  private runManager: RunManager;
  private restartConfig?: RestartConfig;
  private autoUpdateNotificationsEnabled: boolean;
  private botIdentity: BotIdentity;
  private log: ReturnType<typeof createLogger>;

  /** 每个 chat 的当前 agent session */
  private chatSessions = new Map<string, ChatSession>();

  /** 异步创建中、尚未加入 chatSessions 的 session */
  private sessionCreations = new Map<string, Promise<ChatSession>>();

  /** chatId → platformChatId 映射 */
  private platformChatIds = new Map<string, string>();

  /** chatId → userId 映射 */
  private chatUserIds = new Map<string, string>();

  /** bot 的内部用户 ID */
  private botUserId: string | null = null;

  /** admin 角色映射：userId → role */
  private adminRoles = new Map<string, AdminRole>();

  /** 运行中的独立 task（agentSession.id → RunningTask） */
  private runningTasks = new Map<string, RunningTask>();

  /** processIndependentSession 的活跃计数：覆盖从入口到清理完成的完整生命周期，供优雅关闭等待。 */
  private independentRunCount = 0;

  /** shell 命令历史（admin 专用） */
  private shellHistory: Array<{ cmd: string; cwd: string; exitCode: number; output: string; timestamp: number }> = [];
  private readonly MAX_SHELL_HISTORY = 20;

  /** agent 工作目录 */
  private workingDirectory: string;

  /** 数据库路径（传递给 agent 子进程） */
  private dbPath: string;

  /** 启动时间戳，用于 /service 计算 uptime */
  private startedAt = Date.now();

  /** 启动时缓存的版本号，不受后续 update 影响 */
  private readonly version: string = (() => {
    try {
      const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
      return JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf-8")).version ?? "unknown";
    } catch { return "unknown"; }
  })();

  /** 已处理的消息 ID 去重集合（有上限防内存泄漏） */
  private processedMsgIds = new Set<string>();
  private static readonly MAX_PROCESSED_IDS = 10000;

  /** chatId → triggerPlatformMsgId，暂存触发消息 ID */
  private triggerMsgIds = new Map<string, string>();

  /** chatId → transition promise，session 切换期间后续消息先挂起 */
  private sessionTransitionLocks = new Map<string, Promise<void>>();
  /** backend 切换期间阻塞所有 chat，包括切换开始后首次出现的 chat */
  private globalSessionTransition?: Promise<void>;

  /** chatId → transition 期间暂存的后续消息 */
  private pendingTransitionMessages = new Map<string, PendingTransitionMessage[]>();

  /** 已加过 Pin 的消息，避免重复加 reaction */
  private pinnedMsgIds = new Set<string>();

  /** 已加过 Get 的消息，避免重复加 reaction */
  private processingMsgIds = new Set<string>();

  /** 每个 backend 的模型配置快照，切换时保存/恢复 */
  private backendModelCache = new Map<string, { model?: string; effort?: string }>();

  /** Watchdog 定时器 */
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  /** 已加载的 Worker 配置版本（Pipeline 写入后立即刷新，watchdog 负责异常恢复兜底） */
  private lastTeamConfigVersion?: string;

  /** 更新检查定时器 */
  private updateCheckTimer: ReturnType<typeof setTimeout> | null = null;

  /** 已发送 compact 通知的 session（避免重复通知） */
  private compactNotifiedSessions = new Set<string>();

  /** chatId → 上次从 backend 看到的 compact 次数 */
  private lastCompactCounts = new Map<string, number>();

  /** chatId 集合：下一条发给 agent 的消息需要注入 compact 恢复提醒 */
  private pendingCompactRecovery = new Set<string>();

  /** 创建新 agent session 前刷新 AGENTS.md / CLAUDE.md 等静态上下文文件 */
  private refreshAgentContextFiles?: () => void;

  private stableContextOptions: StableSystemContextOptions;
  private archiveHome: string;

  /** Worker 配置（Phase 2；未配置时不启用任何 Worker 行为） */
  private readonly workerConfig?: WorkerPipelineConfig;
  private workerRuntime?: WorkerRuntime;
  private workerScheduler?: WorkerScheduler;

  /** 仅在主 Agent 的 runAgent 调用期间存在；Worker 写命令必须绑定到这里的活动回合。 */
  private activeWorkerAgentCommands = new Map<string, ActiveWorkerAgentCommandContext>();
  private activeScheduleAgentCommands = new Map<string, ActiveScheduleAgentCommandContext>();

  /** chatId → 主会话调度令牌：随主 Agent 环境注入，独立 session 拿不到，防跨进程身份借用。 */
  private chatScheduleTokens = new Map<string, string>();

  /** 正在占用主聊天队列的 Loop 回合；取消命令用它精确中止对应 run。 */
  private activeLoopRuns = new Map<number, { chatId: string; runId?: string }>();

  /** chatId → 未结束的 Goal（纯内存；重启即断）。 */
  private activeGoals = new Map<string, ActiveGoal>();

  constructor(
    db: Database.Database,
    transport: TransportClient,
    agent: AgentBackend,
    botIdentity: BotIdentity,
    workingDirectory: string,
    dbPath: string,
    bufferMs: number,
    backendType: AgentBackendType = "claude",
    backendResolver?: (type: AgentBackendType) => Promise<AgentBackend>,
    getAvailableBackends?: () => string[],
    refreshAgentContextFiles?: () => void,
    stableContextOptions?: StableSystemContextOptions,
    restartConfig?: RestartConfig,
    autoUpdateNotificationsEnabled = true,
    archiveHome?: string,
    getBackendCapabilities?: () => BackendCapability[] | Promise<BackendCapability[]>,
    workerConfig?: WorkerPipelineConfig,
  ) {
    this.db = db;
    this.transport = transport;
    this.agent = agent;
    this.backendType = backendType;
    this.backendResolver = backendResolver;
    this.getAvailableBackends = getAvailableBackends ?? (() => [...BUILTIN_BACKEND_LIST]);
    this.workerConfig = workerConfig;
    this.getBackendCapabilities = getBackendCapabilities ?? (() => this.getAvailableBackends().map((backend) => ({
      backend: backend as BackendCapability["backend"],
      platform: process.platform,
      support: "native",
      installed: true,
      selectable: true,
    })));
    this.botIdentity = botIdentity;
    this.workingDirectory = workingDirectory;
    this.dbPath = dbPath;
    this.refreshAgentContextFiles = refreshAgentContextFiles;
    this.stableContextOptions = stableContextOptions ?? {};
    this.restartConfig = restartConfig;
    this.autoUpdateNotificationsEnabled = autoUpdateNotificationsEnabled;
    this.archiveHome = archiveHome ?? (process.env["VITEST"]
      ? path.join(path.dirname(dbPath), ".niubot-test")
      : NIUBOT_HOME);
    this.log = createLogger("pipeline", botIdentity.name);
    this.runtimeState = new RuntimeStateStore({
      onEvent: (event) => this.persistRuntimeEvent(event),
    });
    this.queue = new ChatManager(bufferMs, this.runtimeState);
    this.responseSender = new ResponseSender(transport);
    this.runManager = new RunManager(this.agent, this.runtimeState, this.responseSender);

    // 初始 backend 的模型配置入缓存，确保切走再切回来能恢复
    this.backendModelCache.set(backendType, {
      model: botIdentity.model,
      effort: botIdentity.effort,
    });

    this.queue.onProcess((runId, chatId, mergedText, messages, signal) => (
      this.process(chatId, mergedText, messages, signal, runId)
    ));
    this.queue.onDiscard((messages) => {
      this.transport.discardInboundMessages?.(
        messages.map((message) => message.dbMsgId).filter((id): id is number => id != null),
      );
      for (const message of messages) {
        if (message.triggerKind === "loop_continuation" && message.loopJobId !== undefined) {
          releaseQueuedLoopJob(this.db, message.loopJobId);
        }
      }
    });
  }

  private async createAgentSession(config: SessionConfig, backend: AgentBackend = this.agent): Promise<AgentSession> {
    try {
      this.refreshAgentContextFiles?.();
    } catch (err) {
      this.log.warn("failed to refresh agent context files", { error: String(err) });
    }
    return backend.createSession(config);
  }

  /** 启动 Engine 管道；Transport 入站入口由装配层连接。 */
  async start(): Promise<void> {
    // 先用配置里的占位 bot id 建立本地身份，平台真实身份放后台补齐。
    this.botUserId = ensureUser(
      this.db,
      this.botIdentity.platform,
      this.botIdentity.platformBotId,
      this.botIdentity.name,
      "bot_info",
    );

    this.markUnfinishedRuntimeRunsFailedByRestart();
    this.restoreAdminsFromDb();

    // 启动 watchdog 定时器
    this.watchdogTimer = setInterval(() => this.runIdleWatchdogSafely(), AGENT_WATCHDOG_INTERVAL_MS);

    // Worker：启动 Scheduler 并恢复非终态 Job
    if (this.workerConfig) {
      const {
        jobService, registry, maxConcurrent, tickMs, artifactRoot: configuredArtifactRoot, teamConfigStore,
      } = this.workerConfig;
      const artifactRoot = configuredArtifactRoot ?? path.join(NIUBOT_HOME, this.botIdentity.name, "tmp");
      // 配置驱动：有生效配置时用配置的 profiles 与并发上限（无则内置默认）
      const active = teamConfigStore?.getActiveConfig();
      if (active && active.config.profiles.length > 0) {
        registry.setProfiles(active.config.profiles.map(teamProfileToWorkerProfile));
        this.log.info("worker profiles loaded from team config", {
          version: active.version ?? null,
          profileCount: active.config.profiles.length,
        });
      }
      const effectiveMaxConcurrent = active?.config.maxConcurrent ?? maxConcurrent ?? 4;
      this.workerRuntime = new WorkerRuntime({
        backend: this.agent,
        jobService,
        registry,
        sessionConfig: {
          dbPath: this.dbPath,
          botId: this.botIdentity.platformBotId,
          botName: this.botIdentity.name,
          platform: this.botIdentity.platform,
          model: this.botIdentity.model,
          botProfilePath: this.stableContextOptions.botProfilePath,
        },
        buildPrompt: (job, execDir, artifactDir) => this.buildWorkerPrompt(job, execDir, artifactDir),
        workspaceProvider: new WorkspaceProvider({ tmpRoot: artifactRoot }),
        resolveBackend: this.workerConfig.resolveBackend,
      });
      this.workerScheduler = new WorkerScheduler({
        runtime: this.workerRuntime,
        jobService,
        maxConcurrent: effectiveMaxConcurrent,
        tickMs,
        onContinuations: (chatId, ids) => this.enqueueWorkerContinuations(chatId, ids),
        isSchedulingEnabled: () => (this.workerConfig?.teamConfigStore?.isEnabled() ?? true),
      });
      this.cleanupWorkerJobsAfterRestart();
      this.workerScheduler.start();
    }
    if (this.autoUpdateNotificationsEnabled) {
      if (this.isUpdateNotificationWindow(new Date())) {
        this.checkForUpdatesAndNotifyAdmins().catch((err) => {
          this.log.warn("startup update check failed", { error: String(err) });
        });
      }
      this.scheduleNextUpdateCheck();
    } else {
      this.log.info("automatic update notifications disabled for bot");
    }
    this.runStartupPlatformProbes();

    this.log.info("pipeline started", {
      botUserId: this.botUserId,
      botPlatformId: this.botIdentity.platformBotId,
      adminCount: this.adminRoles.size,
      backend: this.backendType,
      model: this.botIdentity.model ?? "default",
      autoUpdateNotifications: this.autoUpdateNotificationsEnabled,
    });

  }

  private runStartupPlatformProbes(): void {
    void this.refreshBotIdentityFromPlatform();
    void this.detectAppCreatorAdmin();
  }

  private async refreshBotIdentityFromPlatform(): Promise<void> {
    let platformBotName: string | undefined;
    try {
      const [realBotId, name] = await withTimeout({
        label: "bot identity lookup",
        timeoutMs: STARTUP_PLATFORM_TIMEOUT_MS,
        fn: async () => Promise.all([
          this.transport.getBotOpenId(),
          this.transport.getBotName(),
        ]),
      });
      if (realBotId) {
        this.botIdentity.platformBotId = realBotId;
      }
      platformBotName = name ?? undefined;
    } catch (err) {
      this.log.warn("failed to fetch bot identity", { error: String(err) });
      return;
    }

    // 平台显示名写入 DB user 记录（用于 whoami 等场景），但不覆盖 botIdentity.name（config name，用于路径）
    this.botUserId = ensureUser(
      this.db,
      this.botIdentity.platform,
      this.botIdentity.platformBotId,
      platformBotName ?? this.botIdentity.name,
      "bot_info",
    );
    this.log.info("bot identity refreshed", {
      botUserId: this.botUserId,
      botPlatformId: this.botIdentity.platformBotId,
      botPlatformName: platformBotName ?? null,
    });
  }

  /** 停止管道：清除队列计时器 */
  stop(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.updateCheckTimer) {
      clearTimeout(this.updateCheckTimer);
      this.updateCheckTimer = null;
    }
    this.workerScheduler?.stop();
    this.queue.stop();
    this.log.info("pipeline stopped");
  }

  /** 优雅关闭：cancel 所有活跃 session，清理资源（DB 中 session 保持 active，下次启动恢复） */
  async shutdown(): Promise<void> {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.updateCheckTimer) {
      clearTimeout(this.updateCheckTimer);
      this.updateCheckTimer = null;
    }
    for (const [chatId, session] of this.chatSessions) {
      try {
        // 更新 DB 最后活跃时间
        this.db.prepare("UPDATE sessions SET last_active_at = datetime('now') WHERE id = ?")
          .run(session.sessionId);
        // 后端卡住时不能让 shutdown 永久阻塞，逐个限时。
        await withShutdownTimeout(this.agent.cancelSession(session.agentSession), 5_000);
        await withShutdownTimeout(this.agent.closeSession(session.agentSession), 5_000);
      } catch (err) {
        this.log.warn("failed to close session during shutdown", { chatId, error: String(err) });
      }
    }
    this.chatSessions.clear();

    // 独立 session（Cron/task）同样取消，避免 backend/DB 关闭后仍在执行。
    for (const [sessionId, task] of this.runningTasks) {
      try {
        await withShutdownTimeout(task.backend.cancelSession(task.agentSession), 5_000);
      } catch (err) {
        this.log.warn("failed to cancel independent session during shutdown", { sessionId, error: String(err) });
      }
    }
  }

  /** 是否有正在处理的主会话、Worker Job 或独立 session（Cron/task）——优雅关闭等待用 */
  hasBusyChats(): boolean {
    return this.queue.hasBusyChats()
      || (this.workerRuntime?.runningCount() ?? 0) > 0
      || this.independentRunCount > 0;
  }

  /** 检查用户是否为 admin 或 owner */
  isAdmin(userId: string): boolean {
    return this.adminRoles.has(userId);
  }

  /** 检查用户是否为 owner */
  isOwner(userId: string): boolean {
    return this.adminRoles.get(userId) === "owner";
  }

  /**
   * 主 Agent 的 Worker 写入口。请求只在对应 chat 的活动 Agent 回合内受理；
   * CLI 不再直接修改 Worker 表。
   */
  async executeWorkerAgentCommand(request: WorkerAgentCommandRequest): Promise<WorkerAgentCommandResult> {
    const context = this.activeWorkerAgentCommands.get(request.chatId);
    const activeRun = this.runtimeState.getActiveRun(request.chatId);
    if (!context || !activeRun || activeRun.runId !== context.runId || activeRun.stage !== "agent_running") {
      throw new Error("Worker 写操作必须在当前主会话的活动 Agent 回合内执行");
    }
    if (!request.scheduleToken || request.scheduleToken !== context.token) {
      throw new Error("Worker 请求缺少或携带错误的能力令牌");
    }
    const service = this.workerConfig?.jobService;
    const teamConfig = this.workerConfig?.teamConfigStore;
    if (!service || !teamConfig) throw new Error("当前 Bot 未启用 Worker");

    const requireWorkAccess = (workId: string): Work => {
      const work = service.getWork(workId);
      if (!work) throw new Error(`Work 不存在: ${workId}`);
      if (work.sourceChatId !== request.chatId) throw new Error(`Work 不属于当前会话: ${workId}`);
      if (work.visibility === "private" && work.ownerUserId !== context.userId) {
        throw new Error(`无权操作 Work: ${workId}`);
      }
      return work;
    };
    const requireAdmin = () => {
      if (!this.isAdmin(context.userId)) throw new Error("该 Worker 操作仅管理员可用");
    };

    switch (request.command.type) {
      case "work.create": {
        if (context.continuationTurn) throw new Error("验收回合不能新建 Work；需要继续时请在原 Work 下追加 Job");
        if (!teamConfig.isEnabled()) throw new Error("Worker 当前已暂停，不能创建 Work");
        const content = request.command.request.trim();
        if (!content) throw new Error("Work 需求不能为空");
        const existing = context.createdWorkIds
          .map((workId) => service.getWork(workId))
          .find((work) => work?.status === "active" && work.request === content);
        if (existing) return { output: existing.id };
        const work = service.createWork({
          botId: this.botIdentity.name,
          ownerUserId: context.userId,
          sourceChatId: request.chatId,
          visibility: context.chatType === "group" ? "public" : "private",
          request: content,
          triggerMsgPlatformId: activeRun.replyToPlatformMsgId
            ?? findLatestUserPlatformMsgId(this.db, request.chatId, context.userId),
        });
        context.createdWorkIds.push(work.id);
        return { output: work.id };
      }
      case "job.create": {
        if (!teamConfig.isEnabled()) throw new Error("Worker 当前已暂停，不能创建 Job");
        requireWorkAccess(request.command.workId);
        const profile = this.workerConfig.registry.get(request.command.workerProfileId);
        if (!profile) {
          throw new Error(`未知 Worker Profile: ${request.command.workerProfileId}（可用: ${this.workerConfig.registry.list().map((item) => item.id).join(", ")}）`);
        }
        // 工作区访问方式由 Profile 决定（read_only 只读 / direct 直接修改），Job 不再携带
        if (profile.access === "direct" && !request.command.workdir) {
          // direct 写任务必须显式指定目标目录：缺省（workspace 根）等于授权 Worker 直写整个工作区
          throw new Error("direct 写任务必须显式指定 workdir（目标目录），不能省略");
        }
        const requestedWorkdir = path.resolve(request.command.workdir ?? this.workingDirectory);
        let workspaceRootReal: string;
        let requestedWorkdirReal: string;
        try {
          workspaceRootReal = realpathSync(this.workingDirectory);
          requestedWorkdirReal = realpathSync(requestedWorkdir);
        } catch {
          throw new Error("Worker 工作目录不存在或无法访问");
        }
        const relative = path.relative(workspaceRootReal, requestedWorkdirReal);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error("Worker 工作目录必须位于当前 workspace 内");
        }
        const prompt = request.command.prompt.trim();
        if (!prompt) throw new Error("Job 内容不能为空");
        if (typeof request.command.idempotencyKey !== "string" || !request.command.idempotencyKey.trim()) {
          throw new Error("Job 幂等键不能为空");
        }
        const job = service.createJob({
          workId: request.command.workId,
          workerProfileId: profile.id,
          prompt,
          workdir: requestedWorkdirReal,
          dependsOn: request.command.dependsOn,
        }, request.command.idempotencyKey);
        this.workerScheduler?.kick();
        return { output: job.id };
      }
      case "cancel": {
        const id = request.command.id;
        const reason = request.command.reason?.trim() ? `用户取消：${request.command.reason.trim()}` : undefined;
        const affectedJobs: Job[] = [];
        if (id.startsWith("wrk_")) {
          requireWorkAccess(id);
          const work = service.cancelWork(id, reason);
          if (!work) throw new Error(`Work 不存在: ${id}`);
          affectedJobs.push(...service.listJobs(id).filter((job) => job.status === "cancelling"));
        } else if (id.startsWith("job_")) {
          const before = service.getJob(id);
          if (!before) throw new Error(`Job 不存在: ${id}`);
          requireWorkAccess(before.workId);
          const job = service.requestCancel(id, reason);
          if (!job) throw new Error(`Job 不可取消: ${id}`);
          affectedJobs.push(job);
        } else {
          throw new Error(`无法识别的 ID: ${id}`);
        }
        for (const job of affectedJobs) {
          if (this.workerRuntime?.inspect(job.id)) {
            void this.workerRuntime.cancel(job.id, "agent_cancel").catch((error) => {
              this.log.error("worker cancel request failed", { jobId: job.id, error: String(error) });
            });
          } else if (this.workerRuntime?.hasInFlight(job.id)) {
            // 准备阶段：abort 准备流程，runJob 在检查点收敛为 cancelled。
            // 不能直接确认终态——否则 runJob 检查点看不到 cancelling，Worker 会完整执行（幽灵执行）。
            void this.workerRuntime.cancel(job.id, "agent_cancel").catch((error) => {
              this.log.error("worker cancel request failed", { jobId: job.id, error: String(error) });
            });
          } else if (!job.startedAt) {
            service.confirmCancelled(job.id, {
              status: "cancelled",
              responseText: "",
              error: "cancelled before execution",
              changedFiles: [],
              artifacts: [],
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
            });
          }
        }
        const currentWork = id.startsWith("wrk_") ? service.getWork(id) : undefined;
        return { output: currentWork?.status === "cancelled" ? `${id} 已取消` : `${id} 已请求取消` };
      }
      case "work.complete_recovery": {
        requireAdmin();
        if (request.command.force !== true) throw new Error("人工完成 Work 必须显式确认 force=true");
        requireWorkAccess(request.command.workId);
        const work = service.completeWork(request.command.workId, { conclusion: request.command.conclusion.trim() });
        if (!work) throw new Error(`Work 不可完成: ${request.command.workId}`);
        return { output: `Work ${request.command.workId} 已完成` };
      }
      case "config.draft": {
        requireAdmin();
        const result = teamConfig.createDraft(
          request.command.yamlText,
          context.userId,
          request.command.baseVersion ?? teamConfig.getActiveConfig().version,
        );
        if (!result.ok) throw new Error(result.error);
        return { output: result.draftId };
      }
      case "config.apply": {
        requireAdmin();
        const result = teamConfig.applyDraft(request.command.draftId, context.userId);
        if (!result.ok) throw new Error(result.error);
        this.reloadTeamConfigIfChanged();
        return { output: `applied: ${result.version}` };
      }
      case "config.rollback": {
        requireAdmin();
        const result = teamConfig.rollback(request.command.version, context.userId);
        if (!result.ok) throw new Error(result.error);
        this.reloadTeamConfigIfChanged();
        return { output: `rolled back to ${request.command.version}; active: ${result.version}` };
      }
    }
    throw new Error(`未知 Worker 操作: ${String((request.command as { type?: unknown }).type)}`);
  }

  /** 调度写入口。身份取当前 Agent 回合，不信任 Session 创建时固定的环境变量。 */
  async executeScheduleAgentCommand(
    chatId: string,
    command: ScheduleAgentCommand,
    token?: string,
  ): Promise<ScheduleAgentCommandResult> {
    command = parseScheduleAgentCommand(command);
    const context = this.activeScheduleAgentCommands.get(chatId);
    const activeRun = this.runtimeState.getActiveRun(chatId);
    if (!context || !activeRun || activeRun.runId !== context.runId || activeRun.stage !== "agent_running") {
      throw new Error("调度写操作必须在当前主会话的活动 Agent 回合内执行");
    }
    if (!token || token !== context.token) {
      throw new Error("调度请求缺少或携带错误的能力令牌");
    }
    if (!context.userTurn) throw new Error("只有用户消息回合可以修改调度任务");

    switch (command.type) {
      case "create.schedule": {
        const timeZone = command.timeZone ?? TZ;
        if (command.mode === "main") {
          let id: number;
          if (command.trigger === "every") {
            id = addLoopJob(this.db, {
              chatId,
              creatorUserId: context.userId,
              intervalSeconds: command.intervalSeconds!,
              prompt: command.prompt,
              maxTimes: command.maxTimes,
              durationSeconds: command.durationSeconds,
              untilTime: command.untilTime,
            });
          } else if (command.trigger === "cron") {
            // 日历表达式也走主会话：分钟粒度匹配触发，复用主会话上下文
            id = addLoopJob(this.db, {
              chatId,
              creatorUserId: context.userId,
              intervalSeconds: 60, // cron 型检查点粒度
              prompt: command.prompt,
              maxTimes: command.maxTimes,
              durationSeconds: command.durationSeconds,
              untilTime: command.untilTime,
              cronExpr: command.cronExpr!,
              timezone: timeZone,
              description: command.description,
            });
          } else {
            // 一次性（at/after）也走主会话：next_run_at 用绝对时间，执行一次即完成
            const nextRunUtc = command.trigger === "at"
              ? userDateTimeToUtcSql(command.at!, timeZone)
              : utcDateTimeForSql(new Date(Date.now() + command.afterSeconds! * 1_000));
            id = addLoopJob(this.db, {
              chatId,
              creatorUserId: context.userId,
              intervalSeconds: 60, // 调度器轮询粒度兜底；实际触发由 next_run_at 决定
              prompt: command.prompt,
              maxTimes: 1,
              runAt: nextRunUtc,
            });
          }
          const job = getLoopJob(this.db, id)!;
          const triggerLabel = command.trigger === "every"
            ? `每 ${formatLoopInterval(job.intervalSeconds)}`
            : command.trigger === "cron"
              ? `${describeCronExpr(job.cronExpr ?? command.cronExpr!)} (${job.timezone})`
              : `一次性 · ${formatLocalDateTimeWithTZ(job.nextRunAt, TZ)}`;
          return { output: [
            `Created loop:${id}`,
            "Mode: main (主会话)",
            `Trigger: ${triggerLabel}`,
            `Task: ${job.prompt}`,
            `Next run: ${formatLocalDateTimeWithTZ(job.nextRunAt, TZ)}`,
            `Ends: ${formatLocalDateTimeWithTZ(job.untilTime, TZ)}${job.maxTimes ? ` or after ${job.maxTimes} runs` : ""}`,
          ].join("\n") };
        }
        // isolated（独立会话）模式
        let cronExpr: string | null = command.cronExpr ?? null;
        let runAt: string | null = null;
        switch (command.trigger) {
          case "cron":
            break;
          case "at":
            runAt = command.at!;
            break;
          case "after":
            runAt = dateTimeInTimeZone(new Date(Date.now() + command.afterSeconds! * 1_000), timeZone);
            break;
          case "every": {
            const expr = everyToCronExpr(command.intervalSeconds!);
            if (!expr) throw new Error("isolated 模式 --every 最小 1 分钟，更短间隔请用 main 模式");
            cronExpr = expr;
            break;
          }
        }
        const id = addCronJob(this.db, {
          chatId,
          creatorUserId: context.userId,
          cronExpr: cronExpr ?? undefined,
          runAt: runAt ?? undefined,
          prompt: command.prompt,
          description: command.description,
          maxTimes: command.maxTimes,
          untilTime: command.untilTime,
          timeZone,
        });
        const job = getCronJob(this.db, id)!;
        return { output: [
          `Created cron:${id}`,
          "Mode: isolated (独立会话)",
          job.cronExpr ? `Schedule: ${job.cronExpr} (${job.timezone})` : `Run at: ${formatLocalDateTimeWithTZ(job.runAt!, job.timezone)}`,
          `Task: ${job.prompt}`,
        ].join("\n") };
      }
      case "cancel": {
        const match = /^(loop|cron):(\d+)$/.exec(command.scheduleId);
        if (!match) throw new Error("调度 ID 必须是 loop:1 或 cron:1");
        const id = Number(match[2]);
        if (match[1] === "loop") {
          const job = cancelLoopJobForAccess(this.db, id, {
            currentChatId: chatId,
            chatType: context.chatType,
            userId: context.userId,
          });
          if (!job) throw new Error(`loop:${id} 不存在或已经结束`);
          return { output: `Cancelled loop:${id}` };
        }
        const job = deleteCronJobForAccess(this.db, id, {
          currentChatId: chatId,
          chatType: context.chatType,
          userId: context.userId,
        });
        if (!job) throw new Error(`cron:${id} 不存在或已经结束`);
        await this.cancelRunningCronSessions(id);
        return { output: `Cancelled cron:${id}` };
      }
    }
    throw new Error(`未知调度操作: ${String((command as { type?: unknown }).type)}`);
  }

  /** 获取 bot 用户 ID */
  getBotUserId(): string | null {
    return this.botUserId;
  }

  /** 通过 IPC 发送消息到指定 chat */
  async sendToChat(platformChatId: string, text: string): Promise<void> {
    const platformMsgId = await this.transport.sendText(platformChatId, text);
    const chatRow = this.db.prepare("SELECT id FROM chats WHERE platform_id = ?")
      .get(platformChatId) as { id: string } | undefined;
    if (chatRow) {
      this.storeBotResponse(chatRow.id, text, platformMsgId);
    }
  }

  /** 通过 IPC 发送卡片到指定 chat */
  async sendCardToChat(platformChatId: string, header: string, content: string): Promise<void> {
    const platformMsgId = await this.transport.sendCard(platformChatId, header, content);
    const chatRow = this.db.prepare("SELECT id FROM chats WHERE platform_id = ?")
      .get(platformChatId) as { id: string } | undefined;
    if (chatRow) {
      this.storeBotResponse(chatRow.id, content, platformMsgId);
    }
  }

  /** 通过 IPC 发送文件到指定 chat */
  async sendFileToChat(platformChatId: string, filePath: string): Promise<void> {
    const platformMsgId = await this.transport.sendFile(platformChatId, filePath);
    const chatRow = this.db.prepare("SELECT id FROM chats WHERE platform_id = ?")
      .get(platformChatId) as { id: string } | undefined;
    if (chatRow) {
      this.storeBotResponse(chatRow.id, `[文件] ${filePath}`, platformMsgId, "file");
    }
  }

  private markQueuedMessage(chatPlatformId: string, msgId?: string): void {
    if (!msgId || this.pinnedMsgIds.has(msgId)) return;
    this.pinnedMsgIds.add(msgId);
    this.log.info("reaction request", { chatPlatformId, msgId, emoji: MERGED_EMOJI, phase: "queued" });
    this.transport.addReaction(chatPlatformId, msgId, MERGED_EMOJI).catch(() => {});
  }

  private moveMessageToProcessing(chatPlatformId: string, msgId?: string): void {
    if (!msgId) return;
    this.pinnedMsgIds.delete(msgId);
    if (this.processingMsgIds.has(msgId)) return;
    this.processingMsgIds.add(msgId);
    this.log.info("reaction request", { chatPlatformId, msgId, emoji: PROCESSING_EMOJI, phase: "processing" });
    this.transport.addReaction(chatPlatformId, msgId, PROCESSING_EMOJI).catch(() => {});
  }

  /**
   * 注入 prompt 到 agent pipeline（用于 cron 等内部触发场景）。
   * 和用户消息走相同的 queue → process → agent 链路。
   */
  injectPrompt(chatId: string, userId: string, text: string): void {
    // Ensure maps are populated so getOrCreateSession can find the chat
    if (!this.platformChatIds.has(chatId)) {
      const row = this.db.prepare("SELECT platform_id FROM chats WHERE id = ?")
        .get(chatId) as { platform_id: string } | undefined;
      if (!row) {
        this.log.warn("injectPrompt: chat not found", { chatId });
        return;
      }
      this.platformChatIds.set(chatId, row.platform_id);
    }
    if (!this.chatUserIds.has(chatId)) {
      this.chatUserIds.set(chatId, userId);
    }

    this.queue.push({ chatId, text, timestamp: Date.now() });
  }

  private markRuntimeRun(runId: string | undefined, stage: RunStage, lastError?: string): void {
    if (!runId) return;
    const current = this.runtimeState.getRun(runId);
    if (!current || isTerminalRunStage(current.stage)) return;
    try {
      this.runtimeState.markRunStage(runId, stage, lastError);
    } catch (err) {
      this.log.warn("failed to update runtime run state", { runId, stage, error: String(err) });
    }
  }

  private persistRuntimeEvent(event: RuntimeStateEvent): void {
    try {
      const eventId = recordRuntimeEvent(this.db, {
        botId: this.botIdentity.name,
        chatId: event.chatId,
        runId: event.runId,
        messageIds: event.messageIds,
        stage: event.stage,
        event: event.event,
        error: event.error,
        elapsedMs: event.elapsedMs,
      });
      this.log.info("runtime event persisted", {
        eventId,
        chatId: event.chatId,
        runId: event.runId,
        stage: event.stage,
        event: event.event,
        messageIds: event.messageIds,
        elapsedMs: event.elapsedMs,
        hasError: !!event.error,
      });
    } catch (err) {
      this.log.warn("failed to persist runtime event", {
        chatId: event.chatId,
        runId: event.runId,
        event: event.event,
        error: String(err),
      });
    } finally {
      try {
        this.transport.markInboundRunState?.(
          event.messageIds,
          event.runId,
          event.stage,
          event.error,
        );
      } catch (err) {
        this.log.error("failed to persist inbox run state", {
          chatId: event.chatId,
          runId: event.runId,
          stage: event.stage,
          error: String(err),
        });
      }
    }
  }

  private markUnfinishedRuntimeRunsFailedByRestart(): void {
    try {
      const marked = markUnfinishedRuntimeRunsFailedByRestart(this.db, this.botIdentity.name, (run) => {
        this.log.warn("runtime run failed by restart", {
          botId: run.botId,
          chatId: run.chatId,
          runId: run.runId,
          messageIds: run.messageIds,
          previousElapsedMs: run.previousElapsedMs ?? null,
        });
      });
      if (marked > 0) {
        this.log.warn("marked unfinished runtime runs failed by restart", { count: marked });
      }
    } catch (err) {
      this.log.warn("failed to mark unfinished runtime runs after restart", { error: String(err) });
    }
  }

  /** Standard Transport entrypoint. Platform events are persisted before reaching this method. */
  handleInbound(delivery: InboundDelivery): void | Promise<void> {
    try {
      const result = this.handleMessage(
        delivery.message,
        delivery.replayed,
        delivery.inboxId,
        delivery.claimToken,
        delivery.messageId,
      );
      if (result) {
        return result.catch((error) => {
          if (delivery.message.platformMsgId) {
            this.processedMsgIds.delete(delivery.message.platformMsgId);
          }
          throw error;
        });
      }
    } catch (error) {
      if (delivery.message.platformMsgId) {
        this.processedMsgIds.delete(delivery.message.platformMsgId);
      }
      throw error;
    }
  }

  private handleMessage(
    msg: NormalizedMessage,
    replayedAfterTransition = false,
    inboxId?: number,
    claimToken?: string,
    recoveredMessageId?: number,
  ): void | Promise<void> {
    const platform = this.botIdentity.platform;

    // 消息去重（飞书 WebSocket 可能重复推送）
    if (msg.platformMsgId && this.processedMsgIds.has(msg.platformMsgId)) {
      this.log.debug("duplicate message, skipping", { platformMsgId: msg.platformMsgId });
      if (inboxId != null && claimToken) {
        this.transport.markInboundTerminal?.(inboxId, claimToken, "completed");
      }
      return;
    }
    if (msg.platformMsgId) {
      this.processedMsgIds.add(msg.platformMsgId);
      if (this.processedMsgIds.size > Pipeline.MAX_PROCESSED_IDS) {
        this.processedMsgIds.clear();
      }
    }

    // 过期消息检测（>2min 丢弃）
    if (!replayedAfterTransition && msg.platformTs) {
      const delay = Date.now() - msg.platformTs;
      if (delay > STALE_MESSAGE_THRESHOLD_MS) {
        this.log.warn("stale message, dropping", {
          chatId: msg.chatPlatformId,
          delayMs: delay,
          msgId: msg.platformMsgId,
        });
        if (msg.platformMsgId) {
          this.transport.addReaction(msg.chatPlatformId, msg.platformMsgId, "Alarm").catch(() => {});
        }
        if (inboxId != null && claimToken) {
          this.transport.markInboundTerminal?.(inboxId, claimToken, "discarded", "stale message");
        }
        return;
      }
    }

    // 群聊触发检测：需要 @bot 或 reply-to-bot
    if (msg.chatType === "group" && !msg.botMentioned) {
      // Check if it's a reply to bot's message
      const isReplyToBot = msg.parentPlatformMsgId
        ? this.isMessageFromBot(platform, msg.parentPlatformMsgId)
        : false;

      if (!isReplyToBot) {
        // 群聊中未 @ bot 也未回复 bot，只存消息不触发
        this.persistInboundMessage({
          inboxId,
          claimToken,
          recoveredMessageId,
          state: "completed",
          store: () => this.storeMessageOnly(msg, platform),
        });
        return;
      }
    }

    // Collect user info from mentions + replace @name with @shortLabel
    if (msg.mentions) {
      for (const m of msg.mentions) {
        if (m.platformUserId && m.name) {
          const mentionUserId = ensureUser(this.db, platform, m.platformUserId, m.name, m.isBot ? "bot_sender" : "mention");
          const shortLabel = getUserShortLabel(this.db, mentionUserId);
          msg.contentText = msg.contentText.replaceAll(`@${m.name}`, `@${shortLabel}`);
        }
      }
    }

    const userId = ensureUser(this.db, platform, msg.senderPlatformId, msg.senderName, "bot_sender");

    // Fallback: if no admin detected yet and this is a p2p message, first user becomes owner
    if (this.adminRoles.size === 0 && msg.chatType === "p2p") {
      this.setAdminRole(userId, "owner", "first_p2p_user", msg.senderPlatformId);
    }

    // For p2p chats, link user_id
    const chatUserId = msg.chatType === "p2p" ? msg.senderPlatformId : undefined;
    const chatId = ensureChat(this.db, platform, msg.chatPlatformId, msg.chatType, msg.chatName, chatUserId);

    if (this.globalSessionTransition || this.sessionTransitionLocks.has(chatId)) {
      this.log.info("message deferred during session transition", {
        chatId,
        msgId: msg.platformMsgId,
        type: msg.contentType,
      });
      return this.enqueuePendingTransitionMessage(chatId, msg, inboxId, claimToken, recoveredMessageId);
    }

    // Fetch group chat name if not known
    if (msg.chatType === "group") {
      const chatRow = this.db.prepare("SELECT name FROM chats WHERE id = ?").get(chatId) as { name: string | null } | undefined;
      if (!chatRow?.name) {
        this.transport.getChatName(msg.chatPlatformId).then((name) => {
          if (name) updateChatName(this.db, chatId, name);
        }).catch(() => {});
      }
    }

    // Build reply quoted block (sub-field of - msg: / - forward:)
    let replyQuoted = "";
    if (msg.parentPlatformMsgId) {
      replyQuoted = this.buildReplyQuoted(platform, msg.parentPlatformMsgId);
    }

    // Store platform_ts as ISO string
    const platformTsStr = msg.platformTs
      ? utcDateTimeForSql(new Date(msg.platformTs))
      : undefined;

    const sessionId = this.chatSessions.get(chatId)?.sessionId;
    const persistIncomingMessage = (state: "queued" | "processing"): number => this.persistInboundMessage({
      inboxId,
      claimToken,
      recoveredMessageId,
      state,
      store: () => storeMessage(this.db, {
        chatId,
        senderId: userId,
        sessionId,
        role: "user",
        contentText: msg.contentText,
        contentType: msg.contentType,
        platform,
        platformMsgId: msg.platformMsgId,
        platformTs: platformTsStr,
        platformRaw: JSON.stringify(msg.raw),
      }),
    });

    this.log.info("message received", {
      chatId, userId,
      type: msg.contentType,
      textLength: msg.contentText.length,
      mentions: msg.mentions?.length ?? 0,
      hasParent: !!msg.parentPlatformMsgId,
    });

    // 缓存映射
    this.platformChatIds.set(chatId, msg.chatPlatformId);
    this.chatUserIds.set(chatId, userId);

    // Prepare text to send to agent
    // 独立消息：纯文本（保持 skill 等模式匹配可用）
    // 结构化消息（reply / forward）：YAML 格式表达嵌套关系
    let agentText: string;
    const label = getUserShortLabel(this.db, userId);

    if (msg.contentType === "merge_forward" && msg.children?.length) {
      // 合并转发：- forward: sender + messages
      agentText = `- forward: ${label}\n  messages:\n${renderMessageNodes(msg.children, 2)}`;
      if (replyQuoted) agentText += `\n${replyQuoted}`;
    } else if (replyQuoted) {
      // 回复消息：- msg: "sender: content" + quoted
      const escaped = escapeYamlContent(msg.contentText);
      agentText = `- msg: "${escapeYamlContent(label)}: ${escaped}"\n${replyQuoted}`;
    } else {
      // 独立消息：纯文本（hybrid 创建命令在此翻译为「任务原文 + nbt 建议」；reply/forward 保持原样）
      const text = this.normalizeUserTextForAgent(msg.contentText);
      agentText = rewriteHybridCreationCommand(text) ?? text;
    }

    // Save trigger msg ID for reply-to-message（process() 会快照并清除）
    if (msg.platformMsgId) {
      this.triggerMsgIds.set(chatId, msg.platformMsgId);
    }

    // 短词打断检测（不清空队列，只 kill 当前进程，与 /stop 行为一致）
    const trimmedText = msg.contentText.trim().toLowerCase();
    if (INTERRUPT_WORDS.has(trimmedText) && this.chatSessions.has(chatId)) {
      persistIncomingMessage("processing");
      this.log.info("interrupt word detected", { chatId, word: trimmedText });
      const activeRun = this.runtimeState.getActiveRun(chatId);
      const hasActiveRun = !!activeRun;
      if (activeRun) {
        this.markRuntimeRun(activeRun.runId, "stopped");
      }
      if (hasActiveRun && this.chatSessions.has(chatId)) {
        this.cancelChat(chatId).catch(() => {});
      }
      // 与 /stop 一致：abort 队列信号，保证 agent 进程杀不掉时 run 也能退出、busy 恢复
      if (hasActiveRun || this.queue.isBusy(chatId)) {
        this.queue.cancel(chatId);
      }
      const interruptText = "好的，已停止。";
      this.transport.sendText(msg.chatPlatformId, interruptText).then((pmid) => {
        this.storeBotResponse(chatId, interruptText, pmid);
      }).catch(() => {});
      if (inboxId != null && claimToken) {
        this.transport.markInboundTerminal?.(inboxId, claimToken, "completed");
      }
      return;
    }

    // 内置命令拦截：/xxx 开头的消息先匹配内置命令，命中则不传给 agent
    const commandText = msg.contentText.trim();
    if (this.isBuiltinCommand(commandText, userId)) {
      persistIncomingMessage("processing");
      this.handleBuiltinCommand(commandText, userId, chatId, msg.chatPlatformId, msg.chatType, msg.platformMsgId);
      if (inboxId != null && claimToken) {
        this.transport.markInboundTerminal?.(inboxId, claimToken, "completed");
      }
      return;
    }

    const incomingMsgId = persistIncomingMessage("queued");

    // Reaction 策略：收到即二选一；pending 先 Pin，非 pending 先 Get；pending 开始处理后再补 Get
    const isPending = this.queue.push({
      chatId,
      text: agentText,
      senderLabel: label,
      senderId: userId,
      dbMsgId: incomingMsgId,
      timestamp: Date.now(),
      platformMsgId: msg.platformMsgId,
      scheduleCommand: /^\/(?:loop|cron)(?:\s|$)/i.test(commandText),
    });
    this.log.info("reaction decision", {
      chatId,
      msgId: msg.platformMsgId,
      isPending,
      initialEmoji: isPending ? MERGED_EMOJI : PROCESSING_EMOJI,
    });
    if (isPending) {
      this.markQueuedMessage(msg.chatPlatformId, msg.platformMsgId);
    } else {
      this.moveMessageToProcessing(msg.chatPlatformId, msg.platformMsgId);
    }
  }

  /** Store a bot-sent message in DB */
  private storeBotResponse(chatId: string, text: string, platformMsgId?: string, contentType?: string): void {
    if (!this.botUserId) return;
    storeMessage(this.db, {
      chatId,
      senderId: this.botUserId,
      sessionId: this.chatSessions.get(chatId)?.sessionId,
      role: "assistant",
      contentText: text,
      contentType,
      platform: this.botIdentity.platform,
      platformMsgId,
    });
  }

  /** Store message without triggering agent (for group chat non-targeted messages) */
  private storeMessageOnly(msg: NormalizedMessage, platform: string): number {
    const userId = ensureUser(this.db, platform, msg.senderPlatformId, msg.senderName, "bot_sender");
    const chatId = ensureChat(this.db, platform, msg.chatPlatformId, msg.chatType, msg.chatName);

    const platformTsStr = msg.platformTs
      ? utcDateTimeForSql(new Date(msg.platformTs))
      : undefined;

    const messageId = storeMessage(this.db, {
      chatId,
      senderId: userId,
      role: "user",
      contentText: msg.contentText,
      contentType: msg.contentType,
      platform,
      platformMsgId: msg.platformMsgId,
      platformTs: platformTsStr,
      platformRaw: JSON.stringify(msg.raw),
    });

    // Collect user info from mentions + replace @name with @shortLabel
    if (msg.mentions) {
      for (const m of msg.mentions) {
        if (m.platformUserId && m.name) {
          ensureUser(this.db, platform, m.platformUserId, m.name, m.isBot ? "bot_sender" : "mention");
        }
      }
    }
    return messageId;
  }

  private persistInboundMessage(options: {
    inboxId?: number;
    claimToken?: string;
    recoveredMessageId?: number;
    state: "queued" | "processing" | "completed";
    store: () => number;
  }): number {
    const persist = this.db.transaction(() => {
      const messageId = options.recoveredMessageId ?? options.store();
      if (options.inboxId != null && options.claimToken) {
        if (options.state === "queued") {
          this.transport.markInboundQueued?.(options.inboxId, options.claimToken, messageId);
        } else if (options.state === "processing") {
          this.transport.markInboundProcessing?.(options.inboxId, options.claimToken, messageId);
        } else {
          this.transport.markInboundQueued?.(options.inboxId, options.claimToken, messageId);
          this.transport.markInboundTerminal?.(options.inboxId, options.claimToken, "completed");
        }
      }
      return messageId;
    });
    return persist();
  }

  /** Check if a platform message was sent by the bot */
  private isMessageFromBot(platform: string, platformMsgId: string): boolean {
    const msg = getMessageByPlatformId(this.db, platform, platformMsgId);
    return msg?.senderId === this.botUserId;
  }

  /**
   * Build reply quoted block (indented as sub-field of `- msg:`).
   * Returns `"  quoted:\n    msg: \"label: content\""` or empty string.
   */
  private buildReplyQuoted(platform: string, parentPlatformMsgId: string): string {
    // First try DB
    const dbMsg = getMessageByPlatformId(this.db, platform, parentPlatformMsgId);
    if (dbMsg?.contentText) {
      const label = getUserShortLabel(this.db, dbMsg.senderId);
      const escaped = escapeYamlContent(dbMsg.contentText);
      return `  quoted:\n    msg: "${label}: ${escaped}"`;
    }

    // Fallback: try API (async — cache result for next time)
    this.transport.getMessageContent(parentPlatformMsgId).then((content) => {
      if (content && dbMsg) {
        // Update the existing message's content for future lookups
        updateMessageContent(this.db, dbMsg.id, content);
        this.log.debug("fetched and cached reply context from API", { parentMsgId: parentPlatformMsgId });
      } else if (content) {
        this.log.debug("fetched reply context from API (no DB record to update)", { parentMsgId: parentPlatformMsgId });
      }
    }).catch(() => {});

    return "";
  }

  /** Persist a user's admin role in both memory and DB */
  private setAdminRole(userId: string, role: AdminRole, source: string, platformId?: string): void {
    const existing = this.adminRoles.get(userId);
    if (existing === role) return;
    // Never downgrade owner via this method
    if (existing === "owner" && role === "admin") return;
    this.adminRoles.set(userId, role);
    setUserAdminRole(this.db, userId, role);
    this.log.info("admin role set", { userId, role, source, platformId });
  }

  /** Remove admin from both memory and DB (cannot remove owner) */
  private removeAdmin(userId: string): boolean {
    if (this.adminRoles.get(userId) === "owner") return false;
    this.adminRoles.delete(userId);
    setUserAdminRole(this.db, userId, "none");
    this.log.info("admin removed", { userId });
    return true;
  }

  /** Restore admin users from local DB only. This must stay fast during startup. */
  private restoreAdminsFromDb(): void {
    for (const { id, role } of getAdminUserIds(this.db)) {
      this.adminRoles.set(id, role);
      this.log.info("admin restored from DB", { userId: id, role });
    }
  }

  /** Detect platform app creator in the background. */
  private async detectAppCreatorAdmin(): Promise<void> {
    const platform = this.botIdentity.platform;
    try {
      const creatorId = await withTimeout({
        label: "app creator detection",
        timeoutMs: STARTUP_PLATFORM_TIMEOUT_MS,
        fn: async () => this.transport.getAppCreatorId(),
      });
      if (creatorId) {
        const userId = ensureUser(this.db, platform, creatorId, undefined, undefined);
        this.setAdminRole(userId, "owner", "app_creator", creatorId);
      }
    } catch (err) {
      this.log.warn("failed to detect app creator", { error: String(err) });
    }
  }

  /**
   * 内置命令拦截：匹配 /xxx 格式的消息，命中则直接处理并返回 true。
   * //xxx 视为强制透传给 agent，本地不拦截。
   * 未命中返回 false，消息继续走 agent 流程。
   *
   * 分发顺序：
   *   1. 内置命令 switch（含 /loop、/cron 的查看、帮助和取消）
   *   2. 管理员 shell 命令（tryShellCommand）
   *   3. return false → 转发给 agent
   */
  private handleBuiltinCommand(text: string, userId: string, chatId: string, platformChatId: string, chatType: string, msgId?: string): boolean {
    if (!this.isBuiltinCommand(text, userId)) return false;

    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const isAdmin = this.adminRoles.has(userId);

    // 1. 内置命令
    switch (cmd) {
      case "/restart": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "restart 仅管理员可用。");
          return true;
        }
        this.log.info("builtin command: restart", { userId });
        this.triggerRestart({ platformChatId });
        return true;
      }
      case "/update": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "/update 仅管理员可用。");
          return true;
        }
        this.log.info("builtin command: update", { userId });
        this.handleUpdate(chatId, platformChatId, msgId, isUpdateConfirmedArg(parts[1]));
        return true;
      }
      case "/service": {
        this.log.info("builtin command: service", { userId });
        this.sendStatus(chatId, platformChatId, msgId);
        return true;
      }
      case "/new": {
        this.log.info("builtin command: reset-session", { userId, cmd, chatId });
        this.startSessionTransition(chatId, () => this.resetSession(chatId, platformChatId, msgId));
        return true;
      }
      case "/worker": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "/worker 仅管理员可用。");
          return true;
        }
        this.handleWorkerCommand(parts.slice(1), chatId, platformChatId, msgId);
        return true;
      }
      case "/goal": {
        this.handleGoalCommand(parts.slice(1), userId, chatId, platformChatId, msgId);
        return true;
      }
      case "/loop":
      case "/cron": {
        this.handleScheduleBuiltinCommand(
          cmd === "/loop" ? "loop" : "cron",
          parts.slice(1),
          userId,
          chatId,
          chatType === "group" ? "group" : "p2p",
          platformChatId,
          msgId,
        );
        return true;
      }
      case "/agent": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "/agent 仅管理员可用。");
          return true;
        }
        void this.handleAgentCommand(parts.slice(1), chatId, platformChatId, msgId).catch((err) => {
          this.log.error("agent command failed", { error: String(err) });
          this.sendAgentCard(chatId, platformChatId, msgId, "Agent", `处理 /agent 失败: ${String(err)}`);
        });
        return true;
      }
      case "/model": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "/model 仅管理员可用。");
          return true;
        }
        this.handleModelCommand(parts.slice(1), chatId, platformChatId, msgId);
        return true;
      }
      case "/effort": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "/effort 仅管理员可用。");
          return true;
        }
        this.handleEffortCommand(parts.slice(1), chatId, platformChatId, msgId);
        return true;
      }
      case "/admin": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "/admin 仅管理员可用。");
          return true;
        }
        this.handleAdminCommand(parts.slice(1), userId, chatId, platformChatId, msgId);
        return true;
      }
      case "/help": {
        this.log.info("builtin command: help", { userId });
        this.sendHelpCard(chatId, platformChatId, msgId, isAdmin);
        return true;
      }
      case "/stop": {
        this.log.info("builtin command: stop", { userId, chatId });
        const activeRun = this.runtimeState.getActiveRun(chatId);
        const hasActiveRun = !!activeRun;
        const pendingBefore = this.queue.pendingCount(chatId);
        if (activeRun) {
          this.markRuntimeRun(activeRun.runId, "stopped");
        }
        if (hasActiveRun && this.chatSessions.has(chatId)) {
          this.cancelChat(chatId).catch(() => {});
        }
        if (hasActiveRun || this.queue.isBusy(chatId)) {
          this.queue.cancel(chatId);
        }
        const dropped = this.queue.drain(chatId);
        this.log.info("stop command applied", {
          userId,
          chatId,
          activeRunId: activeRun?.runId ?? null,
          activeRunStage: activeRun?.stage ?? null,
          pendingBefore,
          dropped,
        });
        if (hasActiveRun) {
          if (dropped > 0) {
            this.replyText(chatId, platformChatId, msgId, `已停止当前任务，并清空 ${dropped} 条排队消息。`);
          } else {
            this.replyText(chatId, platformChatId, msgId, "已停止当前任务。");
          }
        } else {
          if (dropped > 0) {
            this.replyText(chatId, platformChatId, msgId, `当前没有正在执行的任务，已清空 ${dropped} 条排队消息。`);
          } else {
            this.replyText(chatId, platformChatId, msgId, "当前没有正在执行的任务。");
          }
        }
        return true;
      }
      case "/clear": {
        this.log.info("builtin command: clear", { userId, chatId });
        const dropped = this.queue.drain(chatId);
        if (dropped > 0) {
          this.replyText(chatId, platformChatId, msgId, `已清空 ${dropped} 条排队消息。`);
        } else {
          this.replyText(chatId, platformChatId, msgId, "队列是空的，没啥可清的。");
        }
        return true;
      }
      case "/flush": {
        this.log.info("builtin command: flush", { userId, chatId });
        const pending = this.queue.pendingCount(chatId);
        const activeRun = this.runtimeState.getActiveRun(chatId);
        if (pending === 0) {
          this.replyText(chatId, platformChatId, msgId, "队列是空的，没有需要 flush 的消息。");
        } else if (activeRun) {
          this.markRuntimeRun(activeRun.runId, "stopped");
          if (this.chatSessions.has(chatId)) {
            this.cancelChat(chatId).catch(() => {});
          }
          this.queue.cancel(chatId);
          this.replyText(chatId, platformChatId, msgId, `中断当前回复，合并处理队列中的 ${pending} 条消息。`);
        } else {
          this.replyText(chatId, platformChatId, msgId, `队列中有 ${pending} 条消息，即将处理。`);
        }
        this.log.info("flush command applied", {
          userId,
          chatId,
          activeRunId: activeRun?.runId ?? null,
          activeRunStage: activeRun?.stage ?? null,
          pending,
          stoppedActiveRun: !!(pending > 0 && activeRun),
        });
        return true;
      }
      case "/task": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "/task 仅管理员可用。");
          return true;
        }
        const taskSub = parts[1]?.toLowerCase();
        if (taskSub === "stop") {
          this.stopAllTasks(chatId, platformChatId, msgId);
          return true;
        }
        const taskPrompt = parts.slice(1).join(" ").trim();
        if (!taskPrompt) {
          this.replyText(chatId, platformChatId, msgId, "用法：/task <任务描述>\n子命令：/task stop");
          return true;
        }
        this.log.info("builtin command: task", { userId, chatId, promptLength: taskPrompt.length });
        this.replyText(chatId, platformChatId, msgId, "任务已提交，完成后会发送结果。");
        this.processIndependentSession(chatId, userId, taskPrompt, taskPrompt.slice(0, 40), "task").catch((err) => {
          this.log.error("task execution failed", { chatId, error: String(err) });
        });
        return true;
      }
      case "/status": {
        this.log.info("builtin command: status", { userId, chatId });
        this.sendRunningList(chatId, platformChatId, msgId);
        return true;
      }
      case "/history": {
        this.log.info("builtin command: history", { userId, chatId });
        this.sendShellHistory(chatId, platformChatId, msgId);
        return true;
      }
    }

    // 2. 管理员 shell 命令：检查首个 token 是否在 PATH 中，是则执行，否则转发 agent
    if (isAdmin) {
      const shellCmd = text.slice(1); // 去掉 / 前缀
      const firstToken = shellCmd.split(/\s+/)[0];
      if (firstToken && commandExistsSync(firstToken)) {
        this.tryShellCommand(shellCmd, userId, chatId, chatType, platformChatId, msgId);
        return true;
      }
    }

    // 3. 未识别的 / 命令，交给 agent 处理
    return false;
  }

  private isBuiltinCommand(text: string, userId: string): boolean {
    if (!text.startsWith("/") || text.startsWith("//")) return false;
    const firstToken = text.split(/\s+/, 1)[0]?.toLowerCase();
    if (firstToken && HYBRID_SCHEDULE_COMMANDS.has(firstToken)) {
      const parts = text.trim().split(/\s+/);
      const subcommand = parts[1]?.toLowerCase();
      return subcommand === undefined || SCHEDULE_BUILTIN_SUBCOMMANDS.has(subcommand);
    }
    // /goal：无参 = 查询（本地）；带参 = 创建（放行，由 hybrid 翻译层转发给 Agent）
    if (firstToken === "/goal") {
      return text.trim().split(/\s+/).length <= 1;
    }
    // /worker：on/off/config/无参 = 本地管理；其余参数 = 派发任务（放行，翻译转发）
    if (firstToken === "/worker") {
      const subcommand = text.trim().split(/\s+/)[1]?.toLowerCase();
      return subcommand === undefined || WORKER_BUILTIN_SUBCOMMANDS.has(subcommand);
    }
    if (firstToken && BUILTIN_COMMANDS.has(firstToken)) return true;
    if (!this.adminRoles.has(userId)) return false;
    const executable = text.slice(1).split(/\s+/, 1)[0];
    return !!executable && commandExistsSync(executable);
  }

  private handleScheduleBuiltinCommand(
    mode: "loop" | "cron",
    args: string[],
    userId: string,
    chatId: string,
    chatType: "p2p" | "group",
    platformChatId: string,
    msgId?: string,
  ): void {
    const subcommand = args[0]?.toLowerCase() ?? "list";
    if (subcommand === "list" || subcommand === "ls") {
      this.sendScheduleBuiltinList(mode, chatId, platformChatId, msgId);
      return;
    }
    if (subcommand === "help" || subcommand === "--help") {
      const label = mode === "loop" ? "Loop" : "Cron";
      this.replyText(
        chatId,
        platformChatId,
        msgId,
        `/${mode} 或 /${mode} list：查看 ${label} 任务\n/${mode} del <id>：删除任务\n/${mode} <任务与时间>：创建任务`,
      );
      return;
    }

    const rawId = args[1];
    const idMatch = rawId?.match(/^(?:(loop|cron):)?(\d+)$/i);
    const idPrefix = idMatch?.[1]?.toLowerCase();
    const id = Number(idMatch?.[2]);
    if (!idMatch || (idPrefix && idPrefix !== mode) || !Number.isInteger(id) || id <= 0) {
      this.replyText(chatId, platformChatId, msgId, `用法：/${mode} del <id>`);
      return;
    }
    try {
      if (mode === "loop") {
        const job = cancelLoopJobForAccess(this.db, id, {
          currentChatId: chatId,
          chatType,
          userId,
        });
        if (!job) {
          this.replyText(chatId, platformChatId, msgId, `loop:${id} 不存在或已经结束。`);
          return;
        }
        if (job.status === "running") this.cancelActiveLoopRun(id, chatId);
      } else {
        const job = deleteCronJobForAccess(this.db, id, {
          currentChatId: chatId,
          chatType,
          userId,
        });
        if (!job) {
          this.replyText(chatId, platformChatId, msgId, `cron:${id} 不存在或已经结束。`);
          return;
        }
        void this.cancelRunningCronSessions(id);
      }
      this.replyText(chatId, platformChatId, msgId, `已删除 ${mode}:${id}。`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const message = detail.includes("own") ? "只能删除自己创建的任务。" : `删除失败：${detail}`;
      this.replyText(chatId, platformChatId, msgId, message);
    }
  }

  private sendScheduleBuiltinList(
    mode: "loop" | "cron",
    chatId: string,
    platformChatId: string,
    msgId?: string,
  ): void {
    const lines: string[] = [];
    if (mode === "loop") {
      for (const job of listLoopJobs(this.db, chatId)) {
        const progress = job.maxTimes ? `${job.runCount}/${job.maxTimes}` : `${job.runCount} 次`;
        lines.push(`· loop:${job.id} · ${job.status} · 每 ${formatLoopInterval(job.intervalSeconds)} · ${progress}`);
        lines.push(`  ${escapeLarkMarkdownText(job.prompt.replace(/\s+/g, " ").slice(0, 120))}`);
      }
    } else {
      for (const job of listCronJobs(this.db, chatId)) {
        const schedule = job.cronExpr
          ? `${job.cronExpr}（${job.timezone}）`
          : formatLocalDateTimeWithTZ(job.runAt!, job.timezone);
        const progress = job.maxTimes ? ` · ${job.runCount}/${job.maxTimes}` : job.runCount ? ` · 已执行 ${job.runCount} 次` : "";
        lines.push(`· cron:${job.id} · ${job.status} · ${schedule}${progress}`);
        lines.push(`  ${escapeLarkMarkdownText(job.prompt.replace(/\s+/g, " ").slice(0, 120))}`);
      }
    }
    if (lines.length === 0) lines.push(`当前没有 ${mode === "loop" ? "Loop" : "Cron"} 任务。`);
    lines.push("", `创建：/${mode} <任务与时间>`, `删除：/${mode} del <id>`);
    const content = lines.join("\n");
    this.transport.sendCard(platformChatId, mode === "loop" ? "Loop" : "Cron", content, undefined, msgId)
      .then((pmid) => { this.storeBotResponse(chatId, content, pmid); })
      .catch((err) => this.log.error("schedule list send failed", { mode, chatId, error: String(err) }));
  }

  private async cancelRunningCronSessions(id: number): Promise<void> {
    const running = [...this.runningTasks.values()].filter(
      (task) => task.source === "cron" && task.cronJobId === id,
    );
    await Promise.all(running.map((task) => task.backend.cancelSession(task.agentSession).catch((err) => {
      this.log.warn("failed to stop cancelled Cron session", { id, error: String(err) });
    })));
  }

  private cancelActiveLoopRun(id: number, chatId: string): void {
    const active = this.activeLoopRuns.get(id);
    if (!active || active.chatId !== chatId) return;
    if (active.runId) this.markRuntimeRun(active.runId, "stopped");
    // 先 abort 当前 queue run，RunManager 会立即结束等待，聊天随后继续处理 pending。
    this.queue.cancel(chatId);
    const session = this.chatSessions.get(chatId);
    if (session) {
      void this.agent.cancelSession(session.agentSession).catch((err) => {
        this.log.warn("failed to stop cancelled Loop session", { id, chatId, error: String(err) });
      });
    }
  }

  /** //xxx 表示强制透传给 agent，实际发送时去掉一个前缀 / */
  private normalizeUserTextForAgent(text: string): string {
    return text.startsWith("//") ? text.slice(1) : text;
  }

  /** 回复文本：有 msgId 时引用回复，否则直接发送，并存入 DB */
  private replyText(chatId: string, platformChatId: string, msgId: string | undefined, text: string): void {
    const sendPromise = msgId
      ? this.transport.sendReply(platformChatId, text, msgId)
      : this.transport.sendText(platformChatId, text);
    sendPromise.then((pmid) => {
      this.storeBotResponse(chatId, text, pmid);
    }).catch(() => {});
  }

  /**
   * /list：列出所有运行中的会话（主 session + 独立 task），含最近日志。
   */
  private sendRunningList(chatId: string, platformChatId: string, msgId?: string): void {
    const cliAgent = this.agent as CliAgentBackend<any>;
    const sections: string[] = [];
    let count = 0;

    // 主会话 Runtime State
    const activeRun = this.runtimeState.getActiveRun(chatId);
    if (activeRun) {
      count++;
      const elapsed = formatUptime(Date.now() - activeRun.startedAt);
      const session = this.chatSessions.get(chatId);
      const agentSid = (session && typeof cliAgent.getAgentSessionId === "function")
        ? cliAgent.getAgentSessionId(session.agentSession.id)
        : undefined;
      const statusLabel = activeRun.stage === "agent_running" || activeRun.stage === "sending_response"
        ? "处理中" : displayRunStage(activeRun.stage);

      const mainLines: string[] = [];
      mainLines.push(`**⚡ ${statusLabel}** · ${elapsed}`);
      if (this.botIdentity.model) {
        mainLines.push(`模型: ${this.botIdentity.model}`);
      }
      if (agentSid) {
        mainLines.push(`Session: ${agentSid}`);
      }
      mainLines.push(`本轮: ${activeRun.triggerMessageIds.length} 条消息 · 队列: ${this.queue.pendingCount(chatId)}`);
      sections.push(mainLines.join("\n"));

      const a = typeof cliAgent.getActivity === "function"
        ? (session ? cliAgent.getActivity(session.agentSession.id) : undefined)
        : undefined;
      if (a?.status === "running" && a.recentLines.length > 0) {
        const logBlock = a.recentLines.map((l) => l.replace(/`{3,}/g, "``").slice(0, ERROR_DISPLAY_MAX_LEN)).join("\n");
        sections.push(`\`\`\`\n${logBlock}\n\`\`\``);
      }
    } else {
      const latestRun = this.runtimeState.getRunsForChat(chatId).at(-1);
      if (latestRun?.stage === "failed") {
        sections.push("**最近失败**");
        sections.push([
          `stage: ${latestRun.stage}`,
          `run: ${latestRun.runId}`,
          latestRun.lastError ? `error: ${latestRun.lastError}` : undefined,
        ].filter((line): line is string => !!line).join("\n"));
      } else {
        const recentEvents = getRecentRuntimeEvents(this.db, {
          botId: this.botIdentity.name,
          chatId,
          limit: 20,
        });
        const latestDoneEvent = recentEvents.find((event) => event.event === "done");
        const latestFailedEvent = recentEvents.find((event) => event.event === "failed" || event.event === "failed_by_restart");
        if (latestFailedEvent && !(latestDoneEvent && latestDoneEvent.id > latestFailedEvent.id)) {
          sections.push("**最近失败**");
          sections.push([
            `stage: ${latestFailedEvent.stage}`,
            `event: ${latestFailedEvent.event}`,
            `run: ${latestFailedEvent.runId}`,
            latestFailedEvent.error ? `error: ${latestFailedEvent.error}` : undefined,
          ].filter((line): line is string => !!line).join("\n"));
        }
      }
    }

    // 独立 task
    const tasks = [...this.runningTasks.entries()].filter(([, t]) => t.chatId === chatId);
    for (const [sessionId, t] of tasks) {
      count++;
      const elapsed = formatUptime(Date.now() - t.startedAt);
      const taskCliAgent = t.backend instanceof CliAgentBackend ? t.backend : undefined;
      const a = taskCliAgent?.getActivity(sessionId);
      const status = a?.compacting ? "压缩上下文" : a?.executingTool ? "执行工具" : "处理中";
      sections.push(`**${t.source === "cron" ? "⏰" : "⚡"} ${t.description}**（${status} · ${elapsed}）`);
      if (a && a.recentLines.length > 0) {
        const logBlock = a.recentLines.map((l) => l.replace(/`{3,}/g, "``").slice(0, ERROR_DISPLAY_MAX_LEN)).join("\n");
        sections.push(`\`\`\`\n${logBlock}\n\`\`\``);
      }
    }

    // Worker：只显示当前 chat 关联的非终态 Job 和待验收结果，避免跨会话泄露。
    const workerStatus = this.buildWorkerStatusSection(chatId);
    if (workerStatus) {
      count += workerStatus.runningCount;
      sections.push(workerStatus.content);
    }

    const loopStatus = this.buildLoopStatusSection(chatId);
    if (loopStatus) {
      count += loopStatus.runningCount;
      sections.push(loopStatus.content);
    }

    if (count === 0 && sections.length === 0) {
      this.replyText(chatId, platformChatId, msgId, "当前没有正在执行的任务。");
      return;
    }

    const latestAgentOutputAt = this.getLatestAgentOutputAt(chatId);
    const latestDataAt = latestAgentOutputAt === undefined
      ? workerStatus?.latestUpdatedAt
      : workerStatus?.latestUpdatedAt === undefined
        ? latestAgentOutputAt
        : Math.max(latestAgentOutputAt, workerStatus.latestUpdatedAt);
    const latestDataAge = latestDataAt !== undefined
      ? formatRelativeAgeMs(latestDataAt)
      : "无";
    const content = [
      `**最新数据:** ${latestDataAge}`,
      ...sections,
    ].join("\n\n");
    const header = count > 0 ? `Running · ${count} 个任务` : "Status";
    this.transport.sendCard(platformChatId, header, content, undefined, msgId)
      .then((pmid) => { this.storeBotResponse(chatId, content, pmid); })
      .catch((err) => this.log.error("running list card send failed", { chatId, error: String(err) }));
  }

  /** 构建当前 chat 的 Worker 状态；查询失败时静默跳过，不影响 /status 主体。 */
  private buildWorkerStatusSection(chatId: string): {
    content: string;
    runningCount: number;
    latestUpdatedAt?: number;
  } | undefined {
    try {
      const jobs = this.db.prepare(
        `SELECT j.worker_profile_id, j.prompt, j.status, j.created_at, j.started_at, j.updated_at
         FROM worker_jobs j
         JOIN worker_works w ON w.id = j.work_id
         WHERE w.bot_id = ? AND w.source_chat_id = ?
           AND w.status IN ('active', 'cancelling')
           AND j.status IN ('queued', 'running', 'cancelling')
         ORDER BY CASE j.status WHEN 'running' THEN 0 WHEN 'cancelling' THEN 1 ELSE 2 END,
                  j.created_at ASC`,
      ).all(this.botIdentity.name, chatId) as Array<{
        worker_profile_id: string;
        prompt: string;
        status: "queued" | "running" | "cancelling";
        created_at: string;
        started_at: string | null;
        updated_at: string;
      }>;
      const continuations = this.db.prepare(
        `SELECT c.work_id, c.status, c.created_at, c.claimed_at
         FROM agent_continuations c
         JOIN worker_works w ON w.id = c.work_id AND w.bot_id = c.bot_id
         WHERE c.bot_id = ? AND w.bot_id = ? AND c.chat_id = ?
           AND w.source_chat_id = c.chat_id
           AND c.status IN ('pending', 'claimed')`,
      ).all(this.botIdentity.name, this.botIdentity.name, chatId) as Array<{
        work_id: string;
        status: "pending" | "claimed";
        created_at: string;
        claimed_at: string | null;
      }>;

      const running = jobs.filter((job) => job.status === "running").length;
      const queued = jobs.filter((job) => job.status === "queued").length;
      const cancelling = jobs.filter((job) => job.status === "cancelling").length;
      const continuationWorkStates = new Map<string, "pending" | "claimed">();
      for (const continuation of continuations) {
        const current = continuationWorkStates.get(continuation.work_id);
        if (current !== "claimed") continuationWorkStates.set(continuation.work_id, continuation.status);
      }
      const waitingCount = [...continuationWorkStates.values()].filter((status) => status === "pending").length;
      const reviewingCount = [...continuationWorkStates.values()].filter((status) => status === "claimed").length;
      if (jobs.length === 0 && waitingCount === 0 && reviewingCount === 0) return undefined;

      let latestUpdatedAt: number | undefined;
      const considerLatest = (value: string | null) => {
        if (!value) return;
        const timestamp = parseSqlUtcDatetime(value);
        if (timestamp !== undefined) latestUpdatedAt = latestUpdatedAt === undefined ? timestamp : Math.max(latestUpdatedAt, timestamp);
      };
      for (const job of jobs) considerLatest(job.updated_at);
      for (const continuation of continuations) considerLatest(continuation.claimed_at ?? continuation.created_at);

      const lines = [
        "**⚙️ Worker**",
        `运行中: **${running}** · 排队: **${queued}** · 取消中: **${cancelling}** · 等待验收: **${waitingCount}** · 验收中: **${reviewingCount}**`,
      ];
      const shownJobs = jobs.slice(0, 5);
      for (const job of shownJobs) {
        const statusLabel = job.status === "running" ? "运行中" : job.status === "cancelling" ? "取消中" : "排队";
        const since = parseSqlUtcDatetime(job.started_at ?? job.created_at);
        const elapsed = since === undefined ? "" : ` · ${formatUptime(Math.max(0, Date.now() - since))}`;
        const promptText = stripInternalWorkerTags(job.prompt).replace(/\s+/g, " ").trim().slice(0, 80) || "(无任务描述)";
        const profileId = escapeLarkMarkdownText(job.worker_profile_id.slice(0, 40));
        const prompt = escapeLarkMarkdownText(promptText);
        lines.push(`· ${profileId} · ${statusLabel}${elapsed} — ${prompt}`);
      }
      if (jobs.length > shownJobs.length) {
        lines.push(`· 另有 ${jobs.length - shownJobs.length} 个 Worker Job`);
      }
      if (waitingCount > 0) {
        lines.push(`· ${waitingCount} 个需求已产出结果，等待主会话验收`);
      }
      if (reviewingCount > 0) {
        lines.push(`· ${reviewingCount} 个需求正在由主会话验收`);
      }
      return { content: lines.join("\n"), runningCount: running + cancelling, latestUpdatedAt };
    } catch (err) {
      this.log.warn("failed to build worker status", { chatId, error: String(err) });
      return undefined;
    }
  }

  private buildLoopStatusSection(chatId: string): {
    content: string;
    runningCount: number;
  } | undefined {
    const jobs = listLoopJobs(this.db, chatId);
    if (jobs.length === 0) return undefined;
    const lines = ["**🔁 持续跟进**"];
    for (const job of jobs.slice(0, 5)) {
      let status: string;
      if (job.status === "running") {
        const startedAt = job.runStartedAt ? parseSqlUtcDatetime(job.runStartedAt) : undefined;
        status = startedAt === undefined ? "执行中" : `执行中 · ${formatUptime(Math.max(0, Date.now() - startedAt))}`;
      } else if (job.status === "queued") {
        status = "已排队";
      } else if (job.status === "paused") {
        status = "连续失败，已暂停";
      } else {
        status = `等待中 · 下次 ${formatLocalDateTimeWithTZ(job.nextRunAt, TZ)}`;
      }
      const progress = job.maxTimes ? `${job.runCount}/${job.maxTimes}` : `${job.runCount} 次`;
      const prompt = escapeLarkMarkdownText(job.prompt.replace(/\s+/g, " ").slice(0, 80));
      lines.push(`· #${job.id} · ${status} · ${progress} — ${prompt}`);
    }
    if (jobs.length > 5) lines.push(`· 另有 ${jobs.length - 5} 个 Loop`);
    return {
      content: lines.join("\n"),
      runningCount: jobs.filter((job) => job.status === "running" || job.status === "queued").length,
    };
  }

  private stopAllTasks(chatId: string, platformChatId: string, msgId?: string): void {
    const tasks = [...this.runningTasks.entries()].filter(([, t]) => t.chatId === chatId && t.source === "task");
    if (tasks.length === 0) {
      this.replyText(chatId, platformChatId, msgId, "当前没有运行中的 task。");
      return;
    }
    for (const [, t] of tasks) {
      t.backend.cancelSession(t.agentSession).catch(() => {});
    }
    this.replyText(chatId, platformChatId, msgId, `正在停止 ${tasks.length} 个 task。`);
  }

  private sendStatus(chatId: string, platformChatId: string, msgId?: string): void {
    const uptimeMs = Date.now() - this.startedAt;
    const uptimeStr = formatUptime(uptimeMs);

    const activeSessions = this.chatSessions.size;

    const cronRow = this.db.prepare(
      "SELECT COUNT(*) as count FROM cron_jobs WHERE status = 'active'",
    ).get() as { count: number } | undefined;
    const cronCount = cronRow?.count ?? 0;
    const loopRow = this.db.prepare(
      "SELECT COUNT(*) as count FROM loop_jobs WHERE status IN ('active', 'queued', 'running', 'paused')",
    ).get() as { count: number } | undefined;
    const loopCount = loopRow?.count ?? 0;

    const content = [
      `**Bot:** ${this.botIdentity.name}`,
      `**Version:** ${this.version}`,
      `**Platform:** ${this.botIdentity.platform}`,
      `**Backend:** ${displayBackendType(this.backendType)}`,
      `**Model:** ${this.botIdentity.model ?? "default"}`,
      `**Uptime:** ${uptimeStr}`,
      `**Active sessions:** ${activeSessions}`,
      `**Cron jobs:** ${cronCount}`,
      `**Loop jobs:** ${loopCount}`,
      `**Path:** \`${path.dirname(path.resolve(process.argv[1]))}\``,
      `**Working directory:** \`${this.workingDirectory}\``,
    ].join("\n");

    const send = this.transport.sendCard(platformChatId, "service", content, undefined, msgId);
    send
      .then((pmid) => {
        this.storeBotResponse(chatId, content, pmid);
        this.log.info("status sent", { platformChatId });
      })
      .catch((err) => this.log.error("status send failed", { platformChatId, error: String(err) }));
  }

  /** /status：与 watchdog 一致，取 agent activity.lastActiveAt */
  private getLatestAgentOutputAt(chatId: string): number | undefined {
    let latest: number | undefined;
    const considerSession = (backend: AgentBackend, agentSessionId: string) => {
      if (!(backend instanceof CliAgentBackend)) return;
      const activity = backend.getActivity(agentSessionId);
      if (activity?.lastActiveAt) {
        latest = latest === undefined
          ? activity.lastActiveAt
          : Math.max(latest, activity.lastActiveAt);
      }
    };

    const chatSession = this.chatSessions.get(chatId);
    if (chatSession) {
      considerSession(this.agent, chatSession.agentSession.id);
    }
    for (const [sessionId, task] of this.runningTasks) {
      if (task.chatId === chatId) {
        considerSession(task.backend, sessionId);
      }
    }

    return latest;
  }

  // ── 独立 Cron 执行 ────────────────────────────────────────────

  /** 检测配置版本变化并热更新 registry（只影响新 Job）。Watchdog 轮询调用；CLI 侧 apply/rollback 后自动生效。 */
  reloadTeamConfigIfChanged(): void {
    if (!this.workerConfig?.teamConfigStore) return;
    const active = this.workerConfig.teamConfigStore.getActiveConfig();
    const version = active.version;
    if (version === this.lastTeamConfigVersion) return;
    this.lastTeamConfigVersion = version;
    if (active.config.profiles.length > 0) {
      this.workerConfig.registry.setProfiles(active.config.profiles.map(teamProfileToWorkerProfile));
      // 校验配置的 backend 类型在可用列表内（尽早暴露拼写错误，避免每个 Job 执行时才失败）
      const available = new Set(this.getAvailableBackends());
      for (const profile of active.config.profiles) {
        if (profile.backend && !available.has(profile.backend)) {
          this.log.warn("team config profile references unavailable backend", {
            version: version ?? null,
            profileId: profile.id,
            backend: profile.backend,
            available: [...available],
          });
        }
      }
      this.log.info("team config reloaded from db", { version: version ?? null });
    }
  }

  /** /goal：创建或查询 Goal（纯内存，重启即断）。 */
  /** /goal 内置命令：只处理查询（无参）。带参创建由 hybrid 翻译层转发给 Agent（nbt goal start）。 */
  private handleGoalCommand(
    args: string[],
    userId: string,
    chatId: string,
    platformChatId: string,
    msgId?: string,
  ): void {
    const existing = this.activeGoals.get(chatId);
    if (!existing) {
      this.replyText(chatId, platformChatId, msgId, "当前没有进行中的 Goal。");
      return;
    }
    const elapsed = formatUptime(Math.max(0, Date.now() - existing.startedAt));
    this.replyText(chatId, platformChatId, msgId,
      `**⚡ 当前 Goal**\n目标：${existing.objective.slice(0, 200)}\n轮次：${existing.turnCount} · 耗时：${elapsed}`);
  }

  /** nbt goal finish：Agent 显式结束请求（令牌 + Run 一致性校验；三条件结算在回合收尾时做）。 */
  async executeGoalFinishCommand(chatId: string, command: GoalFinishCommand, scheduleToken?: string): Promise<{ output: string }> {
    const goal = this.activeGoals.get(chatId);
    if (!goal) throw new Error("当前没有进行中的 Goal");
    if (goal.endedAt) throw new Error("Goal 已结束");
    const activeRun = this.runtimeState.getActiveRun(chatId);
    if (!activeRun || activeRun.stage !== "agent_running") {
      throw new Error("Goal finish 必须在当前 Goal 的活动回合内执行");
    }
    // 绑定 Goal 的 Run：只有该 Goal 自己的回合（同一 run）能提交 finish，防过期进程结算
    if (goal.startRunId && activeRun.runId !== goal.startRunId) {
      throw new Error("Goal finish 必须来自该 Goal 的回合");
    }
    if (scheduleToken && scheduleToken !== this.chatScheduleTokens.get(chatId)) {
      throw new Error("Goal finish 请求缺少或携带错误的会话令牌");
    }
    goal.finishRequested = true;
    goal.finishRunId = activeRun.runId;
    goal.outcome = command.outcome;
    goal.conclusion = command.conclusion;
    this.log.info("goal finish requested", { chatId, outcome: command.outcome, runId: activeRun.runId });
    return { output: `finish requested: ${command.outcome}` };
  }

  /** nbt goal start：Agent 主动进入 Goal 模式。当前回合计入第 1 轮（process 检测 startRunId 后由 runGoalLoop 接管）。 */
  async executeGoalStartCommand(chatId: string, objective: string, scheduleToken?: string): Promise<{ output: string }> {
    if (objective.length > GOAL_DEFAULTS.maxObjectiveLength) {
      throw new Error(`目标过长（上限 ${GOAL_DEFAULTS.maxObjectiveLength} 字符）`);
    }
    const existing = this.activeGoals.get(chatId);
    if (existing && !existing.endedAt) {
      throw new Error("已有进行中的 Goal");
    }
    if ([...this.activeGoals.values()].length >= GOAL_DEFAULTS.maxConcurrentGoals) {
      throw new Error("全局并发 Goal 已达上限");
    }
    const activeRun = this.runtimeState.getActiveRun(chatId);
    if (!activeRun || activeRun.stage !== "agent_running") {
      throw new Error("nbt goal start 必须在当前 Agent 回合内调用");
    }
    if (scheduleToken && scheduleToken !== this.chatScheduleTokens.get(chatId)) {
      throw new Error("nbt goal start 请求缺少或携带错误的会话令牌");
    }
    const goal: ActiveGoal = {
      objective,
      turnCount: 1,
      startedAt: Date.now(),
      startRunId: activeRun.runId,
      progressSteps: [],
      progressStatus: "",
    };
    this.activeGoals.set(chatId, goal);
    this.log.info("goal started by agent", { chatId, objectiveLength: objective.length, runId: activeRun.runId });
    return { output: `goal started: ${objective.slice(0, 100)}` };
  }

  /**
   * nbt goal progress：中间轮静默记录进展（不发送 IM）。
   * content = 本次步骤（一两句话，保留最近 N 条）；status = 全局进展状态（覆盖式：任务整体进行到哪、还剩什么）。
   */
  async executeGoalProgressCommand(chatId: string, content: string, status?: string): Promise<{ output: string }> {
    const goal = this.activeGoals.get(chatId);
    if (!goal) throw new Error("当前没有进行中的 Goal");
    if (goal.endedAt) throw new Error("Goal 已结束");
    // 与 start/finish 同级：必须在当前 Goal 的活动回合内调用
    const activeRun = this.runtimeState.getActiveRun(chatId);
    if (!activeRun || activeRun.stage !== "agent_running") {
      throw new Error("nbt goal progress 必须在当前 Goal 的活动回合内执行");
    }
    const step = content.trim();
    if (!step) throw new Error("progress 内容不能为空");
    if (step.length > GOAL_DEFAULTS.maxProgressLength) {
      throw new Error(`progress 步骤过长（上限 ${GOAL_DEFAULTS.maxProgressLength} 字符）`);
    }
    goal.progressSteps.push(step);
    if (goal.progressSteps.length > GOAL_DEFAULTS.maxProgressSteps) {
      goal.progressSteps.shift();
    }
    const globalStatus = status?.trim();
    if (globalStatus) {
      if (globalStatus.length > GOAL_DEFAULTS.maxProgressLength) {
        throw new Error(`--status 过长（上限 ${GOAL_DEFAULTS.maxProgressLength} 字符）`);
      }
      goal.progressStatus = globalStatus;
    }
    this.log.info("goal progress", { chatId, step: step.slice(0, 60), hasStatus: !!globalStatus });
    return { output: `progress recorded` };
  }

  /** nbt restart --wake：重启完成后注入主会话任务（在原上下文触发 Agent 回合）。 */
  async executeWakeCommand(chatId: string, prompt: string): Promise<{ output: string }> {
    this.queue.push({
      chatId,
      text: prompt,
      timestamp: Date.now(),
      triggerKind: "restart_wake",
    });
    if (this.queue.isStopped()) {
      throw new Error("引擎队列已停止，wake 未投递");
    }
    this.log.info("restart wake queued", { chatId, promptLength: prompt.length });
    return { output: "wake queued" };
  }

  /** 构建 Goal 每轮注入的引导（目标原文 + 检查引导 + 进展：全局状态与最近步骤，防遗忘）。 */
  private buildGoalTurnPrompt(goal: ActiveGoal): string {
    const parts: string[] = [];
    if (goal.progressStatus) parts.push(`状态：${goal.progressStatus}`);
    if (goal.progressSteps.length > 0) parts.push(`步骤：${goal.progressSteps.join("；")}`);
    const progressBlock = parts.length > 0 ? `\n【进展汇总】\n${parts.join("\n")}` : "";
    return `【当前 Goal】${goal.objective}
【检查引导】本轮结束后确认：
- 目标是否已达成？是 → 调用 nbt goal finish --outcome achieved --conclusion <一句话结论（建议附证据）>
- 未完成即结束（卡住/条件不满足/无法继续）→ 调用 nbt goal finish --outcome not_achieved --conclusion <当前状态与总结>
- 连续多轮无明显推进（无实质动作、只是重复汇报）→ 调用 nbt goal finish 结束，不要空转
- 都没有 → 继续推进下一步（不要只汇报计划）；推进时可调用 nbt goal progress <步骤> --status <全局状态> 记录进展${progressBlock}`;
  }

  /** Goal 主循环：同一个 Run 内连续多轮执行，直到 Agent 调用 finish 或保护触发。 */
  private async runGoalLoop(
    chatId: string,
    goal: ActiveGoal,
    runId: string | undefined,
    signal?: AbortSignal,
    initialTurn?: RunAgentResult,
  ): Promise<void> {
    const chatSession = await this.getOrCreateSession(chatId, undefined, signal);
    if (!chatSession) {
      this.log.error("goal run without active session", { chatId, runId: runId ?? null });
      this.finishGoal(chatId, goal, "failed", "会话不可用");
      this.cleanupGoal(chatId, goal, runId);
      return;
    }
    let consecutiveFailures = 0;

    // 初始回合（Agent 通过 nbt goal start 主动进入）：本轮已执行（turnCount 在 start 时置 1），直接处理其结果
    if (initialTurn) {
      const settled = await this.consumeGoalTurn(chatSession, chatId, goal, runId, initialTurn, signal);
      if (settled) {
        this.cleanupGoal(chatId, goal, runId);
        return;
      }
    }

    while (!goal.endedAt) {
      // 保护：外层轮次上限（turnCount 在本轮开始前计数，含正在执行的这一轮）
      if (goal.turnCount >= GOAL_DEFAULTS.maxTurns) {
        this.log.warn("goal max turns reached", { chatId, turnCount: goal.turnCount });
        this.finishGoal(chatId, goal, "failed", `达到最大轮次 ${GOAL_DEFAULTS.maxTurns}`);
        break;
      }
      if (signal?.aborted) {
        this.log.info("goal aborted by signal", { chatId });
        this.finishGoal(chatId, goal, "stopped", "已中断");
        break;
      }

      // 本轮开始：计数（finish 的那一轮也算已执行）
      goal.turnCount += 1;

      // 每轮注入：目标 + 检查引导（无令牌，Agent 零感知）
      const messageToSend = this.buildGoalTurnPrompt(goal);
      this.log.info("goal turn", { chatId, runId: runId ?? null, turnCount: goal.turnCount });

      let agentResult;
      try {
        agentResult = await this.runManager.runAgent({
          runId: runId!,
          chatId,
          session: chatSession.agentSession,
          message: messageToSend,
          signal,
        });
      } catch (err) {
        consecutiveFailures += 1;
        this.log.warn("goal turn failed", { chatId, error: String(err), consecutiveFailures });
        if (consecutiveFailures >= GOAL_DEFAULTS.maxConsecutiveFailures) {
          this.finishGoal(chatId, goal, "failed", `连续 ${GOAL_DEFAULTS.maxConsecutiveFailures} 次执行失败`);
          break;
        }
        continue;
      }
      consecutiveFailures = 0;

      const settled = await this.consumeGoalTurn(chatSession, chatId, goal, runId, agentResult, signal);
      if (settled) break;
    }

    this.cleanupGoal(chatId, goal, runId);
  }

  /** 处理一轮 Goal 回合结果：停止/结算（交付）/未结束时落库统计。返回 true = Goal 已结束。 */
  private async consumeGoalTurn(
    chatSession: ChatSession,
    chatId: string,
    goal: ActiveGoal,
    runId: string | undefined,
    agentResult: RunAgentResult,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (agentResult.status === "stopped") {
      this.log.info("goal turn stopped", { chatId });
      this.finishGoal(chatId, goal, "stopped", "回合被取消");
      return true;
    }
    const response = agentResult.response;

    // Agent 请求结束（finish 校验通过）
    if (goal.finishRequested) {
      this.log.info("goal finishing", { chatId, outcome: goal.outcome });
      const outcome = goal.outcome === "achieved" ? "achieved" : "not_achieved";
      const conclusion = goal.conclusion ?? response.text.trim().slice(0, 500);
      // 引用触发消息（/goal 那条）；只发一次最终正文，发送成功后结算
      const activeRun = this.runtimeState.getActiveRun(chatId);
      const replyToMsgId = activeRun?.replyToPlatformMsgId ?? undefined;
      const delivered = await this.deliverGoalFinalResponse(chatSession, goal, response, replyToMsgId, signal);
      this.finishGoal(chatId, goal, outcome, conclusion, delivered);
      return true;
    }

    // 未结束：本轮正文进历史 + session 统计（与主对话同一收尾逻辑），不发送 IM
    this.recordAgentTurn(chatSession, chatId, response);
    return false;
  }

  /** 回合收尾（主对话与 Goal 共用）：assistant 正文落库 + session 统计（turn_count +1 等）。返回落库消息 ID。 */
  private recordAgentTurn(chatSession: ChatSession, chatId: string, response: AgentResponse): number {
    const replyMsgId = storeMessage(this.db, {
      chatId,
      senderId: this.botUserId!,
      sessionId: chatSession.sessionId,
      role: "assistant",
      contentText: response.text,
      platform: this.botIdentity.platform,
    });
    const cumulativeBytes = this.agent.getCumulativeBytes?.(chatSession.agentSession.id) ?? 0;
    const agentSessionId = this.agent.getAgentSessionId?.(chatSession.agentSession.id);
    this.db.prepare(`
      UPDATE sessions
      SET message_count = (SELECT COUNT(*) FROM messages WHERE session_key = ?),
          turn_count = turn_count + 1,
          cumulative_bytes = ?,
          last_active_at = datetime('now'),
          end_msg_id = ?,
          agent_session_id = COALESCE(agent_session_id, ?),
          backend_type = COALESCE(backend_type, ?)
      WHERE id = ?
    `).run(
      chatSession.sessionId,
      cumulativeBytes,
      replyMsgId,
      agentSessionId ?? null,
      this.backendType,
      chatSession.sessionId,
    );
    return replyMsgId;
  }

  /** Goal 结束清理：状态与 Run 收尾（队列释放由 process 返回后 queue 接管）。 */
  private cleanupGoal(chatId: string, goal: ActiveGoal, runId: string | undefined): void {
    // Goal 从 Worker 验收回合接管时消费的 Continuation：标记完成（不释放，防重复投递）
    if (goal.adoptedContinuationIds?.length && this.workerConfig) {
      try {
        this.workerConfig.jobService.completeDeliveredContinuations({
          continuationIds: goal.adoptedContinuationIds,
          agentTurnId: runId ?? "",
          conclusion: goal.conclusion ?? "",
        });
        this.log.info("goal adopted continuations settled", {
          chatId,
          continuationIds: goal.adoptedContinuationIds,
        });
      } catch (err) {
        this.log.error("goal adopted continuations settle failed", { chatId, error: String(err) });
      }
    }
    this.activeGoals.delete(chatId);
    this.activeWorkerAgentCommands.delete(chatId);
    this.activeScheduleAgentCommands.delete(chatId);
    if (runId) {
      if (goal.outcome === "failed") {
        this.markRuntimeRun(runId, "failed", goal.conclusion ?? "goal failed");
      } else if (goal.outcome === "stopped") {
        this.markRuntimeRun(runId, "stopped");
      } else {
        this.markRuntimeRun(runId, "done");
      }
    }
    this.log.info("goal ended", { chatId, outcome: goal.outcome, turnCount: goal.turnCount });
  }

  /** 结算 Goal 并记录结果（纯内存；发送成功与否影响 outcome 落库摘要）。 */
  private finishGoal(
    chatId: string,
    goal: ActiveGoal,
    outcome: ActiveGoal["outcome"],
    conclusion: string,
    delivered = true,
  ): void {
    goal.endedAt = Date.now();
    goal.outcome = outcome;
    if (conclusion) goal.conclusion = conclusion;
    this.log.info("goal settled", { chatId, outcome, delivered });
  }

  /** 发送 Goal 最终正文（唯一一次 IM 交付，卡片 + 引用触发消息 + 汇总 + footer；与常规交付同一降级链）；失败时返回 false。 */
  private async deliverGoalFinalResponse(
    chatSession: ChatSession,
    goal: ActiveGoal,
    response: AgentResponse,
    replyToMsgId: string | undefined,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const text = stripInternalWorkerTags(response.text);
    const elapsedMs = Date.now() - goal.startedAt;
    // footer 与常规交付一致：session 短 ID + session 累计轮次 + context + model
    // （goal 自身轮次在 header 中展示，不参与 footer 的 #N）
    const agentSessionId = this.agent.getAgentSessionId?.(chatSession.agentSession.id);
    const sessionStats = this.db.prepare(
      "SELECT turn_count FROM sessions WHERE id = ?",
    ).get(chatSession.sessionId) as { turn_count: number } | undefined;
    const result = await this.responseSender.sendFinalResponse({
      chatId: chatSession.platformChatId,
      header: buildGoalCardHeader(goal, elapsedMs),
      content: `> 目标：${goal.objective}\n\n${text}`,
      footer: buildResponseFooter({
        sessionId: agentSessionId ?? chatSession.sessionId,
        turnCount: sessionStats?.turn_count,
        contextTokens: response.contextTokens,
        compactCount: response.compactCount,
        model: response.model,
      }),
      replyToMsgId,
      signal,
    });
    if (!result.ok) {
      this.log.warn("goal final response delivery failed", { error: result.error, methodsTried: result.methodsTried });
    }
    return result.ok;
  }

  /** /worker：Worker 开关与配置管理（管理员）。 */
  private handleWorkerCommand(args: string[], chatId: string, platformChatId: string, msgId?: string): void {
    const store = this.workerConfig?.teamConfigStore;
    if (!store) {
      this.replyText(chatId, platformChatId, msgId, "当前 Bot 未启用 Worker。");
      return;
    }
    const sub = args[0];
    const jobService = this.workerConfig?.jobService;

    switch (sub) {
      case "on": {
        store.setEnabled(true);
        this.replyText(chatId, platformChatId, msgId, "✅ Worker 已开启。直接提需求即可，我会把长任务拆给 Worker 后台执行，完成后自动汇报。");
        return;
      }
      case "off": {
        store.setEnabled(false);
        this.replyText(chatId, platformChatId, msgId, "Worker 已暂停。之后的新需求不会再派给 Worker；正在执行的任务会继续完成。");
        return;
      }
      default: {
        // 直接显示状态（无子命令）；配置调整走对话（由我执行 nbt worker config）
        if (sub === "config") {
          this.replyText(chatId, platformChatId, msgId, "配置不用命令改，直接说要调整什么（并发、角色、目录权限等），我来生成并应用。");
          return;
        }
        const enabled = store.isEnabled();
        const active = store.getActiveConfig();
        const running = jobService?.listJobsByStatus("running").length ?? 0;
        const queued = jobService?.listJobsByStatus("queued").length ?? 0;
        const profiles = this.workerConfig?.registry.list() ?? [];
        const accessNames: Record<string, string> = {
          read_only: "只读",
          direct: "直接修改",
        };
        const profileLines = profiles.map((p) => {
          const parts = [`**${p.displayName}**`];
          if (p.description) parts.push(p.description);
          parts.push(`${accessNames[p.access] ?? p.access}${p.maxConcurrent ? ` · 并发 ${p.maxConcurrent}` : ""}`);
          return `· ${parts.join(" — ")}`;
        });
        const content = [
          `**Worker**：${enabled ? "✅ 开启" : "⛔ 暂停"}`,
          `· 任务执行：**${running}** 个进行中，**${queued}** 个排队`,
          `· 并发上限：同时最多执行 **${active.config.maxConcurrent}** 个任务`,
          `· 单个需求最多拆 **${active.config.maxJobsPerWork}** 个子任务`,
          `· 配置：${active.version ? `版本 **${active.version}**` : "默认（未自定义）"}`,
          ...(profileLines.length > 0 ? ["", "**可用角色**", ...profileLines] : []),
          "",
          "配置调整直接说需求，我来改 · `/worker on|off` 开关",
        ].join("\n");
        this.sendWorkerCard(chatId, platformChatId, msgId, "Worker · 状态", content);
      }
    }
  }

  /** /worker 卡片发送：与其他内置命令卡片一致的样式。 */
  private sendWorkerCard(chatId: string, platformChatId: string, msgId: string | undefined, header: string, content: string): void {
    this.transport.sendCard(platformChatId, header, content, undefined, msgId)
      .then((pmid) => { this.storeBotResponse(chatId, content, pmid); })
      .catch((err) => this.log.error("teams card send failed", { chatId, error: String(err) }));
  }

  // ── Cron job execution（独立 session） ──

  /**
   * 执行定时任务：创建独立 session，发送 prompt，结果用 ⏰ header 卡片发送，完成后归档。
   * 不走用户消息队列，不干扰当前对话 session。
   */
  async processCronJob(
    chatId: string,
    userId: string,
    prompt: string,
    description: string,
    cronJobId?: number,
    claimToken?: string,
  ): Promise<void> {
    const cronRun = cronJobId !== undefined && claimToken !== undefined ? { cronJobId, claimToken } : undefined;
    return this.processIndependentSession(chatId, userId, prompt, description, "cron", cronRun);
  }

  async reportCronJobFailure(
    chatId: string,
    description: string,
    error: string,
    paused: boolean,
  ): Promise<void> {
    let platformChatId = this.platformChatIds.get(chatId);
    if (!platformChatId) {
      const row = this.db.prepare("SELECT platform_id FROM chats WHERE id = ?").get(chatId) as
        | { platform_id: string }
        | undefined;
      platformChatId = row?.platform_id;
    }
    if (!platformChatId) return;
    const detail = stripInternalWorkerTags(error).trim().slice(0, ERROR_DISPLAY_MAX_LEN);
    const content = paused
      ? `定时任务连续失败 ${CRON_FAILURE_LIMIT} 次，已暂停。\n\n${detail || "未知错误"}`
      : `定时任务执行失败，后续会按计划重试。\n\n${detail || "未知错误"}`;
    const platformMsgId = await this.transport.sendCard(
      platformChatId,
      `⏰ ${description || "Cron 任务"}`,
      content,
    );
    this.storeBotResponse(chatId, content, platformMsgId);
  }

  /** Loop Scheduler 只投递 ID；任务内容在真正轮到该 chat 时重新从 DB 读取。 */
  enqueueLoopJob(loopJobId: number): void {
    const job = getLoopJob(this.db, loopJobId);
    if (!job || job.status !== "queued") return;
    if (!this.platformChatIds.has(job.chatId)) {
      const row = this.db.prepare("SELECT platform_id FROM chats WHERE id = ?").get(job.chatId) as
        | { platform_id: string }
        | undefined;
      if (row) this.platformChatIds.set(job.chatId, row.platform_id);
    }
    this.queue.enqueueLoop(job.chatId, job.id);
    this.log.info("loop job dispatched", { chatId: job.chatId, loopJobId: job.id });
  }

  /** Continuation 投递：认领（pending→claimed）后入队主 Agent 队列（同 chat 串行），内存去重防重复投递。 */
  private enqueueWorkerContinuations(chatId: string, continuationIds: string[]): void {
    const jobService = this.workerConfig?.jobService;
    if (!jobService) return;
    // 确保 platformChatIds 已注册（与 injectPrompt 一致：Worker 场景 chat 一定来自真实会话）
    if (!this.platformChatIds.has(chatId)) {
      const row = this.db.prepare("SELECT platform_id FROM chats WHERE id = ?").get(chatId) as
        | { platform_id: string }
        | undefined;
      if (row) this.platformChatIds.set(chatId, row.platform_id);
    }
    // 认领：markContinuationCompleted 只接受 claimed 状态，投递时必须是 pending→claimed。
    // 重复投递由 DB 状态保证（claimed 不会被扫描到；attempt 上限兜底），
    // 不使用内存集合——内存集合会在 stale 重置后与 DB 脱节导致永久卡死。
    const claimed: string[] = [];
    for (const id of continuationIds) {
      if (jobService.claimContinuation(id, `dispatch-${Date.now()}`)) {
        claimed.push(id);
      }
    }
    if (claimed.length === 0) return;
    this.queue.enqueueContinuation(chatId, claimed);
    this.log.info("worker continuations dispatched", { chatId, continuationIds: claimed });
  }

  /** Worker 事件游标；用来识别 Agent 回合内真正创建的 Job。 */
  private getWorkerEventCursor(): number | undefined {
    if (!this.workerConfig) return undefined;
    try {
      const row = this.db.prepare(
        "SELECT COALESCE(MAX(id), 0) AS cursor FROM worker_events",
      ).get() as { cursor: number };
      return row.cursor;
    } catch {
      // fail-closed：游标读取失败时不做派工标识判断，避免把历史事件误算成本回合创建。
      return undefined;
    }
  }

  /** 游标之后，该 chat 是否创建了新 Job（空 Work 不算已经派工）。 */
  private hasWorkerJobCreatedSince(chatId: string, cursor: number | undefined): boolean {
    if (!this.workerConfig || cursor === undefined) return false;
    try {
      const row = this.db.prepare(
        `SELECT 1
         FROM worker_events e
         JOIN worker_works w ON w.id = e.work_id AND w.bot_id = e.bot_id
         WHERE e.id > ? AND e.event = 'job_created' AND w.source_chat_id = ?
         LIMIT 1`,
      ).get(cursor, chatId);
      return !!row;
    } catch {
      return false;
    }
  }

  /** 重启清理（重启重置）：进行中的 Worker 状态全部终止，不恢复、不重投。
   * 原因写入 error/conclusion（Agent 按需查询 nbt worker get/list 可见）；
   * 未交付的 Continuation 一并失效（不向主 Agent 投递旧结果）。 */
  private cleanupWorkerJobsAfterRestart(): void {
    if (!this.workerConfig) return;
    try {
      const jobResult = this.db.prepare(`
        UPDATE worker_jobs
        SET status = 'failed', error = 'Engine 重启，任务已终止', ended_at = datetime('now')
        WHERE status IN ('queued', 'running', 'cancelling')
      `).run();
      const workResult = this.db.prepare(`
        UPDATE worker_works
        SET status = 'failed', final_conclusion = 'Engine 重启，未完成任务已终止', updated_at = datetime('now')
        WHERE status IN ('active', 'cancelling')
      `).run();
      const contResult = this.db.prepare(`
        UPDATE agent_continuations
        SET status = 'failed', error = 'Engine 重启，Worker 结果未交付', completed_at = datetime('now')
        WHERE status IN ('pending', 'claimed')
      `).run();
      if (jobResult.changes > 0 || workResult.changes > 0 || contResult.changes > 0) {
        this.log.warn("worker state cleaned up after restart", {
          jobs: jobResult.changes,
          works: workResult.changes,
          continuations: contResult.changes,
        });
      }
    } catch (err) {
      this.log.error("failed to clean up worker state after restart", { error: String(err) });
    }
  }

  /** 进程恢复：从 DB 恢复 active 用户会话，重建 backend session（--resume 旧上下文）。
   * 只恢复 source='user' 的会话——cron/task 独立会话不占用 chat 槽位，
   * 避免重启后用户消息 resume 进定时任务会话导致主会话失忆。 */
  async recover(): Promise<void> {
    const rows = this.db.prepare(`
      SELECT s.id, s.chat_id, s.user_id, s.agent_session_id, s.backend_type, c.platform_id, c.type
      FROM sessions s
      JOIN chats c ON s.chat_id = c.id
      WHERE s.status = 'active' AND s.source = 'user'
      ORDER BY s.last_active_at DESC
    `).all() as Array<{
      id: string;
      chat_id: string;
      user_id: string | null;
      agent_session_id: string | null;
      backend_type: AgentBackendType | null;
      platform_id: string;
      type: string;
    }>;

    if (rows.length === 0) return;

    // 每个 chat 只恢复最近的一个 session，跳过重复
    const seen = new Set<string>();
    const uniqueRows = rows.filter((r) => {
      if (seen.has(r.chat_id)) return false;
      seen.add(r.chat_id);
      return true;
    });

    this.log.info("recovering active sessions", { count: uniqueRows.length });

    for (const row of uniqueRows) {
      const chatType = (row.type ?? "p2p") as "p2p" | "group";
      const storedBackendType = normalizeBackend(row.backend_type ?? undefined);
      const canResumeRecoveredSession = storedBackendType !== undefined && storedBackendType === this.backendType;

      if (!canResumeRecoveredSession && storedBackendType !== this.backendType) {
        this.db.prepare(`
          UPDATE sessions
          SET status = 'archive_failed',
              ended_at = datetime('now'),
              last_active_at = datetime('now')
          WHERE id = ?
        `).run(row.id);
        this.log.warn("resetting unrecoverable active session during startup", {
          chatId: row.chat_id,
          sessionId: row.id,
          storedBackendType: storedBackendType ?? "unknown",
          activeBackendType: this.backendType,
        });
        continue;
      }

      // 重建 stable system context
      // 群聊：只注入 bot + chat 信息，不注入用户身份
      const isGroup = chatType === "group";
      const userRow = (!isGroup && row.user_id)
        ? this.db.prepare("SELECT name FROM users WHERE id = ?").get(row.user_id) as { name: string | null } | undefined
        : undefined;
      const isAdmin = row.user_id ? this.adminRoles.has(row.user_id) : false;
      const sessionProfile = buildImportantContext(this.db, {
        botName: this.botIdentity.name,
        botLabel: this.botUserId ? getUserShortLabel(this.db, this.botUserId) : undefined,
        platform: this.botIdentity.platform,
        userName: userRow?.name ?? undefined,
        userId: isGroup ? undefined : (row.user_id ?? undefined),
        chatId: row.chat_id,
        chatLabel: getChatShortLabel(this.db, row.chat_id),
        chatType,
        isAdmin,
        botProfilePath: this.stableContextOptions.botProfilePath,
      });
      const stableContext = this.buildStableSystemContext();
      const scheduleToken = randomUUID();
      this.chatScheduleTokens.set(row.chat_id, scheduleToken);

      try {
        const agentSession = await this.createAgentSession({
          workingDirectory: this.workingDirectory,
          reasoningEffort: this.botIdentity.effort,
          importantContext: stableContext || undefined,
          userId: row.user_id ?? undefined,
          chatId: row.chat_id,
          chatType,
          dbPath: this.dbPath,
          botId: this.botIdentity.platformBotId,
          botName: this.botIdentity.name,
          platform: this.botIdentity.platform,
          model: this.botIdentity.model,
          isAdmin,
          botProfilePath: this.stableContextOptions.botProfilePath,
          agentSessionId: canResumeRecoveredSession ? (row.agent_session_id ?? undefined) : undefined,
          scheduleToken,
        });

        // fallback 模式下：仅新建 session 时需要注入（resume 的 session 已有上下文）
        const isResuming = canResumeRecoveredSession && !!row.agent_session_id;
        if (!isResuming) {
          this.pendingMessageContext.set(row.chat_id, sessionProfile);
        }
        if (this.agent.needsStableUserPrefix() && stableContext && !isResuming) {
          this.pendingStableContext.set(row.chat_id, stableContext);
        }

        this.chatSessions.set(row.chat_id, {
          agentSession,
          sessionId: row.id,
          platformChatId: row.platform_id,
          userId: row.user_id ?? "",
          hasReplied: true, // recovered sessions skip reply-to
        });
        this.platformChatIds.set(row.chat_id, row.platform_id);
        if (row.user_id) this.chatUserIds.set(row.chat_id, row.user_id);

        this.log.info("session recovered", {
          chatId: row.chat_id,
          sessionId: row.id,
          resumed: canResumeRecoveredSession && !!row.agent_session_id,
          storedBackendType: storedBackendType ?? "unknown",
          activeBackendType: this.backendType,
        });
      } catch (err) {
        this.log.error("failed to recover session", {
          chatId: row.chat_id,
          sessionId: row.id,
          error: String(err),
        });
      }
    }
  }

  /**
   * 组装 Worker 的上下文：稳定系统规则 + Profile 角色说明 + Job 目标。
   * 第一版不注入主会话 transcript 和用户记忆。
   * direct Job 的 execDir 即目标仓库本身，git 操作由 Worker 按指引自行执行。
   */
  private buildWorkerPrompt(job: Job, execDir: string, artifactDir?: string): string {
    // 角色内容（定义/原则/工作流）已在 system prompt 注入；这里只组装任务详情
    const stable = this.buildStableSystemContext();
    const work = this.workerConfig?.jobService.getWork(job.workId);
    const parts: string[] = [];
    if (stable) parts.push(stable);
    const profile = this.workerConfig?.registry.get(job.workerProfileId);
    let writeRule: string;
    if (profile?.access === "direct") {
      // 写任务：直接在目标目录（目标仓库）修改，git 操作由 Worker 自行执行。
      // base 提交/分支由任务内容（job.prompt）指定。
      writeRule = `当前目录就是目标仓库（${job.workdir}）本身，直接在仓库内修改。git 操作由你自行执行：按任务要求 checkout 目标提交、创建独立分支、修改、提交；不 push、不发布。`;
    } else if (artifactDir) {
      // 只读 + 产物目录：工作目录只读，落盘内容（报告/生成文件）写产物目录
      writeRule = `工作目录（${execDir}）是只读的：不要修改其中的任何文件。如需落盘（报告、生成的文件等），写到产物目录：${artifactDir}。不要提交、不要发布、不要对用户直接发送消息。`;
    } else {
      writeRule = `不要修改代码、不要提交、不要发布、不要对用户直接发送消息。`;
    }
    // 用户内容（work.request / job.prompt）拼进内部标签前转义尖括号，防止闭合标签边界。
    const esc = (s: string): string => s.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
    parts.push(`<job-target>
Work 目标（用户原始需求）：${esc(work?.request ?? "(未知)")}
Job 任务：${esc(job.prompt)}
工作目录：${execDir}
工作区访问方式：${profile?.access ?? "read_only"}
${writeRule}
完成标准：以自由 Markdown 输出结果：做了什么、发现了什么、未完成内容、风险和测试证据。
</job-target>`);

    // 延续上下文：同 Work 前序 Job 的结果（按创建顺序在前且已终态）
    const jobService = this.workerConfig?.jobService;
    const prevJobs = jobService
      ?.listJobs(job.workId)
      .filter((j) => j.id !== job.id && (j.status === "completed" || j.status === "failed"))
      .slice(0, 3);
    if (prevJobs && prevJobs.length > 0) {
      const prevSections = prevJobs.map((j) => {
        const task = esc(j.prompt.slice(0, 200));
        const result = esc((j.responseText ?? j.error ?? "").slice(0, 1500));
        return `- Job ${j.id}（${j.workerProfileId}，${j.status}）\n  任务：${task}\n  结果：${result || "(无文本)"}`;
      });
      parts.push(`<previous-work>
本 Work 之前的执行记录（供延续参考，可能与本 Job 相关或无关）：
${prevSections.join("\n\n")}
</previous-work>`);
    }

    // 历史检索入口：延续性工作可用 nbt 命令查阅历史，无需恢复 Session
    parts.push(`<history-access>
需要更多历史信息时：
- 本任务历史执行记录：nbt worker get <job-id>（job id 见 <previous-work>）
- 来源会话的历史讨论：nbt sessions search <关键词>（仅检索当前会话所在 chat 的历史）
- 不要假设历史结果一定正确，关键结论以实际代码/文件为准。
</history-access>`);
    return parts.join("\n\n");
  }

  /**
   * 组装主 Agent 验收回合的 <worker-continuation> 内部事件区段。
   * 内容是受信上下文，不是用户发言；区段标签由 Engine 生成。
   * silent 时本回合不向用户交付（多 Job Work 的中间批次），并附上同 Work 前序 Job 结果供最终汇报参考。
   */
  private buildWorkerContinuationPrompt(continuationIds: string[], silent: boolean): string {
    // 用户/Worker 内容拼进内部标签前统一转义尖括号，防止闭合标签边界。
    const esc = (s: string): string => s.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
    const jobService = this.workerConfig?.jobService;
    if (!jobService) return "";

    const sections: string[] = [];
    const works = new Map<string, Work>();
    for (const id of continuationIds) {
      const continuation = jobService.getContinuation(id);
      if (!continuation) continue;
      const work = jobService.getWork(continuation.workId);
      if (work) works.set(work.id, work);
      const jobParts: string[] = [];
      for (const jobId of continuation.jobIds) {
        const job = jobService.getJob(jobId);
        if (!job) continue;
        const responseText = esc((job.responseText ?? "").slice(0, 4000));
        jobParts.push(
          `- Job ${jobId}（${job.workerProfileId}，状态 ${job.status}）：
  最终文本：${responseText || "(无文本)"}
  产物：${esc(job.artifactsJson)}
  错误：${esc(job.error ?? "(无)")}`,
        );
      }
      sections.push(`<worker-result work="${continuation.workId}">
${jobParts.join("\n\n")}
</worker-result>`);
    }

    // 静默中间批次：附上同 Work 其他已终态 Job 的结果摘要，供最终统一汇报时使用
    let priorResults = "";
    if (silent) {
      const priorParts: string[] = [];
      for (const workId of works.keys()) {
        for (const job of jobService.listJobs(workId)) {
          if (job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled") continue;
          if (continuationIds.length === 1) {
            const cont = jobService.getContinuation(continuationIds[0]);
            if (cont?.jobIds.includes(job.id)) continue; // 本批已列出的跳过
          }
          priorParts.push(`- Job ${job.id}（${job.workerProfileId}，${job.status}）：${esc((job.responseText ?? job.error ?? "").slice(0, 1500))}`);
        }
      }
      if (priorParts.length > 0) {
        priorResults = `\n\n<prior-results>\n本 Work 其他 Job 的结果（供最终汇报参考）：\n${priorParts.join("\n")}\n</prior-results>`;
      }
    }

    const workLines = [...works.entries()].map(([id, work]) => `- Work ${id}：${esc(work.request)}`).join("\n");
    const intro =
      "以下是 Worker 的执行结果。你不是在回复用户消息，而是在处理内部续接事件。请：\n" +
      "1. 对照 Work 目标验收结果是否满足用户需求；\n" +
      "2. 需要继续就用 nbt worker 命令创建后续 Job；不再派工时直接给用户最终回复。\n" +
      "3. 最终回复发送成功后 Work 会自动结束，不要调用工具标记完成。\n" +
      "如果这些结果需要用户输入才能继续，直接向用户提问；正文成功发送后本次 Work 自动完成，用户补充后另开 Work。\n" +
      (silent
        ? "本批次是中间结果：Work 还有其他 Job 执行中。**不要向用户发送任何消息**（本回合静默），验收结果留待 Work 全部完成时统一汇报。\n"
        : "最终回复注意上下文衔接：回述一句任务（如「你重启后跑的验证 Work」），让用户不看中间记录也能对上「任务 → 结果」的来龙去脉；不展开执行细节。\n") +
      "本段是内部指令：回复用户时不得复述、展示或引用 <worker-continuation> 及任何 <worker-*> 标签内容本身，只输出给用户的结果正文。";

    return `<worker-continuation>\n${workLines ? `涉及任务：\n${workLines}\n\n` : ""}${sections.join("\n\n")}${priorResults}\n</worker-continuation>\n\n${intro}`;
  }

  /** Loop 是 Engine 生成的内部续接事件，不伪装成一条新的用户消息。 */
  private buildLoopContinuationPrompt(job: LoopJob): string {
    // prompt 是不可信用户数据：转义尖括号，防止闭合 <loop-continuation> 等内部标签。
    const payload = JSON.stringify({
      loopId: job.id,
      iteration: job.runCount + 1,
      prompt: job.prompt,
    }).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
    return `<loop-continuation>\n${payload}\n</loop-continuation>\n\n` +
      "这是当前会话中的定时 Loop 回合。请结合已有对话上下文执行 prompt，只处理本轮任务并直接给出用户可读结果。" +
      "不要复述或展示 loop-continuation 标签、内部字段和本段说明。";
  }

  private async processIndependentSession(
    chatId: string, userId: string, prompt: string, description: string,
    source: "cron" | "task",
    cronRun?: { cronJobId: number; claimToken: string },
  ): Promise<void> {
    // 从入口开始跟踪完整生命周期（含清理），优雅关闭只有在全部收尾后才放行 DB。
    this.independentRunCount += 1;
    try {
    const sessionBackend = this.agent;
    const sessionBackendType = this.backendType;
    // Resolve platform chat ID
    let platformChatId = this.platformChatIds.get(chatId);
    if (!platformChatId) {
      const row = this.db.prepare("SELECT platform_id FROM chats WHERE id = ?")
        .get(chatId) as { platform_id: string } | undefined;
      if (!row) {
        this.log.warn(`${source} job: chat not found`, { chatId });
        throw new Error(`${source} job: chat not found`);
      }
      platformChatId = row.platform_id;
      this.platformChatIds.set(chatId, platformChatId);
    }

    const chatRow = this.db.prepare("SELECT type FROM chats WHERE id = ?").get(chatId) as { type: string } | undefined;
    const chatType = (chatRow?.type ?? "p2p") as "p2p" | "group";

    // Build session dynamic context（场景 + 用户记忆）
    const isGroup = chatType === "group";
    // 群聊定时任务不能继承创建者身份；否则执行时的群聊内容可能诱导 Agent
    // 读取创建者私有记忆或私有任务，再把结果发回群聊。
    const sessionUserId = isGroup ? undefined : userId;
    const userRow = sessionUserId
      ? this.db.prepare("SELECT name FROM users WHERE id = ?").get(sessionUserId) as { name: string | null } | undefined
      : undefined;
    const isAdmin = sessionUserId ? this.adminRoles.has(sessionUserId) : false;
    const sessionProfile = buildImportantContext(this.db, {
      botName: this.botIdentity.name,
      botLabel: this.botUserId ? getUserShortLabel(this.db, this.botUserId) : undefined,
      platform: this.botIdentity.platform,
      userName: userRow?.name ?? undefined,
      userId: sessionUserId,
      chatId,
      chatLabel: getChatShortLabel(this.db, chatId),
      chatType,
      isAdmin,
      botProfilePath: this.stableContextOptions.botProfilePath,
    });
    const stableContext = this.buildStableSystemContext();

    // 独立任务只注入可见任务索引和归档入口，不自动带入执行时最新聊天内容。
    // 这样 Cron 的行为只由创建时保存的 prompt 决定，不会被后续群聊消息改变。
    const normalContext = [
      buildActiveTaskContext(this.workingDirectory, chatType, sessionUserId),
      buildSessionArchiveContext(getSessionArchiveDirectory(this.archiveHome, this.botIdentity.name, chatId)),
    ].filter(Boolean).join("\n\n");

    if (cronRun && !this.isCronClaimCurrent(cronRun.cronJobId, cronRun.claimToken)) {
      throw new Error(`cron:${cronRun.cronJobId} 已取消或运行令牌失效`);
    }

    // Create independent agent session
    const agentSession = await this.createAgentSession({
      workingDirectory: this.workingDirectory,
      reasoningEffort: this.botIdentity.effort,
      importantContext: stableContext || undefined,
      userId: sessionUserId,
      chatId,
      chatType,
      dbPath: this.dbPath,
      botId: this.botIdentity.platformBotId,
      botName: this.botIdentity.name,
      platform: this.botIdentity.platform,
      model: this.botIdentity.model,
      isAdmin,
      botProfilePath: this.stableContextOptions.botProfilePath,
    }, sessionBackend);

    // Create session record
    const sessionId = randomUUID().slice(0, 8);
    this.db.prepare(`
      INSERT INTO sessions (id, chat_id, user_id, source, status, started_at, last_active_at, backend_type)
      VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'), ?)
    `).run(sessionId, chatId, userId, source, sessionBackendType);

    // 独立任务的 prompt 只属于 session transcript，不是平台收到的用户消息。
    storeMessage(this.db, {
      chatId,
      senderId: this.botUserId!,
      sessionId,
      role: "user",
      contentText: prompt,
      contentType: "internal_prompt",
      platform: this.botIdentity.platform,
    });

    // Inject context prefix
    let messageToSend = prompt;
    const contextParts: string[] = [];
    if (sessionBackend.needsStableUserPrefix() && stableContext) {
      contextParts.push(stableContext);
    }
    contextParts.push(sessionProfile);
    if (normalContext) {
      contextParts.push(`<session-state>\n${normalContext}\n</session-state>`);
    }
    contextParts.push(NEW_SESSION_SEARCH_REMINDER);
    if (contextParts.length > 0) {
      messageToSend = `${contextParts.join("\n\n")}\n\n${wrapInjectedUserMessage(prompt)}`;
    }

    this.log.info(`executing ${source} job`, { chatId, sessionId, userId, description });

    this.runningTasks.set(agentSession.id, {
      agentSession, backend: sessionBackend, backendType: sessionBackendType,
      chatId, description, startedAt: Date.now(), source,
      cronJobId: cronRun?.cronJobId,
      cronClaimToken: cronRun?.claimToken,
    });

    try {
      if (cronRun && !this.isCronClaimCurrent(cronRun.cronJobId, cronRun.claimToken)) {
        throw new Error(`cron:${cronRun.cronJobId} 已取消或运行令牌失效`);
      }
      const response = await sessionBackend.sendMessage(agentSession, messageToSend);

      if (response.cancelled) {
        this.log.warn(`${source} job was cancelled`, { chatId, sessionId });
        throw new Error(`${source} job was cancelled`);
      }

      if (!response.text.trim()) {
        this.log.warn(`empty response from ${source} agent`, { chatId, sessionId });
        response.text = EMPTY_RESPONSE_FALLBACK;
      }

      if (cronRun && !this.isCronClaimCurrent(cronRun.cronJobId, cronRun.claimToken)) {
        throw new Error(`cron:${cronRun.cronJobId} 已取消或运行令牌失效`);
      }

      const agentSessionId = sessionBackend.getAgentSessionId?.(agentSession.id);

      // Build footer
      const footer = buildResponseFooter({
        sessionId: agentSessionId ?? sessionId,
        turnCount: 1,
        contextTokens: response.contextTokens,
        compactCount: response.compactCount,
        model: response.model,
      });

      const emoji = source === "cron" ? "⏰" : "⚡";
      let header = `${emoji} ${description || prompt.slice(0, 40)}`;
      let content = response.text;
      if (cronRun) {
        // 固定标题：会话模式 + ID + 触发节奏；任务内容作为引用放在正文开头
        const cronJob = getCronJob(this.db, cronRun.cronJobId);
        if (cronJob) {
          header = `⏰ 独立会话 cron:${cronRun.cronJobId} · ${describeCronSchedule(cronJob.cronExpr, cronJob.runAt, cronJob.timezone)}`;
          content = `> 任务：${escapeLarkMarkdownText(buildTaskPreview(prompt))}\n\n${response.text}`;
        }
      }
      // 统一最终交付：卡片（带 footer）→ 文本 → 文件降级链，与主对话/Goal 同一套
      const sendResult = await this.responseSender.sendFinalResponse({
        chatId: platformChatId,
        header,
        content,
        footer,
      });
      if (!sendResult.ok) {
        this.log.warn(`${source} final response delivery failed`, {
          chatId, error: sendResult.error, methodsTried: sendResult.methodsTried,
        });
        // 降级链全失败视为交付失败：不写 assistant 消息，任务按失败处理（沿用卡片失败即失败语义）
        throw new Error(`${source} final response delivery failed: ${sendResult.error}`);
      }
      const sentPlatformMsgId = sendResult.platformMsgId;

      // 只有平台确认发送成功后才写 assistant 消息，避免发送失败留下“幽灵回复”。
      const replyMsgId = storeMessage(this.db, {
        chatId,
        senderId: this.botUserId!,
        sessionId,
        role: "assistant",
        contentText: response.text,
        platform: this.botIdentity.platform,
        platformMsgId: sentPlatformMsgId,
      });
      this.db.prepare(`
        UPDATE sessions
        SET message_count = 2,
            turn_count = 1,
            last_active_at = datetime('now'),
            end_msg_id = ?,
            agent_session_id = ?,
            backend_type = ?
        WHERE id = ?
      `).run(replyMsgId, agentSessionId ?? null, sessionBackendType, sessionId);

      this.log.info(`${source} job completed`, { chatId, sessionId, responseLength: response.text.length });
    } catch (err) {
      this.log.error(`${source} job execution failed`, { chatId, sessionId, error: String(err) });
      throw err;
    } finally {
      // 归档/记录可能抛错（如 DB 异常），backend session 关闭与跟踪移除必须在最外层 finally，
      // 保证任何异常都不能绕过资源清理。
      try {
        const archivedAt = utcDateTimeForSql(new Date());
        try {
          await this.archiveTranscript(chatId, sessionId, agentSession, sessionBackend, archivedAt);
          this.db.prepare(`
            UPDATE sessions SET status = 'archived', ended_at = ?, last_active_at = datetime('now'),
                agent_session_id = COALESCE(agent_session_id, ?), backend_type = ?
            WHERE id = ?
          `).run(archivedAt, sessionBackend.getAgentSessionId?.(agentSession.id) ?? null, sessionBackendType, sessionId);
        } catch (archiveErr) {
          const failedStatus = archiveErr instanceof AgentSessionNotStartedError ? "discarded" : "archive_failed";
          try {
            this.db.prepare(`
              UPDATE sessions SET status = ?, ended_at = ?, last_active_at = datetime('now'),
                  agent_session_id = COALESCE(agent_session_id, ?), backend_type = ?
              WHERE id = ?
            `).run(failedStatus, archivedAt, sessionBackend.getAgentSessionId?.(agentSession.id) ?? null, sessionBackendType, sessionId);
          } catch (recordErr) {
            this.log.error(`failed to record ${source} session status`, { chatId, sessionId, error: String(recordErr) });
          }
          const details = { chatId, sessionId, backend: sessionBackendType, error: String(archiveErr) };
          if (failedStatus === "discarded") {
            this.log.info(`${source} session ended before backend assigned an id`, details);
          } else {
            this.log.error(`failed to archive ${source} session`, details);
          }
        }
      } finally {
        await sessionBackend.closeSession(agentSession).catch((closeErr) => {
          this.log.warn(`failed to close ${source} session`, { chatId, sessionId, error: String(closeErr) });
        });
        // 全部清理完成后再移除跟踪，保证优雅关闭等待能看到整个收尾过程。
        this.runningTasks.delete(agentSession.id);
      }
    }
    } finally {
      this.independentRunCount -= 1;
    }
  }

  private isCronClaimCurrent(cronJobId: number, claimToken: string): boolean {
    const row = this.db.prepare(
      "SELECT status, claim_token FROM cron_jobs WHERE id = ?",
    ).get(cronJobId) as { status: string; claim_token: string | null } | undefined;
    return row?.status === "running" && row.claim_token === claimToken;
  }

  /** /new：归档当前 session，让下一条消息自然创建新 session。 */
  private async resetSession(chatId: string, platformChatId: string, msgId?: string): Promise<void> {
    await this.stopActiveRunForSessionTransition(chatId);
    await this.waitForSessionCreation(chatId);
    await this.archiveSession(chatId)
      .then((status) => {
        const text = status === false
          ? "当前没有进行中的会话；下一条消息会新建会话。"
          : status === "archive_failed"
            ? "已开始新会话，当前上下文已清空；旧会话记录归档失败。"
            : "已开始新会话，当前上下文已清空。";
        this.replyText(chatId, platformChatId, msgId, text);
      })
      .catch((err) => {
        this.log.error("reset session failed", { chatId, error: String(err) });
        this.replyText(chatId, platformChatId, msgId, `新建会话失败: ${String(err)}`);
      });
  }

  private startSessionTransition(chatId: string, task: () => Promise<void>): void {
    if (this.sessionTransitionLocks.has(chatId)) return;

    const transitionPromise = task()
      .finally(() => {
        if (this.sessionTransitionLocks.get(chatId) === transitionPromise) {
          this.sessionTransitionLocks.delete(chatId);
        }
        if (!this.globalSessionTransition) this.drainPendingTransitionMessages(chatId);
      });

    this.sessionTransitionLocks.set(chatId, transitionPromise);
  }

  private startGlobalSessionTransition(_triggerChatId: string, task: () => Promise<void>): void {
    if (this.globalSessionTransition) return;
    const localTransitions = [...new Set(this.sessionTransitionLocks.values())];
    const transitionPromise = Promise.resolve().then(async () => {
      await Promise.allSettled(localTransitions);
      await task();
    }).finally(() => {
      if (this.globalSessionTransition !== transitionPromise) return;
      this.globalSessionTransition = undefined;
      for (const chatId of [...this.pendingTransitionMessages.keys()]) this.drainPendingTransitionMessages(chatId);
    });
    this.globalSessionTransition = transitionPromise;
  }

  private async stopActiveRunForSessionTransition(chatId: string): Promise<void> {
    const activeRun = this.runtimeState.getActiveRun(chatId);
    const shouldCancelAgent = !!activeRun && !isTerminalRunStage(activeRun.stage);
    if (shouldCancelAgent) this.markRuntimeRun(activeRun.runId, "stopped");
    if (activeRun || this.queue.isBusy(chatId)) this.queue.cancel(chatId);
    const session = this.chatSessions.get(chatId);
    if (session && shouldCancelAgent) await this.agent.cancelSession(session.agentSession).catch((err) => {
      this.log.warn("failed to cancel session before transition", { chatId, error: String(err) });
    });
  }

  private async waitForSessionCreation(chatId: string): Promise<void> {
    const creation = this.sessionCreations.get(chatId);
    if (creation) await creation.catch((err) => {
      this.log.warn("session creation failed during transition", { chatId, error: String(err) });
    });
  }

  private enqueuePendingTransitionMessage(
    chatId: string,
    msg: NormalizedMessage,
    inboxId?: number,
    claimToken?: string,
    recoveredMessageId?: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const pending = this.pendingTransitionMessages.get(chatId) ?? [];
      pending.push({ msg, inboxId, claimToken, recoveredMessageId, resolve, reject });
      this.pendingTransitionMessages.set(chatId, pending);
      this.markQueuedMessage(msg.chatPlatformId, msg.platformMsgId);
    });
  }

  private drainPendingTransitionMessages(chatId: string): void {
    const pending = this.pendingTransitionMessages.get(chatId);
    if (!pending || pending.length === 0) return;

    this.pendingTransitionMessages.delete(chatId);
    for (const entry of pending) {
      if (entry.msg.platformMsgId) {
        this.processedMsgIds.delete(entry.msg.platformMsgId);
      }
      try {
        Promise.resolve(
          this.handleMessage(entry.msg, true, entry.inboxId, entry.claimToken, entry.recoveredMessageId),
        ).then(entry.resolve, entry.reject);
      } catch (error) {
        entry.reject(error);
      }
    }
  }

  /**
   * /admin 命令：管理员列表/添加/移除。
   * - /admin             → 显示管理员列表
   * - /admin add @某人   → 添加管理员（需要 @ mention）
   * - /admin remove @某人 → 移除管理员
   */
  private handleAdminCommand(args: string[], userId: string, chatId: string, platformChatId: string, msgId?: string): void {
    const sub = args[0]?.toLowerCase();

    if (!sub || sub === "list") {
      const admins = getAdminUserIds(this.db);
      if (admins.length === 0) {
        this.replyText(chatId, platformChatId, msgId, "当前没有管理员。");
        return;
      }
      const lines = admins.map(({ id, role }) => {
        const label = getUserShortLabel(this.db, id);
        return role === "owner" ? `- ${label} (owner)` : `- ${label}`;
      });
      this.replyText(chatId, platformChatId, msgId, `管理员列表：\n${lines.join("\n")}`);
      return;
    }

    if (sub === "add" || sub === "remove") {
      // Only owner can add/remove
      if (!this.isOwner(userId)) {
        this.replyText(chatId, platformChatId, msgId, "只有 owner 可以管理管理员。");
        return;
      }

      const rest = args.slice(1).join(" ");
      const match = rest.match(/@(u\d+)/i);
      if (!match) {
        this.replyText(chatId, platformChatId, msgId, `用法：/admin ${sub} @某人`);
        return;
      }
      const targetUserId = match[1].toLowerCase();

      const userRow = this.db.prepare("SELECT id, name FROM users WHERE id = ?").get(targetUserId) as { id: string; name: string | null } | undefined;
      if (!userRow) {
        this.replyText(chatId, platformChatId, msgId, `用户 ${targetUserId} 不存在。`);
        return;
      }

      const label = getUserShortLabel(this.db, targetUserId);

      if (sub === "add") {
        if (this.adminRoles.has(targetUserId)) {
          this.replyText(chatId, platformChatId, msgId, `${label} 已经是管理员了。`);
          return;
        }
        this.setAdminRole(targetUserId, "admin", "manual");
        this.replyText(chatId, platformChatId, msgId, `已添加 ${label} 为管理员。`);
      } else {
        if (!this.adminRoles.has(targetUserId)) {
          this.replyText(chatId, platformChatId, msgId, `${label} 不是管理员。`);
          return;
        }
        if (this.isOwner(targetUserId)) {
          this.replyText(chatId, platformChatId, msgId, `${label} 是 owner，不能被移除。`);
          return;
        }
        this.removeAdmin(targetUserId);
        this.replyText(chatId, platformChatId, msgId, `已移除 ${label} 的管理员权限。`);
      }
      return;
    }

    this.replyText(chatId, platformChatId, msgId, "用法：/admin [list|add|remove] [@某人]");
  }

  /**
   * /agent 命令：查看或切换 agent backend。
   * - /agent        → 显示当前 backend
   * - /agent <type> → 切换到指定 backend，归档当前 session
   */
  private async handleAgentCommand(args: string[], chatId: string, platformChatId: string, msgId?: string): Promise<void> {
    let capabilities: BackendCapability[];
    try {
      capabilities = await this.getBackendCapabilities();
    } catch (err) {
      this.log.error("failed to refresh backend capabilities", { error: String(err) });
      this.sendAgentCard(chatId, platformChatId, msgId, "Agent", `读取 backend 状态失败: ${String(err)}`);
      return;
    }
    if (args.length === 0) {
      // 显示当前 agent（卡片）
      const currentModel = this.botIdentity.model ?? "default";
      const lines: string[] = [
        `**Agent:** ${this.backendType}`,
        `**Model:** ${currentModel}`,
        "",
      ];
      lines.push("**Agent 状态:**");
      for (let i = 0; i < capabilities.length; i++) {
        const capability = capabilities[i]!;
        const current = capability.backend === this.backendType ? "  ✓ 当前" : "";
        const status = capability.selectable
          ? `可用${capability.version ? ` · ${capability.version}` : ""}`
          : `不可用 · ${capability.reason ?? "当前平台或安装状态不支持"}`;
        lines.push(`  ${i + 1}. ${capability.backend} — ${status}${current}`);
      }
      lines.push("", "`/agent <名字或编号>` 切换");
      this.sendAgentCard(chatId, platformChatId, msgId, "Agent", lines.join("\n"));
      return;
    }

    const available: string[] = capabilities.filter((item) => item.selectable).map((item) => item.backend);
    const availableLabels = capabilities
      .map((item, itemIndex) => item.selectable ? `${itemIndex + 1}. ${item.backend}` : undefined)
      .filter((item): item is string => item !== undefined)
      .join(", ");

    // 支持编号选择：数字当编号，否则当名字走别名解析
    const index = Number(args[0]);
    const target = Number.isInteger(index) && index >= 1 && index <= capabilities.length
      ? capabilities[index - 1]!.backend
      : normalizeBackend(args[0]);

    if (!target || !available.includes(target)) {
      const capability = capabilities.find((item) => item.backend === target);
      const content = capability
        ? `backend **${capability.backend}** 当前不可用：${capability.reason ?? "当前平台或安装状态不支持"}\n\n可选: ${availableLabels}`
        : `无效的 backend: \`${args[0]}\`\n\n可选: ${availableLabels}`;
      this.sendAgentCard(chatId, platformChatId, msgId, "Agent", content);
      return;
    }

    if (target === this.backendType) {
      this.sendAgentCard(chatId, platformChatId, msgId, "Agent", `已经是 **${displayBackendType(target)}**，无需切换。`);
      return;
    }

    if (!this.backendResolver) {
      this.sendAgentCard(chatId, platformChatId, msgId, "Agent", "backend resolver 未配置，无法切换。");
      return;
    }

    this.log.info("switching agent backend", { from: this.backendType, to: target });

    // 归档所有当前 session，获取新 backend（含 start），然后切换
    // 切 backend 时保存当前模型配置，恢复目标 backend 的历史配置（如有），否则走默认。
    const doSwitch = async () => {
      // Validate and start the target before stopping work or archiving the current sessions.
      // A missing CLI or unsupported platform must leave the current backend untouched.
      const newBackend = await this.backendResolver!(target);
      const transitioningChats = new Set(this.chatSessions.keys());
      for (const cid of this.platformChatIds.keys()) {
        if (this.queue.isBusy(cid) || this.runtimeState.getActiveRun(cid)) transitioningChats.add(cid);
      }
      for (const cid of transitioningChats) {
        await this.stopActiveRunForSessionTransition(cid);
      }
      await Promise.allSettled([...this.sessionCreations.values()]);
      for (const cid of [...this.chatSessions.keys()]) {
        await this.archiveSession(cid);
      }

      // 保存当前 backend 的模型配置
      this.backendModelCache.set(this.backendType, {
        model: this.botIdentity.model,
        effort: this.botIdentity.effort,
      });

      this.agent = newBackend;
      this.runManager = new RunManager(this.agent, this.runtimeState, this.responseSender);
      this.backendType = target;

      // 恢复目标 backend 的模型配置（如有），否则不指定，让 backend 用自己的默认
      const cached = this.backendModelCache.get(target)
        ?? getBotBackendModelState(this.db, this.botIdentity.name, target);
      this.botIdentity.model = cached?.model;
      this.botIdentity.effort = cached?.effort;
      this.persistRuntimeState();
    };

    this.startGlobalSessionTransition(chatId, async () => {
      try {
        await doSwitch();
        const model = this.botIdentity.model ?? "default";
        this.sendAgentCard(chatId, platformChatId, msgId, "Agent",
          `已切换到 **${displayBackendType(target)}** (Model: ${model})\n上下文已重置，重启后仍保持当前选择。`);
        this.log.info("agent backend switched (runtime only)", {
          backend: target,
          model: this.botIdentity.model ?? null,
        });
      } catch (err) {
        this.log.error("failed to switch agent backend", { error: String(err) });
        this.sendAgentCard(chatId, platformChatId, msgId, "Agent", `切换失败: ${String(err)}`);
      }
    });
  }

  /**
   * /model 命令：查看或切换模型。
   * - /model              → 显示当前模型 + 可选列表
   * - /model <name|index> → 切主模型
   * - /model reset        → 恢复为配置初始值
   */
  private async handleModelCommand(args: string[], chatId: string, platformChatId: string, msgId?: string): Promise<void> {
    if (args.length === 0) {
      this.sendModelList(chatId, platformChatId, msgId);
      return;
    }

    if (args[0] === "reset") {
      this.botIdentity.model = undefined;
      this.backendModelCache.set(this.backendType, {
        model: undefined,
      });
      this.updateActiveChatSessionModels(chatId, {
        model: undefined,
      });
      this.clearRuntimeModels();
      this.sendAgentCard(chatId, platformChatId, msgId, "Model", "已恢复为默认模型。\n当前会话立即生效。");
      this.log.info("model reset to backend defaults", { backend: this.backendType });
      return;
    }

    if (args[0] === "lite") {
      this.sendAgentCard(chatId, platformChatId, msgId, "Model", "Lite 模型已移除。使用 `/model <名字或编号>` 切换当前模型。");
      return;
    }

    const modelArg = args.join(" ");

    if (!modelArg) {
      this.sendModelList(chatId, platformChatId, msgId);
      return;
    }

    // 解析 model：支持编号或名字
    const candidates = this.buildModelCandidates();
    const resolvedModel = this.resolveModelArg(modelArg, candidates);

    // 新模型名不在候选列表中 → 探测验证（同步等待，先发进度避免看起来卡住）
    if (!candidates.includes(resolvedModel) && this.agent.validateModel) {
      this.log.info("probing unknown model", { model: resolvedModel, backend: this.backendType });
      const progress = `正在探测模型 **${resolvedModel}**，可能需要几十秒，请稍等…`;
      try {
        // 进度提示不入库，避免污染会话历史；发送失败不阻断探测
        await this.transport.sendCard(platformChatId, "Model", progress, undefined, msgId);
      } catch (err) {
        this.log.warn("model probe progress send failed", { model: resolvedModel, error: String(err) });
      }
      try {
        const result = await this.agent.validateModel(resolvedModel);
        if (!result.valid) {
          this.log.info("model probe failed", { model: resolvedModel, error: result.error });
          const lines = [`模型 **${resolvedModel}** 不可用（${result.error ?? "未知错误"}）`, ""];
          if (candidates.length > 0) {
            lines.push("可用模型：");
            for (let i = 0; i < candidates.length; i++) {
              lines.push(`  ${i + 1}. ${candidates[i]}`);
            }
            lines.push("");
            lines.push("`/model <名字或编号>` 切换");
          }
          this.sendAgentCard(chatId, platformChatId, msgId, "Model", lines.join("\n"));
          return;
        }
      } catch (err) {
        this.log.warn("model probe error, allowing switch", { model: resolvedModel, error: String(err) });
      }
    }

    this.botIdentity.model = resolvedModel;
    this.updateActiveChatSessionModels(chatId, { model: resolvedModel });
    this.recordModelHistory(this.backendType, resolvedModel);
    this.persistRuntimeState();
    this.sendAgentCard(chatId, platformChatId, msgId, "Model", `模型已切换为 **${resolvedModel}**\n当前会话立即生效，重启后仍保持当前选择。`);
    this.log.info("model switched (runtime)", { model: resolvedModel, backend: this.backendType });
  }

  /**
   * /effort 命令：查看或切换推理强度。
   * - /effort              → 显示当前 effort + 可选值 + 当前 backend 是否支持
   * - /effort <level>      → 切换（low/medium/high/xhigh/max）
   * - /effort reset        → 恢复 backend 默认
   */
  private handleEffortCommand(args: string[], chatId: string, platformChatId: string, msgId?: string): void {
    const supported = EFFORT_SUPPORTED_BACKENDS.has(this.backendType);

    if (args.length === 0) {
      const lines = [
        `**Agent:** ${this.backendType}`,
        `**Effort:** ${this.botIdentity.effort ?? "default"}`,
        "",
        supported
          ? `可选：${EFFORT_LEVELS.map((level, i) => `${i + 1}. \`${level}\``).join("  ")}`
          : `当前 backend（${this.backendType}）不支持 effort 参数，设置会保存但不生效。`,
        "",
        "`/effort <级别|编号>` 切换",
        "`/effort reset` 恢复默认",
      ];
      this.sendAgentCard(chatId, platformChatId, msgId, "Effort", lines.join("\n"));
      return;
    }

    if (args[0] === "reset") {
      this.botIdentity.effort = undefined;
      this.updateActiveChatSessionModels(chatId, { effort: undefined });
      this.persistRuntimeState();
      this.sendAgentCard(chatId, platformChatId, msgId, "Effort", "已恢复为默认强度。\n当前会话立即生效。");
      this.log.info("effort reset", { backend: this.backendType });
      return;
    }

    // 支持编号或名字（与 /model 一致）：/effort 1 → low
    const raw = args[0];
    const index = Number(raw);
    const level = (Number.isInteger(index) && index >= 1 && index <= EFFORT_LEVELS.length
      ? EFFORT_LEVELS[index - 1]
      : raw) as (typeof EFFORT_LEVELS)[number];
    if (!EFFORT_LEVELS.includes(level)) {
      this.sendAgentCard(
        chatId, platformChatId, msgId, "Effort",
        `无效级别 **${args[0]}**。\n可选：${EFFORT_LEVELS.map((item, i) => `${i + 1}. ${item}`).join("  ")}`,
      );
      return;
    }

    this.botIdentity.effort = level;
    this.updateActiveChatSessionModels(chatId, { effort: level });
    this.persistRuntimeState();
    const note = supported
      ? "当前会话立即生效，重启后仍保持当前选择。"
      : `当前 backend（${this.backendType}）不支持 effort 参数，值已保存；切换到支持的 backend 后自动生效。`;
    this.sendAgentCard(chatId, platformChatId, msgId, "Effort", `推理强度已切换为 **${level}**\n${note}`);
    this.log.info("effort switched (runtime)", { effort: level, backend: this.backendType });
  }

  /** 保存当前 agent/model 运行时选择；失败不影响当前命令执行。 */
  private persistRuntimeState(): void {
    try {
      setBotRuntimeState(this.db, this.botIdentity.name, {
        backendType: this.backendType,
        model: this.botIdentity.model,
      });
      setBotBackendModelState(this.db, this.botIdentity.name, this.backendType, {
        model: this.botIdentity.model,
        effort: this.botIdentity.effort,
      });
    } catch (err) {
      this.log.warn("failed to persist bot runtime state", { error: String(err) });
    }
  }

  /** 清除运行时模型选择，保留当前 backend。 */
  private clearRuntimeModels(): void {
    try {
      setBotRuntimeState(this.db, this.botIdentity.name, { backendType: this.backendType });
      clearBotRuntimeModels(this.db, this.botIdentity.name);
    } catch (err) {
      this.log.warn("failed to clear bot runtime models", { error: String(err) });
    }
  }

  /** 同步当前 chat 已存在的 backend session；各 backend resume 时会从 session 对象读取 model/effort。 */
  private updateActiveChatSessionModels(chatId: string, models: { model?: string; effort?: string }): void {
    const chatSession = this.chatSessions.get(chatId);
    if (!chatSession) return;

    const agentSession = chatSession.agentSession as AgentSession & {
      model?: string;
      reasoningEffort?: string;
    };
    if ("model" in models) {
      agentSession.model = models.model;
    }
    if ("effort" in models) {
      agentSession.reasoningEffort = models.effort;
    }

    this.agent.updateSessionModels?.(chatSession.agentSession.id, models);
  }

  /** 构建模型候选列表：初始配置 → 历史 → 运行时新增，顺序稳定 */
  private buildModelCandidates(): string[] {
    const seen = new Set<string>();
    const list: string[] = [];

    const add = (name: string | undefined) => {
      if (name && !seen.has(name)) {
        seen.add(name);
        list.push(name);
      }
    };

    // 1. 初始配置值（顺序锚点，不随运行时切换而变动）
    const initCache = this.backendModelCache.get(this.backendType);
    add(initCache?.model);

    // 2. 历史记录
    try {
      const rows = this.db.prepare(
        "SELECT model_name FROM model_history WHERE backend = ? ORDER BY last_used_at DESC, id DESC LIMIT 10",
      ).all(this.backendType) as Array<{ model_name: string }>;
      for (const row of rows) {
        add(row.model_name);
      }
    } catch { /* table may not exist yet */ }

    // 3. 运行时新值（手动输入的新模型名，追加到末尾）
    add(this.botIdentity.model);

    return list;
  }

  /** 解析模型参数：数字当编号，否则当名字 */
  private resolveModelArg(arg: string, candidates: string[]): string {
    const index = Number(arg);
    if (Number.isInteger(index) && index >= 1 && index <= candidates.length) {
      return candidates[index - 1]!;
    }
    return arg;
  }

  /** 记录模型使用历史 */
  private recordModelHistory(backend: string, modelName: string): void {
    try {
      this.db.prepare(
        "INSERT INTO model_history (backend, model_name, last_used_at) VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now')) " +
        "ON CONFLICT(backend, model_name) DO UPDATE SET last_used_at = strftime('%Y-%m-%d %H:%M:%f', 'now')",
      ).run(backend, modelName);
    } catch { /* ignore if table doesn't exist */ }
  }

  /** 显示模型列表卡片 */
  private sendModelList(chatId: string, platformChatId: string, msgId?: string): void {
    const candidates = this.buildModelCandidates();
    const currentModel = this.botIdentity.model;

    const lines: string[] = [
      `**Agent:** ${this.backendType}`,
      `**Model:** ${currentModel ?? "default"}`,
      "",
    ];

    if (candidates.length > 0) {
      lines.push("**可选模型:**");
      for (let i = 0; i < candidates.length; i++) {
        const name = candidates[i]!;
        const tags: string[] = [];
        if (name === currentModel) tags.push("✓ Model");
        const suffix = tags.length > 0 ? `  ${tags.join("  ")}` : "";
        lines.push(`  ${i + 1}. ${name}${suffix}`);
      }
      lines.push("");
      lines.push("`/model <名字或编号>` 切换");
      lines.push("`/model reset` 恢复初始值");
    }

    const content = lines.join("\n");
    const send = this.transport.sendCard(platformChatId, "Model", content, undefined, msgId);
    send
      .then((pmid) => { this.storeBotResponse(chatId, content, pmid); })
      .catch(() => {});
  }

  /** 发送 Agent 命令卡片回复 */
  private sendAgentCard(chatId: string, platformChatId: string, msgId: string | undefined, header: string, content: string): void {
    const send = this.transport.sendCard(platformChatId, header, content, undefined, msgId);
    send
      .then((pmid) => { this.storeBotResponse(chatId, content, pmid); })
      .catch((err) => this.log.warn("agent card send failed", {
        chatId,
        header,
        error: String(err),
      }));
  }

  /** 发送 /help 卡片 */
  private sendHelpCard(chatId: string, platformChatId: string, msgId: string | undefined, isAdmin: boolean): void {
    const lines = [
      "`/new`　　新会话（清空当前上下文）",
      "`/stop`　　停止当前任务并清空队列（全停）",
      "`/flush`　　中断当前回复，合并处理排队消息",
      "`/task`　　独立执行任务（stop 停止）",
      "`/status`　查看运行中的任务",
      "`/history`　shell 命令历史",
      "`/clear`　　仅清空排队消息（不停当前任务）",
      "`/service`　查看服务信息",
      "`/cron`　　查看独立提醒；带任务与时间可创建",
      "`/loop`　　查看持续跟进；带任务与时间可创建",
      "`/help`　　显示本帮助",
    ];
    if (isAdmin) {
      lines.push(
        "",
        "**管理员**",
        "`/admin`　　管理员列表/添加/移除",
        "`/model`　　查看/切换模型",
        "`/effort`　 查看/切换推理强度",
        "`/agent`　　查看/切换 Agent backend",
        "`/restart`　重启引擎",
        "`/update`　　检查更新",
        "`/<cmd>`　　执行 shell 命令",
      );
    }
    const content = lines.join("\n");
    const send = this.transport.sendCard(platformChatId, "Help", content, undefined, msgId);
    send
      .then((pmid) => { this.storeBotResponse(chatId, content, pmid); })
      .catch(() => {});
  }

  /** 管理员命令通过 Node 的平台默认 shell 执行，调用前先检查首个命令是否存在。 */
  private tryShellCommand(cmd: string, userId: string, chatId: string, chatType: string, platformChatId: string, msgId?: string): void {
    this.log.info("shell command", { cmd });

    const sendResult = (content: string) => {
      const sendPromise = this.transport.sendCard(platformChatId, "Shell", content, undefined, msgId);
      sendPromise.then((pmid) => {
        this.storeBotResponse(chatId, content, pmid);
      }).catch(() => {});
    };

    const env = buildNiubotEnv({
      workingDirectory: this.workingDirectory,
      userId,
      chatId,
      chatType: chatType as "p2p" | "group",
      dbPath: this.dbPath,
      botId: this.botIdentity.platformBotId,
      botName: this.botIdentity.name,
      platform: this.botIdentity.platform,
      isAdmin: true,
      botProfilePath: this.stableContextOptions.botProfilePath,
    });

    execAsync(cmd, {
      timeout: SHELL_COMMAND_TIMEOUT_MS,
      cwd: this.workingDirectory,
      env: { ...process.env, ...env },
    }).then(({ stdout, stderr }) => {
      const output = (stdout + stderr).trim();
      this.recordShellHistory(cmd, output, 0);
      sendResult(formatShellOutput(this.workingDirectory, cmd, output, 0));
    }).catch((err: unknown) => {
      const { output, exitCode, formatted } = formatShellExecErrorDetails(this.workingDirectory, cmd, err);
      this.recordShellHistory(cmd, output, exitCode);
      sendResult(formatted);
    });
  }

  private recordShellHistory(cmd: string, output: string, exitCode: number): void {
    this.shellHistory.unshift({
      cmd,
      cwd: this.workingDirectory,
      exitCode,
      output: output.slice(0, 500),
      timestamp: Date.now(),
    });
    if (this.shellHistory.length > this.MAX_SHELL_HISTORY) {
      this.shellHistory = this.shellHistory.slice(0, this.MAX_SHELL_HISTORY);
    }
  }

  private sendShellHistory(chatId: string, platformChatId: string, msgId?: string): void {
    if (this.shellHistory.length === 0) {
      this.replyText(chatId, platformChatId, msgId, "暂无 shell 命令历史。");
      return;
    }
    const lines = this.shellHistory.map((entry, i) => {
      const elapsed = formatRelativeAgeMs(entry.timestamp);
      const status = entry.exitCode === 0 ? "✓" : "✗";
      const shortCmd = entry.cmd.length > 72 ? entry.cmd.slice(0, 69) + "..." : entry.cmd;
      let line = `\`#${i + 1}\` ${status} \`${shortCmd}\` · ${elapsed}`;
      if (entry.exitCode !== 0) line += ` (exit ${entry.exitCode})`;
      return line;
    });
    this.transport.sendCard(platformChatId, "Shell History", lines.join("\n"), undefined, msgId)
      .then((pmid) => { this.storeBotResponse(chatId, lines.join("\n"), pmid); })
      .catch(() => {});
  }

  private async runNpmCommand(args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
    const npmCommand = resolveNpmExecutableForNode(process.execPath) ?? "npm";
    return runCommand(npmCommand, args, {
      timeoutMs: timeout,
      cwd: resolveUpdateCommandCwd(NIUBOT_HOME),
      env: withNodeRuntimeOnPath(process.execPath),
    });
  }

  private isValidVersion(version: string): boolean {
    return /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version);
  }

  private async fetchLatestVersion(): Promise<string | null> {
    const { stdout } = await this.runNpmCommand(["view", `${UPDATE_PACKAGE_NAME}@latest`, "version"], 15_000);
    const latest = stdout.trim();
    if (!this.isValidVersion(latest)) {
      throw new Error(`版本号格式异常：${latest.slice(0, 50)}`);
    }
    return latest;
  }

  private async handleUpdate(chatId: string, platformChatId: string, msgId?: string, confirmed = false): Promise<void> {
    const currentVersion = this.version;

    try {
      const latest = await this.fetchLatestVersion();
      if (!latest || !isNewerPackageVersion(latest, currentVersion)) {
        const text = `已是最新版本 (${currentVersion})。`;
        const send = this.transport.sendCard(platformChatId, "Update", text, undefined, msgId);
        send.then((pmid) => { this.storeBotResponse(chatId, text, pmid); }).catch((err) => this.log.warn("update card send failed", { error: String(err) }));
        return;
      }

      if (!confirmed) {
        const text = `发现新版本：${currentVersion} → ${latest}\n发送 \`${UPDATE_CONFIRM_COMMAND}\` 升级并重启。`;
        const send = this.transport.sendCard(platformChatId, "Update", text, undefined, msgId);
        send.then((pmid) => { this.storeBotResponse(chatId, text, pmid); }).catch((err) => this.log.warn("update card send failed", { error: String(err) }));
        return;
      }

      this.replyText(chatId, platformChatId, undefined, `正在准备 ${latest} 的独立 release；旧服务会保留到新版本预检通过。`);
      this.triggerRestart({ platformChatId, updateVersion: latest });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.replyText(chatId, platformChatId, undefined, `更新失败：${msg.slice(0, 500)}`);
    }
  }

  private getAdminPrivatePlatformChatIds(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT c.platform_id
      FROM chats c
      JOIN users u ON u.platform = c.platform AND u.platform_id = c.user_id
      WHERE c.type = 'p2p'
        AND u.is_admin IN ('admin', 'owner')
        AND c.platform = ?
    `).all(this.botIdentity.platform) as Array<{ platform_id: string }>;
    return rows.map((row) => row.platform_id);
  }

  private isUpdateNotificationWindow(now: Date): boolean {
    return isInLocalHourWindow(now, UPDATE_CHECK_HOUR, UPDATE_NOTIFY_END_HOUR, TZ);
  }

  private getNextUpdateCheckDelayMs(now: Date): number {
    return millisecondsUntilLocalHour(now, UPDATE_CHECK_HOUR, TZ);
  }

  private scheduleNextUpdateCheck(): void {
    if (this.updateCheckTimer) {
      clearTimeout(this.updateCheckTimer);
    }
    this.updateCheckTimer = setTimeout(() => {
      this.checkForUpdatesAndNotifyAdmins()
        .catch((err) => {
          this.log.warn("scheduled update check failed", { error: String(err) });
        })
        .finally(() => this.scheduleNextUpdateCheck());
    }, this.getNextUpdateCheckDelayMs(new Date()));
  }

  private async checkForUpdatesAndNotifyAdmins(): Promise<void> {
    if (isPrereleaseOrUnrecognizedVersion(this.version)) {
      this.log.info("skipping update check for dev/prerelease version", { version: this.version });
      return;
    }
    const platformChatIds = this.getAdminPrivatePlatformChatIds();
    if (platformChatIds.length === 0) return;

    let latest: string | null = null;
    try {
      latest = await this.fetchLatestVersion();
    } catch (err) {
      this.log.warn("update check failed", { error: String(err) });
      return;
    }
    if (!latest || latest === this.version) return;
    if (hasUpdateNotification(this.db, this.botIdentity.name, latest)) return;

    const text = `发现新版本：${this.version} → ${latest}\n发送 \`${UPDATE_CONFIRM_COMMAND}\` 升级并重启。`;

    let delivered = false;
    for (const platformChatId of platformChatIds) {
      try {
        await this.transport.sendCard(platformChatId, "Update", text);
        delivered = true;
      } catch (err) {
        this.log.warn("failed to send update notification", { platformChatId, error: String(err) });
      }
    }
    if (delivered) {
      recordUpdateNotification(this.db, this.botIdentity.name, latest);
    }
  }

  /** 启动独立的 Node restart worker；worker 完成预检后再停止旧 Engine。 */
  triggerRestart(opts?: { platformChatId?: string; chatId?: string; updateVersion?: string }): void {
    const runtimeRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    const useNpmRelease = process.env["NIUBOT_RUNTIME_MODE"] === "npm-release";
    const projectRoot = opts?.updateVersion || useNpmRelease
      ? runtimeRoot
      : (this.restartConfig?.sourceDirectory ?? runtimeRoot);

    // 解析 chatId 和 platformChatId（互相反查）
    let chatId = opts?.chatId;
    let platformChatId = opts?.platformChatId;
    if (!chatId && platformChatId) {
      for (const [cid, pid] of this.platformChatIds) {
        if (pid === platformChatId) { chatId = cid; break; }
      }
    } else if (chatId && !platformChatId) {
      platformChatId = this.platformChatIds.get(chatId);
    }

    // 发送"正在重启..."通知
    if (platformChatId) {
      this.transport.sendText(platformChatId, "正在重启...").catch(() => {});
    }

    try {
      const worker = launchRestartWorker({
        niubotHome: NIUBOT_HOME,
        botName: this.botIdentity.name,
        runtimeRoot,
        sourceDirectory: projectRoot,
        runtimeMode: process.env["NIUBOT_RUNTIME_MODE"] || "",
        notifyChatId: chatId,
        updateVersion: opts?.updateVersion,
      });
      this.log.info("restart worker launched", {
        pid: worker.pid,
        chatId,
        sourceDirectory: projectRoot,
        logFile: worker.logFile,
      });
    } catch (err) {
      const errMsg = (err instanceof Error ? err.message : String(err)).slice(0, ERROR_DISPLAY_MAX_LEN);
      this.log.error("restart worker failed to launch", { error: errMsg });
      if (platformChatId) {
        this.transport.sendText(platformChatId, `重启失败：\n\`\`\`\n${errMsg.replace(/`{3,}/g, "``")}\n\`\`\``).catch(() => {});
      }
    }
  }

  private async process(chatId: string, mergedText: string, messages: QueuedMessage[] = [], signal?: AbortSignal, runId?: string): Promise<void> {
    const transition = this.globalSessionTransition ?? this.sessionTransitionLocks.get(chatId);
    if (transition) {
      this.log.info("queued run waiting for session transition", { chatId, runId: runId ?? null });
      await transition;
    }

    const loopJobIds = messages
      .filter((message) => message.triggerKind === "loop_continuation")
      .map((message) => message.loopJobId)
      .filter((id): id is number => id !== undefined);
    const isLoopTurn = loopJobIds.length === 1
      && messages.length === 1
      && messages[0]?.triggerKind === "loop_continuation";
    // 重启唤醒（nbt restart --wake）：主会话内部任务回合，不写成用户发言
    const isWakeTurn = messages.length === 1 && messages[0]?.triggerKind === "restart_wake";
    if (loopJobIds.length > 0 && !isLoopTurn) {
      for (const id of loopJobIds) releaseQueuedLoopJob(this.db, id);
      this.log.error("invalid mixed loop queue batch", { chatId, loopJobIds, messageCount: messages.length });
      this.markRuntimeRun(runId, "failed", "invalid mixed loop queue batch");
      return;
    }

    // Goal 回合：该 chat 已有未结束 Goal 且本轮是它的续轮。
    // 一个 Goal 从开始到结束始终是同一个 Run；队列保持 busy，后续消息自然 pending。
    const existingGoal = this.activeGoals.get(chatId);
    if (existingGoal && !existingGoal.endedAt && (existingGoal.finishRunId === runId || existingGoal.turnCount > 0)) {
      await this.runGoalLoop(chatId, existingGoal, runId, signal);
      return;
    }

    let activeLoopJob: LoopJob | undefined;
    let loopSettled = false;
    const clearActiveLoopRun = () => {
      if (!activeLoopJob) return;
      const active = this.activeLoopRuns.get(activeLoopJob.id);
      if (active?.chatId === chatId && active.runId === runId) {
        this.activeLoopRuns.delete(activeLoopJob.id);
      }
    };
    const settleLoop = (result: { success: boolean; error?: string; cancelled?: boolean }) => {
      if (!activeLoopJob || loopSettled) return;
      completeLoopRun(this.db, activeLoopJob.id, result);
      loopSettled = true;
      clearActiveLoopRun();
    };
    if (isLoopTurn) {
      const queuedJob = getLoopJob(this.db, loopJobIds[0]!);
      if (!queuedJob || queuedJob.status !== "queued") {
        this.log.info("loop event no longer runnable", { chatId, loopJobId: loopJobIds[0] });
        this.markRuntimeRun(runId, "done");
        return;
      }
      activeLoopJob = startLoopRun(this.db, queuedJob.id);
      if (!activeLoopJob) {
        this.markRuntimeRun(runId, "done");
        return;
      }
      this.activeLoopRuns.set(activeLoopJob.id, { chatId, runId });
    }

    // Worker Continuation 分流：内部事件不写成用户发言。
    // MessageQueue 按来源切分批次，正常情况下不会与用户消息混在同一批。
    const continuationIds = messages
      .filter((m) => m.triggerKind === "worker_continuation")
      .flatMap((m) => m.continuationIds ?? []);
    const isContinuationTurn = continuationIds.length > 0 && messages.every((m) => m.triggerKind === "worker_continuation");
    const releaseContinuationClaims = () => {
      if (!isContinuationTurn) return;
      for (const id of continuationIds) {
        this.workerConfig?.jobService.releaseContinuationClaim(id);
      }
    };
    if (continuationIds.length > 0 && !isContinuationTurn) {
      this.queue.enqueueContinuation(chatId, continuationIds);
      this.log.info("worker continuation deferred behind user messages", { chatId, continuationIds });
    }
    // 静默中间回合：多 Job Work 还有未终态 Job 时，本验收回合不向用户交付，
    // 只在 Work 全部完成时统一汇报（单 Job Work 完成即交付）。
    let silentContinuationTurn = false;
    if (isContinuationTurn && this.workerConfig) {
      const jobService = this.workerConfig.jobService;
      const workIds = new Set<string>();
      for (const id of continuationIds) {
        const cont = jobService.getContinuation(id);
        if (cont) workIds.add(cont.workId);
      }
      // 只有本批所有 Work 都还有未终态 Job 时才整体静默。若混有已完成的 Work，
      // 必须正常交付这一批；出站收尾会逐个决定完成或继续。
      silentContinuationTurn = workIds.size > 0 && [...workIds].every((workId) =>
        jobService.listJobs(workId).some((j) => j.status === "queued" || j.status === "running" || j.status === "cancelling"));
    }

    const platformChatId = this.chatSessions.get(chatId)?.platformChatId
      ?? this.platformChatIds.get(chatId);

    // 从消息列表中取最后一条的 platformMsgId 作为 reply 目标。
    // Worker Continuation 回合：优先引用触发消息（创建 Work 的那条用户消息，链路传递），
    // 而不是 triggerMsgIds（最近用户消息，回合开始时消费删除，可能为空或已被后续消息覆盖）。
    // 合并验收多个不同 Work（触发消息不同）时不引用——避免结果错挂到其中一个 Work 的消息下。
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : undefined;
    let triggerMsgId = lastMsg?.platformMsgId ?? this.triggerMsgIds.get(chatId);
    let continuationDisallowFallback = false;
    if (isContinuationTurn && this.workerConfig) {
      const continuationTriggerIds = continuationIds
        .map((id) => this.workerConfig?.jobService.getContinuation(id)?.triggerMsgPlatformId)
        .filter((id): id is string => !!id);
      const unique = new Set(continuationTriggerIds);
      if (unique.size === 1) {
        triggerMsgId = continuationTriggerIds[0];
      } else if (unique.size > 1) {
        triggerMsgId = undefined;
        continuationDisallowFallback = true;
      }
    }
    this.triggerMsgIds.delete(chatId);
    // 兜底（仅 Worker 验收回合链路断裂时，如旧数据）：引用本 chat 最近一条用户消息。
    // 普通回合/合成回合不做兜底——避免回复引用无关消息。
    if (!triggerMsgId && isContinuationTurn && this.workerConfig && !continuationDisallowFallback) {
      triggerMsgId = findLatestUserPlatformMsgId(this.db, chatId);
    }
    // Loop / 重启唤醒没有对应的当前用户消息，不引用历史消息，避免挂错位置。
    if (isLoopTurn || isWakeTurn) triggerMsgId = undefined;

    const isMerged = messages.length > 1;
    const reactionMsgIds = messages
      .map((message) => message.platformMsgId)
      .filter((msgId): msgId is string => !!msgId);

    if (platformChatId) {
      for (const msgId of reactionMsgIds) {
        this.moveMessageToProcessing(platformChatId, msgId);
      }
      for (const msgId of reactionMsgIds) {
        this.processingMsgIds.delete(msgId);
      }
    }

    try {
      if (signal?.aborted) {
        this.log.info("process cancelled before session creation", { chatId });
        releaseContinuationClaims();
        settleLoop({ success: false, cancelled: true });
        this.markRuntimeRun(runId, "stopped");
        return;
      }

      const msgIds = messages.map((m) => m.dbMsgId).filter((id): id is number => id != null);
      const firstMsgId = msgIds.length > 0 ? Math.min(...msgIds) : undefined;
      const chatSession = await this.getOrCreateSession(chatId, firstMsgId, signal);
      const chatTypeRow = this.db.prepare("SELECT type FROM chats WHERE id = ?").get(chatId) as { type: string } | undefined;
      const processChatType = (chatTypeRow?.type ?? "p2p") as "p2p" | "group";

      // 内部续接回合不写成用户发言；普通消息才包 user-message 标记。
      let messageToSend = mergedText;
      if (isContinuationTurn) {
        messageToSend = this.buildWorkerContinuationPrompt(continuationIds, silentContinuationTurn);
        if (!messageToSend) {
          this.log.warn("worker continuation content unavailable, skipping turn", { chatId, continuationIds });
          releaseContinuationClaims();
          this.markRuntimeRun(runId, "failed");
          return;
        }
      } else {
        const baseMessage = isLoopTurn
          ? this.buildLoopContinuationPrompt(activeLoopJob!)
          : isWakeTurn
            ? `【重启完成】\n${mergedText}`
            : mergedText;
        messageToSend = baseMessage;
        const stableCtx = this.pendingStableContext.get(chatId);
        const messageCtx = this.pendingMessageContext.get(chatId);
        const compactRecovery = this.pendingCompactRecovery.has(chatId);
        const isNewSessionPrompt = this.pendingNewSessionReminder.has(chatId);
        if (stableCtx || messageCtx || compactRecovery || isNewSessionPrompt) {
          const parts: string[] = [];
          if (stableCtx) {
            parts.push(stableCtx);
          }
          if (messageCtx) {
            parts.push(messageCtx);
          }
          if (compactRecovery) {
            const recoveryParts: string[] = [];
            if (this.agent.needsCompactRecoveryReminder()) {
              recoveryParts.push(COMPACT_RECOVERY_REMINDER);
            }
            if (this.agent.needsStableUserPrefix()) {
              recoveryParts.push(this.buildStableSystemContext());
            }
            const recoveryUserId = processChatType === "group" ? undefined : chatSession.userId;
            recoveryParts.push(this.buildSessionProfile(chatId, processChatType, recoveryUserId));
            recoveryParts.push(buildSessionArchiveContext(
              getSessionArchiveDirectory(this.archiveHome, this.botIdentity.name, chatId),
            ));
            const taskContext = buildActiveTaskContext(this.workingDirectory, processChatType, recoveryUserId);
            if (taskContext) {
              recoveryParts.push(`<session-state>\n${taskContext}\n</session-state>`);
            }
            parts.push(recoveryParts.join("\n\n"));
          }
          if (isNewSessionPrompt) {
            parts.push(NEW_SESSION_SEARCH_REMINDER);
          }
          this.pendingStableContext.delete(chatId);
          this.pendingMessageContext.delete(chatId);
          this.pendingCompactRecovery.delete(chatId);
          this.pendingNewSessionReminder.delete(chatId);
          messageToSend = `${parts.join("\n\n")}\n\n${baseMessage}`;
        }

        // 群聊：消息级 speaker 注入；内部 Loop 回合没有当前发言者。
        if (!isLoopTurn && processChatType === "group" && messages.length > 0) {
        // 提取去重的 sender 列表
        const senderIds = [...new Set(messages.map((m) => m.senderId).filter((id): id is string => !!id))];
        if (senderIds.length > 0) {
          const speakers: SpeakerInfo[] = senderIds.map((id) => {
            const row = this.db.prepare("SELECT name FROM users WHERE id = ?").get(id) as { name: string | null } | undefined;
            return {
              userId: id,
              userName: row?.name ?? undefined,
              isAdmin: this.adminRoles.has(id),
            };
          });
          const speakerCtx = buildSpeakerContext(this.db, speakers);
          if (speakerCtx) {
            messageToSend = `${speakerCtx}\n\n${messageToSend}`;
          }
        }
      }

        if (!isLoopTurn) {
          if (messageToSend === baseMessage) {
            messageToSend = wrapInjectedUserMessage(baseMessage);
          } else if (messageToSend.endsWith(baseMessage)) {
            messageToSend = `${messageToSend.slice(0, messageToSend.length - baseMessage.length)}${wrapInjectedUserMessage(baseMessage)}`;
          }
        }
        // 特殊场景提醒：/worker off 时强制告知模型停止派工（技能会继续被发现，
        // 不能用按需加载兜底，必须显式注入）。其余工具说明（调度/Worker）已 skill 化，
        // 由 agent CLI 按需加载 skills/nbt-tools/SKILL.md，不再注入。
        // 只影响用户消息回合；Continuation 验收回合自带指导。
        if (this.workerConfig && !this.workerConfig.teamConfigStore?.isEnabled()) {
          messageToSend = `${WORKER_DISABLED_REMINDER}\n\n${messageToSend}`;
        }
      }

      if (signal?.aborted) {
        this.log.info("process cancelled before sending to agent", { chatId });
        if (!isLoopTurn && !this.globalSessionTransition && !this.sessionTransitionLocks.has(chatId)) {
          await this.archiveSession(chatId);
        }
        releaseContinuationClaims();
        settleLoop({ success: false, cancelled: true });
        this.markRuntimeRun(runId, "stopped");
        return;
      }

      if (msgIds.length > 0) {
        const assignMessage = this.db.prepare("UPDATE messages SET session_key = ? WHERE id = ?");
        const assignMessages = this.db.transaction((ids: number[]) => {
          for (const id of ids) assignMessage.run(chatSession.sessionId, id);
          this.db.prepare(`
            UPDATE sessions SET start_msg_id = COALESCE(start_msg_id, ?) WHERE id = ?
          `).run(Math.min(...ids), chatSession.sessionId);
        });
        assignMessages(msgIds);
      }

      this.log.info("sending to agent", {
        chatId,
        sessionId: chatSession.sessionId,
        textLength: messageToSend.length,
      });

      // 普通用户回合在调用 Agent 前记住 Worker 事件游标；Agent 可能通过
      // nbt worker CLI 创建 Job。只认 job_created，不会把空 Work 或已有后台任务误算成派工。
      const workerEventCursorBeforeAgent = this.getWorkerEventCursor();
      const latestSenderId = [...messages].reverse().find((message) => !!message.senderId)?.senderId;
      const uniqueSenderIds = [...new Set(messages
        .map((message) => message.senderId)
        .filter((senderId): senderId is string => !!senderId))];
      const continuationOwnerId = continuationIds
        .map((id) => this.workerConfig?.jobService.getContinuation(id))
        .map((continuation) => continuation ? this.workerConfig?.jobService.getWork(continuation.workId)?.ownerUserId : undefined)
        .find((userId): userId is string => !!userId);
      const commandUserId = latestSenderId ?? continuationOwnerId ?? activeLoopJob?.creatorUserId ?? chatSession.userId;
      const agentResult = await (async () => {
        this.activeScheduleAgentCommands.set(chatId, {
          runId: runId!,
          userId: uniqueSenderIds.length === 1 ? uniqueSenderIds[0]! : commandUserId,
          chatType: processChatType,
          userTurn: !isContinuationTurn && !isLoopTurn && uniqueSenderIds.length === 1,
          token: this.chatScheduleTokens.get(chatId) ?? "",
        });
        if (this.workerConfig) {
          this.activeWorkerAgentCommands.set(chatId, {
            runId: runId!,
            userId: commandUserId,
            chatType: processChatType,
            continuationTurn: isContinuationTurn,
            createdWorkIds: [],
            token: this.chatScheduleTokens.get(chatId) ?? "",
          });
        }
        try {
          return await this.runManager.runAgent({
            runId: runId!,
            chatId,
            session: chatSession.agentSession,
            message: messageToSend,
            signal,
          });
        } finally {
          const commandContext = this.activeWorkerAgentCommands.get(chatId);
          if (commandContext && commandContext.runId === runId) {
            for (const workId of commandContext.createdWorkIds) {
              const work = this.workerConfig?.jobService.getWork(workId);
              if (work?.status === "active" && this.workerConfig?.jobService.listJobs(workId).length === 0) {
                this.workerConfig.jobService.failWork(workId, "主会话未创建任何 Worker Job，已自动结束空 Work");
                this.log.warn("empty worker work closed after agent turn", { chatId, runId, workId });
              }
            }
            this.activeWorkerAgentCommands.delete(chatId);
          }
          const scheduleContext = this.activeScheduleAgentCommands.get(chatId);
          if (scheduleContext?.runId === runId) this.activeScheduleAgentCommands.delete(chatId);
        }
      })();
      if (agentResult.status === "stopped") {
        this.log.info("prompt cancelled, no response to send", { chatId });
        // 本回合若刚通过 nbt goal start 创建了 Goal：以 stopped 结算并清理，避免孤儿 Goal 吞后续消息
        const orphanGoal = this.activeGoals.get(chatId);
        if (orphanGoal && !orphanGoal.endedAt && orphanGoal.startRunId === runId) {
          this.log.info("goal start turn cancelled, settling goal as stopped", { chatId, runId });
          this.finishGoal(chatId, orphanGoal, "stopped", "回合被取消");
          this.cleanupGoal(chatId, orphanGoal, runId);
        }
        // 验收回合被取消：释放认领，允许后续重新投递（否则卡死 claimed）
        releaseContinuationClaims();
        settleLoop({ success: false, cancelled: true });
        this.markRuntimeRun(runId, "stopped");
        return;
      }
      const response = agentResult.response;

      // Goal 主动进入：本回合 Agent 调用了 nbt goal start → 本回合计入第 1 轮，runGoalLoop 接管
      // （本轮不再按普通回合交付，由 Goal 流程处理：finish 则结算，否则静默继续下一轮）
      const startedGoal = this.activeGoals.get(chatId);
      if (startedGoal && !startedGoal.endedAt && startedGoal.startRunId === runId) {
        this.log.info("goal start turn detected, adopting as round 1", { chatId, runId });
        // Loop/Worker 回合内 start：先结算本轮 loop/continuation，避免 job 永久卡 running/claimed。
        // Worker 结果已被 Goal 第 1 轮消费：登记到 Goal，结算时标记完成（释放会导致重复投递）。
        if (isContinuationTurn && continuationIds.length > 0) {
          startedGoal.adoptedContinuationIds = continuationIds;
        }
        if (isLoopTurn && activeLoopJob && !loopSettled) {
          settleLoop({ success: true, cancelled: true });
        }
        await this.runGoalLoop(chatId, startedGoal, runId, signal, agentResult);
        return;
      }

      // `/loop del` 可在 Agent 执行期间由内置命令立即处理。Agent 返回后先查持久状态，
      // 被取消的本轮不写入主会话历史，也不向平台发送。检查后到 sendCard 之间没有 await，
      // 因此同一进程内的新取消命令不能插入这段同步路径；已经开始的平台请求只能尽力取消。
      if (isLoopTurn && activeLoopJob && getLoopJob(this.db, activeLoopJob.id)?.status !== "running") {
        loopSettled = true;
        clearActiveLoopRun();
        this.log.info("cancelled loop result discarded", { chatId, loopJobId: activeLoopJob.id });
        this.markRuntimeRun(runId, "stopped");
        return;
      }
      const compactedThisTurn = this.updateCompactRecoveryState(chatId, response.compactCount);

      // cancelled：有内容就发（中间结果），没内容就静默（用户已收到"已停止"）
      if (response.cancelled) {
        if (response.text.trim()) {
          this.log.info("cancelled with content, delivering result", { chatId, responseLength: response.text.length });
        }
      }

      // Loop 回合没有可交付内容时静默完成，不发空卡片，也不记失败重试。
      if (isLoopTurn && !response.text.trim()) {
        this.log.info("loop turn produced no content, settling silently", { chatId, loopJobId: activeLoopJob?.id });
        settleLoop({ success: true });
        this.markRuntimeRun(runId, "done");
        return;
      }

      // 存储 agent 回复 + 更新 session 统计（与 Goal 回合共用同一收尾逻辑）
      const replyMsgId = this.recordAgentTurn(chatSession, chatId, response);

      // 构建 footer：shortId · #turn · context · model
      const agentSessionId = this.agent.getAgentSessionId?.(chatSession.agentSession.id);
      const stats = this.db.prepare(
        "SELECT turn_count FROM sessions WHERE id = ?",
      ).get(chatSession.sessionId) as { turn_count: number } | undefined;
      const footer = buildResponseFooter({
        sessionId: agentSessionId ?? chatSession.sessionId,
        turnCount: stats?.turn_count,
        contextTokens: response.contextTokens,
        compactCount: response.compactCount,
        model: response.model,
      });

      // 静默中间回合：不向 IM 发送，直接标记 Continuation 完成（结果已进上下文）
      if (silentContinuationTurn) {
        this.log.info("worker continuation silent turn (work still running)", { chatId, continuationIds });
        for (const id of continuationIds) {
          this.workerConfig?.jobService.markContinuationCompleted(id, runId ?? "");
        }
        this.markRuntimeRun(runId, "done");
        return;
      }

      // 合并消息提示头；出站前强制剥离内部标签（保护：不依赖 LLM 自觉）
      const loopCardHeader = isLoopTurn && activeLoopJob ? buildLoopCardHeader(activeLoopJob) : "";
      const loopTaskQuote = isLoopTurn && activeLoopJob ? buildLoopTaskQuote(activeLoopJob) : undefined;
      const loopFullMarker = isLoopTurn && activeLoopJob ? buildLoopDeliveryMarker(activeLoopJob) : undefined;
      const addLoopTaskQuote = (text: string): string => loopTaskQuote ? `${loopTaskQuote}\n\n${text}` : text;
      const addLoopFullMarker = (text: string): string => loopFullMarker ? `${loopFullMarker}\n\n${text}` : text;
      let displayText = stripInternalWorkerTags(response.text);
      let deliveredText = displayText;
      displayText = addLoopTaskQuote(displayText);
      if (isMerged) {
        const lines = messages.map((m) => {
          const brief = m.text.length > 10 ? m.text.slice(0, 10) + "…" : m.text;
          return `• ${brief}`;
        });
        displayText = `> 📌 回复 ${messages.length} 条消息：\n${lines.map((l) => `> ${l}`).join("\n")}\n\n${displayText}`;
      }

      // Worker 结果交付强制标识：只按本回合是否由 Continuation 触发判断。
      // Work 会在正文成功发送后自动完成，因此此处不依赖 Work 状态。
      if (isContinuationTurn && !displayText.trimEnd().endsWith(WORKER_DELIVERY_MARKER)) {
        displayText = `${displayText}\n\n${WORKER_DELIVERY_MARKER}`;
      } else if (!isContinuationTurn) {
        const dispatchedWorker = this.hasWorkerJobCreatedSince(chatId, workerEventCursorBeforeAgent);
        if (dispatchedWorker && !displayText.trimEnd().endsWith(WORKER_DISPATCH_MARKER)) {
          displayText = `${displayText}\n\n${WORKER_DISPATCH_MARKER}`;
        }
      }
      deliveredText = displayText;

      // 统一最终交付：卡片（reply 优先，footer 带 session 信息）→ 文本（带失败提示）→ 文件
      // 降级链由 ResponseSender.sendFinalResponse 统一承担（超时、不确定结果、超长自动转文件）。
      this.markRuntimeRun(runId, "sending_response");
      let sentPlatformMsgId: string | undefined;
      let deliveredResponseBody = false;
      this.log.info("send decision", { chatId, useReply: !!triggerMsgId, merged: isMerged, messageCount: messages.length, triggerMsgId: triggerMsgId ?? "none" });
      const sendResult = await this.responseSender.sendFinalResponse({
        chatId: chatSession.platformChatId,
        header: loopCardHeader,
        content: displayText,
        footer,
        replyToMsgId: triggerMsgId,
        signal,
        textFallback: (sendErr) => addLoopFullMarker(`发送失败：${extractPlatformErrorDetail(sendErr)}`),
      });
      if (sendResult.ok) {
        sentPlatformMsgId = sendResult.platformMsgId;
        deliveredResponseBody = sendResult.method === "card";
        // 降级交付（文本/文件）时以实际交付内容回写历史，让「发送失败」提示可见
        deliveredText = sendResult.deliveredContent;
      } else {
        this.log.error("failed to send response to IM", {
          chatId,
          error: sendResult.error,
          methodsTried: sendResult.methodsTried,
          responseLength: response.text.length,
        });
        if (sendResult.uncertain) {
          this.log.warn("response delivery result unknown, skipping fallback", { chatId, error: sendResult.error });
        }
      }

      // 回写 platform_msg_id（用于 merge_forward 等场景的内容缓存查找）
      if (sentPlatformMsgId) {
        if (deliveredText !== response.text) {
          updateMessageContent(this.db, replyMsgId, deliveredText);
        }
        updateMessagePlatformId(this.db, replyMsgId, sentPlatformMsgId);
      }

      // 只有 Worker 正文真实发送成功才完成 Continuation；错误提示不算交付。
      if (isContinuationTurn && this.workerConfig) {
        if (sentPlatformMsgId && deliveredResponseBody) {
          const conclusion = stripInternalWorkerTags(response.text).trim() || "Worker 结果已交付。";
          const settled = this.workerConfig.jobService.completeDeliveredContinuations({
            continuationIds,
            agentTurnId: runId ?? "",
            conclusion,
            workerEventCursor: workerEventCursorBeforeAgent,
          });
          this.log.info("worker continuation delivery settled", {
            continuationIds,
            completedWorkIds: settled.completedWorkIds,
            continuedWorkIds: settled.continuedWorkIds,
            runId,
          });
        } else {
          releaseContinuationClaims();
          this.log.warn("worker continuation result not delivered, released for retry", { chatId, continuationIds });
        }
      }

      if (isLoopTurn) {
        if (sentPlatformMsgId && deliveredResponseBody) {
          settleLoop({ success: true });
        } else {
          settleLoop({ success: false, error: "response not delivered to IM" });
        }
      }

      if (sentPlatformMsgId) {
        this.log.info("response sent", {
          chatId,
          responseLength: response.text.length,
          filesChanged: response.filesChanged,
        });
        this.markRuntimeRun(runId, "done");
      } else {
        this.log.warn("response not delivered to IM", {
          chatId,
          responseLength: response.text.length,
        });
        this.markRuntimeRun(runId, "failed", "response not delivered to IM");
      }
    } catch (err) {
      this.log.error("pipeline error", { chatId, error: String(err) });
      // 本回合刚创建的 Goal 异常退出：结算为 failed 并清理，避免孤儿 Goal 吞后续消息
      const failedGoal = this.activeGoals.get(chatId);
      if (failedGoal && !failedGoal.endedAt && failedGoal.startRunId === runId) {
        this.finishGoal(chatId, failedGoal, "failed", `回合异常：${String(err).slice(0, 200)}`);
        this.cleanupGoal(chatId, failedGoal, runId);
      }
      if (isLoopTurn && activeLoopJob && getLoopJob(this.db, activeLoopJob.id)?.status === "cancelled") {
        loopSettled = true;
        clearActiveLoopRun();
        this.log.info("cancelled loop error discarded", { chatId, loopJobId: activeLoopJob.id });
        this.markRuntimeRun(runId, "stopped");
        return;
      }
      // Worker Continuation 回合失败：释放认领，允许重新投递
      releaseContinuationClaims();
      settleLoop({ success: false, error: String(err) });
      this.markRuntimeRun(runId, signal?.aborted ? "stopped" : "failed", String(err));

      if (platformChatId) {
        // 异常终态会附带最后一段 assistant 文本；出站前仍要剥离内部标签，
        // 避免 Worker/Loop 注入内容经错误提示旁路泄漏。
        const detail = stripInternalWorkerTags(extractAgentErrorDetail(err) ?? "").trim();
        const baseErrorText = detail
          ? `处理出错了：\n\`\`\`\n${detail.replace(/`{3,}/g, "``")}\n\`\`\``
          : "处理出错了，请稍后再试。";
        const errorText = isLoopTurn && activeLoopJob
          ? `${buildLoopDeliveryMarker(activeLoopJob)}\n\n${baseErrorText}`
          : baseErrorText;
        try {
          const pmid = await this.transport.sendText(platformChatId, errorText);
          this.storeBotResponse(chatId, errorText, pmid);
        } catch { /* give up */ }
      }
    }
  }

  private async getOrCreateSession(chatId: string, beforeMsgId?: number, signal?: AbortSignal): Promise<ChatSession> {
    const existing = this.chatSessions.get(chatId);
    if (existing) return existing;
    const pending = this.sessionCreations.get(chatId);
    if (pending) return pending;

    const creation = this.createChatSession(chatId, beforeMsgId, signal).finally(() => {
      if (this.sessionCreations.get(chatId) === creation) this.sessionCreations.delete(chatId);
    });
    this.sessionCreations.set(chatId, creation);
    return creation;
  }

  private async createChatSession(chatId: string, beforeMsgId?: number, signal?: AbortSignal): Promise<ChatSession> {

    const platformChatId = this.platformChatIds.get(chatId);
    if (!platformChatId) {
      throw new Error(`No platform chat ID for internal chat ${chatId}`);
    }

    const userId = this.chatUserIds.get(chatId);

    // 查 chatType 用于 memory 可见性控制
    const chatRow = this.db.prepare("SELECT type FROM chats WHERE id = ?").get(chatId) as { type: string } | undefined;
    const chatType = (chatRow?.type ?? "p2p") as "p2p" | "group";

    // 构建 session dynamic context（当前场景 + 用户记忆）
    // 群聊：只注入 bot + chat 信息，不注入用户身份（由消息级 speaker 注入）
    const isGroup = chatType === "group";
    const userRow = (!isGroup && userId)
      ? this.db.prepare("SELECT name FROM users WHERE id = ?").get(userId) as { name: string | null } | undefined
      : undefined;
    const isAdmin = userId ? this.adminRoles.has(userId) : false;
    const sessionProfile = buildImportantContext(this.db, {
      botName: this.botIdentity.name,
      botLabel: this.botUserId ? getUserShortLabel(this.db, this.botUserId) : undefined,
      platform: this.botIdentity.platform,
      userName: userRow?.name ?? undefined,
      userId: isGroup ? undefined : userId,
      chatId,
      chatLabel: getChatShortLabel(this.db, chatId),
      chatType,
      isAdmin,
      botProfilePath: this.stableContextOptions.botProfilePath,
    });
    const stableContext = this.buildStableSystemContext();

    // 新主会话生成能力令牌；独立 session（Cron/task）不生成，无法借主会话身份。
    if (!this.chatScheduleTokens.has(chatId)) {
      this.chatScheduleTokens.set(chatId, randomUUID());
    }

    // 构建 task/conversation context（任务索引 + 归档目录 + 最近消息）
    const normalContext = buildNormalContext(
      this.db, chatId, this.workingDirectory, beforeMsgId, chatType, userId,
      getSessionArchiveDirectory(this.archiveHome, this.botIdentity.name, chatId),
    );
    const messageContextParts = [sessionProfile];
    if (normalContext) {
      messageContextParts.push(`<session-state>\n${normalContext}\n</session-state>`);
    }
    this.pendingMessageContext.set(chatId, messageContextParts.join("\n\n"));

    const agentSession = await this.createAgentSession({
      workingDirectory: this.workingDirectory,
      reasoningEffort: this.botIdentity.effort,
      importantContext: stableContext || undefined,
      userId: userId ?? undefined,
      chatId,
      chatType,
      dbPath: this.dbPath,
      botId: this.botIdentity.platformBotId,
      botName: this.botIdentity.name,
      platform: this.botIdentity.platform,
      model: this.botIdentity.model,
      isAdmin,
      botProfilePath: this.stableContextOptions.botProfilePath,
      scheduleToken: this.chatScheduleTokens.get(chatId),
    });

    if (this.agent.needsStableUserPrefix() && stableContext) {
      this.pendingStableContext.set(chatId, stableContext);
    }
    this.pendingNewSessionReminder.add(chatId);

    const sessionId = randomUUID().slice(0, 8);

    try {
      const orphan = this.db.prepare(
        "SELECT MIN(id) as startId FROM messages WHERE chat_id = ? AND session_key IS NULL",
      ).get(chatId) as { startId: number | null } | undefined;
      const startMsgId = orphan?.startId ?? null;

      this.db.prepare(`
        INSERT INTO sessions (id, chat_id, user_id, status, start_msg_id, started_at, last_active_at, backend_type)
        VALUES (?, ?, ?, 'active', ?, datetime('now'), datetime('now'), ?)
      `).run(sessionId, chatId, userId ?? null, startMsgId, this.backendType);

      this.db.prepare(
        "UPDATE messages SET session_key = ? WHERE chat_id = ? AND session_key IS NULL",
      ).run(sessionId, chatId);
    } catch (dbErr) {
      await this.agent.closeSession(agentSession).catch(() => {});
      throw dbErr;
    }

    const chatSession: ChatSession = {
      agentSession,
      sessionId,
      platformChatId,
      userId: userId ?? "",
      triggerPlatformMsgId: this.triggerMsgIds.get(chatId),
      hasReplied: false,
    };
    this.chatSessions.set(chatId, chatSession);

    this.log.info("session created", { chatId, sessionId, userId, agentSessionId: agentSession.id });
    return chatSession;
  }

  /** 首条消息或恢复消息的动态上下文暂存 */
  private pendingMessageContext = new Map<string, string>();

  /** stable context 暂存（needsStableUserPrefix 时挂到首条 user 消息） */
  private pendingStableContext = new Map<string, string>();

  /** 新 session 首条消息提醒暂存 */
  private pendingNewSessionReminder = new Set<string>();

  private clearChatRuntimeState(chatId: string): void {
    this.pendingMessageContext.delete(chatId);
    this.pendingStableContext.delete(chatId);
    this.pendingNewSessionReminder.delete(chatId);
    this.pendingCompactRecovery.delete(chatId);
    this.lastCompactCounts.delete(chatId);
    this.chatScheduleTokens.delete(chatId);
  }

  private buildSessionProfile(chatId: string, chatType: "p2p" | "group", userId?: string): string {
    const isGroup = chatType === "group";
    const userRow = (!isGroup && userId)
      ? this.db.prepare("SELECT name FROM users WHERE id = ?").get(userId) as { name: string | null } | undefined
      : undefined;
    const isAdmin = userId ? this.adminRoles.has(userId) : false;
    return buildImportantContext(this.db, {
      botName: this.botIdentity.name,
      botLabel: this.botUserId ? getUserShortLabel(this.db, this.botUserId) : undefined,
      platform: this.botIdentity.platform,
      userName: userRow?.name ?? undefined,
      userId: isGroup ? undefined : userId,
      chatId,
      chatLabel: getChatShortLabel(this.db, chatId),
      chatType,
      isAdmin,
      botProfilePath: this.stableContextOptions.botProfilePath,
    });
  }

  private buildStableSystemContext(): string {
    return buildStableSystemContext({
      ...this.stableContextOptions,
      botName: this.botIdentity.name,
      botLabel: this.botUserId ? getUserShortLabel(this.db, this.botUserId) : undefined,
    });
  }

  private updateCompactRecoveryState(chatId: string, compactCount: number | undefined): boolean {
    if (compactCount === undefined || compactCount <= 0) return false;
    const previous = this.lastCompactCounts.get(chatId) ?? 0;
    if (compactCount <= previous) return false;
    this.lastCompactCounts.set(chatId, compactCount);
    this.pendingCompactRecovery.add(chatId);
    return true;
  }

  private async archiveSession(chatId: string): Promise<SessionEndStatus | false> {
    const session = this.chatSessions.get(chatId);
    if (!session) {
      const result = this.db.prepare(`
        UPDATE sessions
        SET status = 'archive_failed',
            ended_at = datetime('now'),
            last_active_at = datetime('now')
        WHERE id = (
          SELECT id FROM sessions
          WHERE chat_id = ? AND status = 'active' AND source = 'user'
          ORDER BY last_active_at DESC, started_at DESC
          LIMIT 1
        )
      `).run(chatId);

      this.clearChatRuntimeState(chatId);
      return result.changes > 0 ? "archive_failed" : false;
    }

    const { agentSession, sessionId } = session;
    const archivedAt = utcDateTimeForSql(new Date());
    let archiveStatus: SessionEndStatus = "archived";
    try {
      await this.archiveTranscript(chatId, sessionId, agentSession, this.agent, archivedAt);
    } catch (err) {
      if (err instanceof AgentSessionNotStartedError) {
        archiveStatus = "discarded";
        this.log.info("discarding session that never started in backend", { chatId, sessionId });
      } else {
        archiveStatus = "archive_failed";
        this.log.error("session transcript archive failed; ending session anyway", {
          chatId,
          sessionId,
          error: String(err),
        });
      }
    }

    this.db.prepare(`
      UPDATE sessions SET status = ?, ended_at = ?, last_active_at = datetime('now')
      WHERE id = ?
    `).run(archiveStatus, archivedAt, sessionId);

    this.chatSessions.delete(chatId);
    this.clearChatRuntimeState(chatId);

    await this.agent.closeSession(agentSession).catch((err) => {
      this.log.warn("failed to close backend session during archive", { chatId, sessionId, error: String(err) });
    });

    this.log.info("session ended", { chatId, sessionId, status: archiveStatus });
    return archiveStatus;
  }

  private async archiveTranscript(
    chatId: string,
    sessionId: string,
    agentSession: AgentSession,
    backend: AgentBackend = this.agent,
    archivedAt?: string,
  ): Promise<void> {
    const row = this.db.prepare(`
      SELECT source, backend_type, started_at, ended_at
      FROM sessions WHERE id = ?
    `).get(sessionId) as {
      source: string | null;
      backend_type: string | null;
      started_at: string;
      ended_at: string | null;
    } | undefined;
    const archiveTime = archivedAt ?? row?.ended_at;
    if (!row || !archiveTime) throw new Error(`session archive metadata is incomplete: ${sessionId}`);
    const file = await archiveAgentSession(this.archiveHome, backend, agentSession, {
        botId: this.botIdentity.name,
        chatId,
        sessionId,
        source: row.source ?? "user",
        backend: row.backend_type ?? this.backendType,
        startedAt: row.started_at,
        archivedAt: archiveTime,
      });
    this.log.info("session transcript archived", { chatId, sessionId, file });
  }

  private async cancelChat(chatId: string): Promise<void> {
    const session = this.chatSessions.get(chatId);
    if (!session) return;

    // 先 abort 队列 signal：让 runAgent 的 abortable 立即 reject，run 退出、busy 恢复。
    // 不依赖进程能否被 kill——进程挂起（不在 activeProcesses 或杀不掉）时也能解卡。
    if (this.queue.isBusy(chatId)) {
      this.queue.cancel(chatId);
    }
    await this.agent.cancelSession(session.agentSession);
  }

  // ── Watchdog ─────────────────────────────────────────────

  /** 向指定 chat 发送系统通知（不走 pipeline 队列） */
  private sendWatchdogNotification(chatId: string, text: string): void {
    const platformChatId = this.platformChatIds.get(chatId);
    if (!platformChatId) return;
    this.transport.sendText(platformChatId, text).then((pmid) => {
      this.storeBotResponse(chatId, text, pmid);
    }).catch(() => {});
  }

  private sendWatchdogCard(chatId: string, header: string, content: string): void {
    const platformChatId = this.platformChatIds.get(chatId);
    if (!platformChatId) return;
    this.transport.sendCard(platformChatId, header, content).then((pmid) => {
      this.storeBotResponse(chatId, content, pmid);
    }).catch(() => {});
  }

  /** 发送 compact 中提示（仅通知一次） */
  notifyCompacting(chatId: string): void {
    const session = this.chatSessions.get(chatId);
    if (!session) return;
    const key = session.agentSession.id;
    if (this.compactNotifiedSessions.has(key)) return;
    this.compactNotifiedSessions.add(key);
    this.sendWatchdogNotification(chatId, "上下文比较大，正在压缩，稍等一下。");
  }

  /** Watchdog 主循环：检测 idle session，按策略通知或自动 kill */
  private runIdleWatchdogSafely(): void {
    try {
      this.runIdleWatchdog();
    } catch (err) {
      this.log.error("watchdog tick failed", { error: String(err) });
    }
  }

  private runIdleWatchdog(): void {
    this.reloadTeamConfigIfChanged();
    const cliAgent = this.agent instanceof CliAgentBackend ? this.agent : undefined;

    const now = Date.now();
    for (const [chatId, session] of this.chatSessions) {
      if (!cliAgent) continue;
      const a = cliAgent.getActivity(session.agentSession.id);
      if (!a || (a.status !== "running")) continue;

      // 探测 session 文件 mtime，更新 lastActiveAt
      const s = (cliAgent as any).sessions?.get(session.agentSession.id);
      if (s && typeof (cliAgent as any).probeSessionFileMtime === "function") {
        try {
          const fileMtime = (cliAgent as any).probeSessionFileMtime(s) as number | null;
          if (fileMtime && fileMtime > a.lastActiveAt) {
            a.lastActiveAt = fileMtime;
          }
        } catch (err) {
          this.log.warn("watchdog: session file mtime probe failed", {
            chatId,
            sessionId: session.agentSession.id,
            error: String(err),
          });
        }
      }

      const idleMs = now - a.lastActiveAt;
      const runningMs = now - a.startedAt;

      // ── 活动恢复检测：发过通知后又有活动 → 通知用户 + 重置 ──
      if (a.notifyCount > 0 && a.lastNotifiedAt && a.lastActiveAt > a.lastNotifiedAt) {
        this.sendWatchdogNotification(chatId, "又有动静了，继续跑着。");
        a.notifyCount = 0;
        a.lastNotifiedAt = undefined;
        continue;
      }

      // ── Compact 中：发送提示 + 跳过 idle 检测 ──
      if (a.compacting) {
        this.notifyCompacting(chatId);
        continue;
      }

      // ── 策略 1: 有 completion + 无活动超过 5s → 自动 kill ──
      // 留 5 秒 grace period，让进程有时间自行退出
      if (a.completionDetected && idleMs > 5_000) {
        this.log.info("watchdog: auto-kill, completion detected + idle", {
          chatId,
          sessionId: session.agentSession.id,
          idleMs,
        });
        // 首次 kill 时告知用户（只发一次，避免每 15 秒刷屏）
        if (!a.killNotifiedAt) {
          a.killNotifiedAt = now;
          this.sendWatchdogNotification(chatId, "任务输出已完成但进程未退出，正在尝试结束进程。");
        }
        this.cancelChat(chatId).catch(() => {});
        continue;
      }

      // ── 策略 2: 长时间运行 → 每小时固定提醒，不 kill ──
      if (
        !a.completionDetected
        && runningMs > AGENT_LONG_RUNNING_FIRST_NOTIFY_MS
        && (!a.lastLongRunningNotifiedAt || now - a.lastLongRunningNotifiedAt > AGENT_LONG_RUNNING_REPEAT_NOTIFY_MS)
      ) {
        const runningHours = formatLongRunningHours(runningMs);
        const header = "任务还在运行";
        const parts = [
          `任务已经运行约 ${runningHours} 小时，进程仍在运行。`,
          formatOutputActivity(idleMs),
          "不急的话可以继续等；如果想结束当前任务，可以发送 /stop。",
        ];
        this.sendWatchdogCard(chatId, header, parts.join("\n\n"));
        a.lastLongRunningNotifiedAt = now;
        continue;
      }

      // ── 策略 2b: run 硬超时 → 强制中止（进程挂起但无 completion 时队列会永久卡死）
      if (!a.completionDetected && runningMs > AGENT_RUN_HARD_TIMEOUT_MS) {
        const runningHours = formatLongRunningHours(runningMs);
        this.log.warn("watchdog: hard timeout, aborting stuck run", {
          chatId,
          sessionId: session.agentSession.id,
          runningMs,
          idleMs,
        });
        this.sendWatchdogNotification(chatId, `任务运行超过 ${runningHours} 小时且未完成，已强制中止。`);
        this.cancelChat(chatId).catch(() => {});
        continue;
      }

      // 工具执行期间可能长时间没有新日志；一小时内先不按“无输出”误报。
      // tool_started 不是持续心跳，超过一小时仍恢复原 idle 策略，避免永久挂住。
      if (a.executingTool && idleMs <= INDEPENDENT_IDLE_KILL_MS) continue;

      // ── 策略 3: 无 completion + 长时间无活动 → 通知两次后强制中止 ──
      if (!a.completionDetected) {
        // 两次通知后（30+ 分钟无输出）仍无进展 → 视为挂起，强制中止（防止队列永久 busy）
        if (a.notifyCount >= 2) {
          this.log.warn("watchdog: no progress after notifications, aborting stuck run", {
            chatId,
            sessionId: session.agentSession.id,
            idleMs,
            runningMs,
          });
          this.sendWatchdogNotification(chatId, "任务长时间无输出且未完成，已强制中止。可以重新发送需求。");
          this.cancelChat(chatId).catch(() => {});
          continue;
        }

        const thresholdMs = a.notifyCount === 0
          ? AGENT_IDLE_THRESHOLD_MS       // 第一次：10 分钟
          : AGENT_IDLE_THRESHOLD_2_MS;    // 第二次：30 分钟

        if (idleMs > thresholdMs) {
          const idleMin = Math.round(idleMs / 60_000);
          const header = `⚠️ ${idleMin} 分钟无输出`;
          const parts = ["已经 " + idleMin + " 分钟没有新输出，有可能卡住了。可以发 /stop 停止当前任务。"];
          if (a.recentLines.length > 0) {
            const logBlock = a.recentLines.map((l) => l.replace(/`{3,}/g, "``").slice(0, ERROR_DISPLAY_MAX_LEN)).join("\n");
            parts.push(`**最近 ${a.recentLines.length} 条日志：**\n\`\`\`\n${logBlock}\n\`\`\``);
          }
          const content = parts.join("\n\n");
          this.sendWatchdogCard(chatId, header, content);
          a.notifyCount++;
          a.lastNotifiedAt = now;
        }
      }
    }

    // ── 独立 session（cron/task）idle 检测 ──
    for (const [sessionId, task] of this.runningTasks) {
      if (
        task.source === "cron"
        && task.cronJobId !== undefined
        && task.cronClaimToken !== undefined
        && !this.isCronClaimCurrent(task.cronJobId, task.cronClaimToken)
      ) {
        task.backend.cancelSession(task.agentSession).catch(() => {});
        continue;
      }
      if (!(task.backend instanceof CliAgentBackend)) continue;
      const a = task.backend.getActivity(sessionId);
      if (!a || a.status !== "running") continue;

      const idleMs = now - a.lastActiveAt;
      const runningMs = now - task.startedAt;

      // completion 已检测到但进程没退出 → 自动 kill
      if (a.completionDetected && idleMs > 5_000) {
        this.log.info("watchdog: auto-kill independent session, completion + idle", {
          sessionId, chatId: task.chatId, description: task.description, idleMs,
        });
        task.backend.cancelSession(task.agentSession).catch(() => {});
        continue;
      }

      // 仍在活跃的长任务 → 低频提醒，不 kill
      if (
        !a.completionDetected
        && idleMs <= AGENT_IDLE_THRESHOLD_MS
        && runningMs > INDEPENDENT_LONG_RUNNING_NOTIFY_MS
        && (!a.lastLongRunningNotifiedAt || now - a.lastLongRunningNotifiedAt > AGENT_LONG_RUNNING_REPEAT_NOTIFY_MS)
      ) {
        const runningHours = formatLongRunningHours(runningMs);
        const header = "定时任务还在运行";
        const parts = [
          `「${task.description}」已经运行约 ${runningHours} 小时，进程仍在运行。`,
          formatOutputActivity(idleMs),
        ];
        this.sendWatchdogCard(task.chatId, header, parts.join("\n\n"));
        a.lastLongRunningNotifiedAt = now;
        continue;
      }

      // 同上：只在一小时内豁免；超过后恢复原 idle kill。
      if (a.executingTool && idleMs <= INDEPENDENT_IDLE_KILL_MS) continue;

      // 1 小时无活动 → 通知用户 + kill（重试最多 3 次）
      if (!a.completionDetected && a.notifyCount < 3 && idleMs > INDEPENDENT_IDLE_KILL_MS) {
        const idleMin = Math.round(idleMs / 60_000);
        const totalMin = Math.round(runningMs / 60_000);
        this.log.error("watchdog: independent session idle, killing", {
          sessionId, chatId: task.chatId, description: task.description, idleMs, runningMs,
          attempt: a.notifyCount + 1,
        });
        if (a.notifyCount === 0) {
          const header = `⚠️ 定时任务卡住已终止`;
          const content = `「${task.description}」运行 ${totalMin} 分钟，其中 ${idleMin} 分钟无输出，已自动终止。`;
          this.sendWatchdogCard(task.chatId, header, content);
        }
        task.backend.cancelSession(task.agentSession).catch(() => {});
        a.notifyCount++;
      }
    }
  }
}

function extractAgentErrorDetail(err: unknown): string | null {
  const stderr = typeof err === "object" && err !== null && "stderr" in err
    ? String((err as { stderr?: unknown }).stderr ?? "")
    : "";
  const stdout = typeof err === "object" && err !== null && "stdout" in err
    ? String((err as { stdout?: unknown }).stdout ?? "")
    : "";

  // Only scan the tail of each stream. For streaming JSON backends (Claude),
  // the terminating `result` event is by protocol the last frame; Codex's
  // error events also sit at the tail. Earlier lines are system / hook /
  // message events we don't want. A small tail also bounds the work done
  // on pathologically large streams.
  const TAIL_LINES = 20;
  const parts: string[] = [];

  for (const stream of [stdout, stderr]) {
    if (!stream) continue;
    const allLines = stream.split("\n");
    const tail = allLines.slice(-TAIL_LINES);
    for (const line of tail) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        // Claude format: {type:"result", is_error:true, result:"..."}
        if (event.type === "result" && event.is_error && typeof event.result === "string" && event.result.trim()) {
          parts.push(event.result.trim());
        }
        // Codex / generic format: {type:"error", message:"..."}
        if (event.type === "error" && typeof event.message === "string" && event.message.trim()) {
          parts.push(event.message.trim());
        }
        // Opencode format: {type:"error", error:{name:"...", data:{message:"..."}}}
        if (event.type === "error" && typeof event.error === "object" && event.error !== null) {
          const errObj = event.error as Record<string, unknown>;
          if (typeof errObj.message === "string" && (errObj.message as string).trim()) {
            parts.push((errObj.message as string).trim());
          }
          const dataObj = errObj.data as Record<string, unknown> | undefined;
          if (typeof dataObj?.message === "string" && (dataObj.message as string).trim()) {
            parts.push((dataObj.message as string).trim());
          }
        }
      } catch {
        // Not JSON — skip to avoid leaking raw log lines
      }
    }
  }

  // Also include the Error.message itself (may carry info not in streams)
  const message = err instanceof Error ? err.message.trim() : String(err ?? "").trim();
  if (message) parts.push(message);

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique = parts.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });

  if (unique.length === 0) return null;

  // Safety cap: even with cleaner extraction, some error paths may still
  // produce multi-KB output. Cap total length so user-facing errors stay
  // readable and don't flood IM.
  const joined = unique.join("\n");
  return joined.length > ERROR_DISPLAY_MAX_LEN ? joined.slice(0, ERROR_DISPLAY_MAX_LEN) + "…" : joined;
}

function extractPlatformErrorDetail(err: unknown): string {
  const data = typeof err === "object" && err !== null && "response" in err
    ? (err as { response?: { data?: { code?: unknown; msg?: unknown } } }).response?.data
    : undefined;
  const msg = typeof data?.msg === "string" ? data.msg.trim() : "";
  const code = data?.code;

  if (msg && code !== undefined && code !== null && String(code).trim()) {
    return `${msg} (code: ${String(code).trim()})`;
  }
  if (msg) return msg;

  const message = err instanceof Error ? err.message.trim() : String(err ?? "").trim();
  return message || "平台发送失败";
}

/** 检查命令是否在 PATH 中（对齐 Go exec.LookPath） */
function commandExistsSync(cmd: string): boolean {
  return resolveExecutable(cmd) !== undefined;
}

/** Shell 输出最大字符数（超出截断） */
const SHELL_MAX_OUTPUT_LEN = 4000;

type ShellExecError = {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  killed?: boolean;
  signal?: NodeJS.Signals | string | null;
};

function formatShellExecErrorDetails(cwd: string, cmd: string, err: unknown): { output: string; exitCode: number; formatted: string } {
  const execErr = err as ShellExecError;
  const lines: string[] = [];
  const output = ((execErr.stdout ?? "") + (execErr.stderr ?? "")).trim();
  if (output) lines.push(output);
  if (execErr.killed) lines.push(`command timed out after ${SHELL_COMMAND_TIMEOUT_MS}ms`);
  if (execErr.signal) lines.push(`signal: ${execErr.signal}`);

  const exitCode = execErr.code ?? 1;
  const formattedOutput = lines.join("\n");
  return {
    output: formattedOutput,
    exitCode,
    formatted: formatShellOutput(cwd, cmd, formattedOutput, exitCode),
  };
}

export function formatShellExecError(cwd: string, cmd: string, err: unknown): string {
  return formatShellExecErrorDetails(cwd, cmd, err).formatted;
}

/** 格式化 shell 命令输出 */
function formatShellOutput(cwd: string, cmd: string, output: string, exitCode: number): string {
  let body = "";
  if (!output && exitCode === 0) {
    body = "(no output)\n";
  } else {
    if (output.length > SHELL_MAX_OUTPUT_LEN) {
      body = output.slice(0, SHELL_MAX_OUTPUT_LEN);
      if (!body.endsWith("\n")) body += "\n";
      body += `... (output truncated, ${output.length} chars total)\n`;
    } else {
      body = output;
      if (body && !body.endsWith("\n")) body += "\n";
    }
  }
  if (exitCode !== 0) {
    body += `exit code: ${exitCode}\n`;
  }
  return `\`\`\`\n$ ${cwd}> ${cmd}\n${body}\`\`\``;
}

/** 格式化 uptime 毫秒为可读字符串 */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

/** 转义飞书卡片 Markdown 行内文本；尖括号改为全角，避免被识别为组件标签。 */
function escapeLarkMarkdownText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([*_~`\[\]()])/g, "\\$1")
    .replace(/</g, "＜")
    .replace(/>/g, "＞");
}

function formatRelativeAge(sqlUtcDatetime: string): string {
  const timestamp = parseSqlUtcDatetime(sqlUtcDatetime);
  if (timestamp === undefined) return "未知";
  return formatRelativeAgeMs(timestamp);
}

function formatRelativeAgeMs(epochMs: number): string {
  const diffMs = Math.max(0, Date.now() - epochMs);
  if (diffMs < 60_000) return "刚刚";

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;

  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

function parseSqlUtcDatetime(value: string): number | undefined {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function displayBackendType(type: AgentBackendType): string {
  return type;
}

function isTerminalRunStage(stage: RunStage): boolean {
  return stage === "done" || stage === "failed" || stage === "stopped";
}

function displayRunStage(stage: RunStage): string {
  switch (stage) {
    case "queued": return "排队中";
    case "agent_running": return "处理中";
    case "sending_response": return "发送回复";
    case "done": return "已完成";
    case "failed": return "失败";
    case "stopped": return "已停止";
  }
}
