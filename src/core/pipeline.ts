import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { renderForward, renderMsg, renderQuotedText } from "../im/render.js";
import { wrapInjectedUserMessage } from "../session-archive/native-transcript.js";
import type { InboundDelivery, NormalizedMessage, TransportClient } from "../transport/types.js";
import { mentionMarksApp } from "../transport/types.js";
import { isDeliveryUncertainError } from "../transport/errors.js";
import { ERROR_DISPLAY_MAX_LEN } from "../agent/types.js";
import { AgentSessionNotStartedError, type AgentBackend, type AgentResponse, type AgentSession, type AgentSessionActivity, type SessionConfig } from "../agent/types.js";
import { nativeSessionId } from "../agent/session-id.js";
import { CliAgentBackend, buildNiubotEnv } from "../agent/cli-base.js";
import {
  BUILTIN_BACKEND_LIST,
  NIUBOT_HOME,
  normalizeBackend,
  type AgentBackendType,
} from "../config.js";
import { ChatManager } from "./chat-manager.js";
import type { QueuedMessage } from "./queue.js";
import {
  buildScopeKey,
  parseScopeKey,
  resolveSessionScope,
  shouldIsolateChat,
  shouldStrictTopicReply,
  CHAT_MODE_TTL_MS,
  type SessionScope,
} from "./session-scope.js";
import {
  ensureUser, ensureChat, storeMessage, updateChatName,
  getUserShortLabel, getChatShortLabel, getMessageByPlatformId, updateMessageContent, updateMessagePlatformId,
  markMessagesAgentSeen,
  setUserIsBot, getUserIsBot,
  setUserAdminRole, getAdminUserIds, getUserAdminRole, type AdminRole,
  getScopeRuntimeConfig, setScopeRuntimeConfig, deleteScopeRuntimeConfig,
  findP2pChatIdForUser, type ScopeRuntimeConfig,
  getRecentRuntimeEvents,
  getChatMetadata as getStoredChatMetadata,
  updateChatMetadata,
  markUnfinishedRuntimeRunsFailedByRestart,
  recordRuntimeEvent,
} from "../database/schema.js";
import {
  AUTO_UPDATE_DEFAULTS,
  mainRunSource, goalSource, cronSource, loopSource,
  type AutoUpdateConfig, type UpgradeSafenessSource,
} from "./auto-update.js";
import {
  buildActiveTaskContext,
  buildImportantContext,
  buildNormalContext,
  buildSpeakerContext,
  buildStableSystemContext,
  COMPACT_RECOVERY_REMINDER,
  NEW_SESSION_SEARCH_REMINDER,
  type SceneInfo,
  type SpeakerInfo,
  type StableSystemContextOptions,
} from "../memory/inject.js";
import {
  dateTimeInTimeZone,
  DEFAULT_TIMEZONE,
  formatLocalDateTimeWithTZ,
  isTimezoneChangeUtterance,
  normalizeTimeZoneInput,
  resolveSystemTimeZone,
  timezoneCommandIsResolved,
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
import { resolveExecutable } from "../platform/executable.js";
import { runCommand } from "../platform/command.js";
import { collectDisplayStatus, formatDisplayStatus } from "../platform/display-status.js";
import {
  buildWindowsAdminShellInvocation,
  shouldHandleAdminShellCommand,
} from "../platform/admin-shell.js";
import type { BackendCapability } from "../agent/backend-capability.js";
import { buildResponseFooter } from "./footer.js";
import { ResponseSender, type SendResult } from "./response-sender.js";
import { withTimeout } from "./timeout.js";
import { RuntimeStateStore, type RunStage, type RuntimeStateEvent } from "./runtime-state.js";
import { RunManager, type RunAgentResult } from "./run-manager.js";
import { archiveAgentSession } from "../session-archive/archive.js";

import type { EngineLifecycle } from "../engine-lifecycle.js";
import {
  appendFuseNotice,
  BOT_COLLAB_FUSE_LIMIT,
  hasFeishuAtTag,
  invertFeishuAtsToShortLabels,
  rewriteOutboundMentions,
  extractBuiltinCommandText,
  stripLeadingAtMentions,
  type MentionUser,
} from "../im/mentions.js";

export { resolveUpdateCommandCwd } from "../update-command.js";

const PROCESSING_EMOJI = "Get";
const MERGED_EMOJI = "Pin";
const EMPTY_RESPONSE_FALLBACK = "（处理完成，但未生成回复。如果没收到预期结果，请重试）";
const UPDATE_CONFIRM_COMMAND = "/update 1";
/** /effort 可选级别（与 claude --effort 值域一致） */
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
/** 支持 effort 透传的内置 backend（CLI 能力静态声明；不支持的 backend 保存但不生效） */
const EFFORT_SUPPORTED_BACKENDS = new Set(["claude", "codex", "pi", "opencode", "traecli", "grok"]);
export const SHELL_COMMAND_TIMEOUT_MS = 300_000;

/** 过期消息阈值（ms）：超过 2 分钟的消息丢弃 */
const STALE_MESSAGE_THRESHOLD_MS = 2 * 60 * 1000;

/** 短词打断关键词 */
const INTERRUPT_WORDS = new Set([
  "停", "停下", "停止", "打住", "够了", "算了", "算了吧", "取消",
  "等等", "等一下", "稍等",
  "stop", "cancel", "abort",
]);

const BUILTIN_COMMANDS = new Set([
  "/restart", "/update", "/service", "/new", "/agent", "/model", "/effort", "/autoupdate",
  "/admin", "/help", "/stop", "/clear", "/flush", "/task", "/status", "/history", "/awake",
  "/timezone", "/tz",
]);
const HYBRID_SCHEDULE_COMMANDS = new Set(["/loop", "/cron"]);
const SCHEDULE_BUILTIN_SUBCOMMANDS = new Set([
  "list", "ls", "help", "--help", "cancel", "stop", "del", "delete", "rm",
]);

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
    case "/loop":
      return `${rest}（用户要求创建循环任务，请使用 nbt schedule create --mode current_session）`;
    case "/cron":
      return `${rest}（用户要求创建定时任务，请使用 nbt schedule create --mode new_session）`;
    case "/tz":
    case "/timezone":
      return `${rest}（用户要切换展示时区，内置 /tz 没认出这个名字。请根据常识解析成 IANA，然后立刻执行 \`nbt timezone set <IANA>\`，例如 \`nbt timezone set America/Los_Angeles\`。不要让用户再打一遍 /tz。）`;
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
const INDEPENDENT_IDLE_KILL_MS = 3_600_000;    // 1 小时：独立 session 无活动自动 kill
const INDEPENDENT_LONG_RUNNING_NOTIFY_MS = 3_600_000;  // 1 小时：独立 session 仍活跃时提醒
const LOOP_TASK_PREVIEW_MAX_CHARS = 80;
const STARTUP_PLATFORM_TIMEOUT_MS = 5_000;      // 平台启动探测超时后降级继续启动

/** 关闭阶段取消/关闭 backend session 的超时保护：后端卡住时不让 shutdown 永久阻塞。 */
function withShutdownTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

/** 出站消息保护：剥离历史内部区段和残留裸标签，避免内部内容到达用户。 */
function stripInternalTags(text: string): string {
  return text
    .replace(/<schedule-skill>[\s\S]*?<\/schedule-skill>/g, "")
    .replace(/<loop-continuation>[\s\S]*?<\/loop-continuation>/g, "")
    .replace(/<\/?(?:schedule|loop)-[a-z-]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Engine 强制添加的 Loop 来源信息，不依赖模型自行说明。 */
function buildTaskPreview(prompt: string): string {
  const normalizedPrompt = stripInternalTags(prompt).replace(/\s+/g, " ").trim();
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
  /** ChatSessionId：NiuBot 会话记录 `sessions.id`，不是 NativeSessionId。 */
  sessionId: string;
  platformChatId: string;
  userId: string;
  threadId?: string;
  isolated: boolean;
  /** 当前群是话题形态时，即使未隔离也禁止 create 新话题。 */
  strict: boolean;
  /** 触发消息的 platform msg ID（用于首条回复时引用） */
  triggerPlatformMsgId?: string;
  /** 是否已发送过回复（首条用 reply，后续用普通 send） */
  hasReplied: boolean;
  /** 本 scope 正在使用的 backend；缺省时回落到引擎默认 backend。 */
  backendType?: AgentBackendType;
}

interface RunningTask {
  agentSession: AgentSession;
  backend: AgentBackend;
  backendType: AgentBackendType;
  chatId: string;
  scopeKey: string;
  description: string;
  startedAt: number;
  source: "cron" | "task";
  /** 独立任务创建时保存的回复锚点，watchdog 通知不能新开话题。 */
  replyToMsgId?: string;
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

interface ActiveScheduleAgentCommandContext {
  runId: string;
  userId: string;
  chatType: "p2p" | "group";
  userTurn: boolean;
  /** 主会话能力令牌：请求必须携带同一令牌才能借用本回合身份 */
  token: string;
}

type SessionEndStatus = "archived" | "archive_failed" | "discarded";

export class Pipeline {
  private db: Database.Database;
  private transport: TransportClient;
  private agent: AgentBackend;
  /** 引擎默认 backend（配置值）。`/agent` 只改当前 scope，不改这个默认。 */
  private backendType: AgentBackendType;
  private backendResolver?: (type: AgentBackendType) => Promise<AgentBackend>;
  private backends = new Map<AgentBackendType, AgentBackend>();
  private backendLoads = new Map<AgentBackendType, Promise<AgentBackend>>();
  private getAvailableBackends: () => string[];
  private getBackendCapabilities: () => BackendCapability[] | Promise<BackendCapability[]>;
  private queue: ChatManager;
  private responseSender: ResponseSender;
  private runtimeState: RuntimeStateStore;
  private runManager: RunManager;
  private engineLifecycle?: EngineLifecycle;

  /** 自动升级是否启用：唯一来源是服务配置文件的 autoUpdate 布尔值。 */
  private isAutoUpdateEnabled(): boolean {
    return this.engineLifecycle?.getAutoUpdateConfig()?.enabled === true;
  }

  private effectiveAutoUpdateConfig(): AutoUpdateConfig {
    return this.engineLifecycle?.getAutoUpdateConfig() ?? { enabled: true, ...AUTO_UPDATE_DEFAULTS };
  }
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

  /** 本群连续被 Bot 触发并跑 Agent 的回合数（人入站清零） */
  private botTurnCounts = new Map<string, number>();

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

  /** 已处理的消息 ID 去重集合（有上限防内存泄漏） */
  private processedMsgIds = new Set<string>();
  private static readonly MAX_PROCESSED_IDS = 10000;

  /** chatId → triggerPlatformMsgId，暂存触发消息 ID */
  private triggerMsgIds = new Map<string, string>();

  /** chatId → transition promise，session 切换期间后续消息先挂起 */
  private sessionTransitionLocks = new Map<string, Promise<void>>();
  /** 全局过渡（重启等）阻塞所有 chat；/agent 只用 per-scope 锁 */
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

  private activeScheduleAgentCommands = new Map<string, ActiveScheduleAgentCommandContext>();

  /** chatId → 主会话调度令牌：随主 Agent 环境注入，独立 session 拿不到，防跨进程身份借用。 */
  private chatScheduleTokens = new Map<string, string>();

  /** token → scopeKey：IPC 反查，避免平台 chat_id 串话题。 */
  private tokenToScope = new Map<string, string>();

  /** 正在占用主聊天队列的 Loop 回合；取消命令用它精确中止对应 run。 */
  private activeLoopRuns = new Map<number, { chatId: string; scopeKey?: string; runId?: string; selfCancelled?: boolean }>();

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
    _legacyRestartConfig?: unknown,
    _legacyAutoUpdateCoordinator?: boolean,
    archiveHome?: string,
    getBackendCapabilities?: () => BackendCapability[] | Promise<BackendCapability[]>,
    _legacyAutoUpdateConfig?: unknown,
    _legacyConfigPath?: string,
    _legacyOnAutoUpdateConfigChanged?: () => void,
    engineLifecycle?: EngineLifecycle,
  ) {
    this.db = db;
    this.transport = transport;
    this.agent = agent;
    this.backendType = backendType;
    this.backendResolver = backendResolver;
    this.backends.set(backendType, agent);
    this.getAvailableBackends = getAvailableBackends ?? (() => [...BUILTIN_BACKEND_LIST]);
    this.getBackendCapabilities = getBackendCapabilities ?? (() => this.getAvailableBackends().map((backend) => ({
      backend: backend as BackendCapability["backend"],
      platform: process.platform,
      installed: true,
      selectable: true,
    })));
    this.botIdentity = botIdentity;
    this.workingDirectory = workingDirectory;
    this.dbPath = dbPath;
    this.refreshAgentContextFiles = refreshAgentContextFiles;
    this.stableContextOptions = stableContextOptions ?? {};
    this.engineLifecycle = engineLifecycle;
    this.archiveHome = archiveHome ?? (process.env["VITEST"]
      ? path.join(path.dirname(dbPath), ".niubot-test")
      : NIUBOT_HOME);
    this.log = createLogger("pipeline", botIdentity.name);
    this.runtimeState = new RuntimeStateStore({
      onEvent: (event) => this.persistRuntimeEvent(event),
    });
    this.queue = new ChatManager(bufferMs, this.runtimeState);
    this.responseSender = new ResponseSender(transport);
    this.runManager = new RunManager(this.runtimeState, this.responseSender);

    // 初始 backend 的模型配置入缓存，确保切走再切回来能恢复
    this.backendModelCache.set(backendType, {
      model: botIdentity.model,
      effort: botIdentity.effort,
    });

    this.queue.onProcess((runId, chatId, mergedText, messages, signal, scopeKey) => (
      this.process(scopeKey ?? chatId, mergedText, messages, signal, runId)
    ));
    this.queue.onIdle((scopeKey) => {
      void this.maybeUnloadScope(scopeKey);
    });
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
    const writerThreshold = Number(process.env["NIUBOT_CWD_WRITER_WARN"] ?? 6);
    const activeWriters = this.chatSessions.size + this.independentRunCount + 1;
    if (Number.isFinite(writerThreshold) && activeWriters >= Math.max(1, writerThreshold)) {
      this.log.warn("cwd writer soft cap reached", {
        cwd: config.workingDirectory,
        activeWriters,
        threshold: writerThreshold,
      });
    }
    this.log.info("agent session start", {
      cwd: config.workingDirectory,
      scopeKey: config.scopeKey ?? config.chatId,
      threadId: config.threadId,
      source: "user",
      isolated: Boolean(config.threadId),
    });
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
    setUserIsBot(this.db, this.botUserId);

    this.markUnfinishedRuntimeRunsFailedByRestart();
    this.restoreAdminsFromDb();

    // 启动 watchdog 定时器
    this.watchdogTimer = setInterval(() => this.runIdleWatchdogSafely(), AGENT_WATCHDOG_INTERVAL_MS);

    this.runStartupPlatformProbes();

    this.log.info("pipeline started", {
      botUserId: this.botUserId,
      botPlatformId: this.botIdentity.platformBotId,
      adminCount: this.adminRoles.size,
      backend: this.backendType,
      model: this.botIdentity.model ?? "default",
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
    setUserIsBot(this.db, this.botUserId);
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
    this.queue.stop();
    this.log.info("pipeline stopped");
  }

  /** 优雅关闭：cancel 所有活跃 session，清理资源（DB 中 session 保持 active，下次启动恢复） */
  async shutdown(): Promise<void> {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    for (const [chatId, session] of this.chatSessions) {
      try {
        // 更新 DB 最后活跃时间
        this.db.prepare("UPDATE sessions SET last_active_at = datetime('now') WHERE id = ?")
          .run(session.sessionId);
        // 后端卡住时不能让 shutdown 永久阻塞，逐个限时。
        const backend = this.backendForSession(session);
        await withShutdownTimeout(backend.cancelSession(session.agentSession), 5_000);
        await withShutdownTimeout(backend.closeSession(session.agentSession), 5_000);
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

  /** 是否有正在处理的主会话或独立 session（Cron/task）——优雅关闭等待用 */
  hasBusyChats(): boolean {
    return this.queue.hasBusyChats()
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

  /** 调度写入口。身份取当前 Agent 回合，不信任 Session 创建时固定的环境变量。 */
  async executeScheduleAgentCommand(
    chatId: string,
    command: ScheduleAgentCommand,
    token?: string,
    scope?: { scopeKey?: string; threadId?: string; replyToMsgId?: string },
  ): Promise<ScheduleAgentCommandResult> {
    command = parseScheduleAgentCommand(command);
    const scopeKey = scope?.scopeKey ?? chatId;
    const threadId = scope?.threadId;
    const context = this.activeScheduleAgentCommands.get(scopeKey);
    const activeRun = this.runtimeState.getActiveRunForScope(scopeKey);
    const replyToMsgId = activeRun?.replyToPlatformMsgId;
    if (!context || !activeRun || activeRun.runId !== context.runId || activeRun.stage !== "agent_running") {
      throw new Error("调度写操作必须在当前主会话的活动 Agent 回合内执行");
    }
    if (!token || token !== context.token) {
      throw new Error("调度请求缺少或携带错误的能力令牌");
    }
    if (!context.userTurn) throw new Error("只有用户消息回合可以修改调度任务");

    switch (command.type) {
      case "create.schedule": {
        const timeZone = TZ;
        if (command.mode === "main") {
          let id: number;
          if (command.trigger === "every") {
            id = addLoopJob(this.db, {
              chatId,
              threadId,
              replyToMsgId,
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
              threadId,
              replyToMsgId,
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
              threadId,
              replyToMsgId,
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
              ? describeCronExpr(job.cronExpr ?? command.cronExpr!, job.timezone)
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
          threadId,
          replyToMsgId,
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
          job.cronExpr ? `Schedule: ${describeCronSchedule(job.cronExpr, null, job.timezone)}` : `Run at: ${formatLocalDateTimeWithTZ(job.runAt!)}`,
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
          const active = this.activeLoopRuns.get(id);
          if (active?.scopeKey === scopeKey) {
            // 当前这轮自己退出：别杀掉 Agent，让它把结论发完。
            active.selfCancelled = true;
          } else if (job.status === "running") {
            this.cancelActiveLoopRun(id, scopeKey);
          }
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

  private platformChatIdToScopeKey(platformChatId: string): string | undefined {
    const chatRow = this.db.prepare("SELECT id FROM chats WHERE platform_id = ?")
      .get(platformChatId) as { id: string } | undefined;
    if (!chatRow) return undefined;
    for (const scopeKey of this.chatScheduleTokens.keys()) {
      if (parseScopeKey(scopeKey).chatId === chatRow.id) return scopeKey;
    }
    return chatRow.id;
  }

  /** IPC 发送：仅主 Agent 当前回合（schedule token 匹配）才挂到用户消息下 */
  private currentTurnReplyTarget(
    platformChatId: string,
    scheduleToken?: string,
    scopeKey?: string,
  ): string | undefined {
    if (!scheduleToken) return undefined;
    const resolvedScopeKey = scopeKey ?? this.platformChatIdToScopeKey(platformChatId);
    if (!resolvedScopeKey) return undefined;
    if (this.tokenToScope.get(scheduleToken) !== resolvedScopeKey
      && this.chatScheduleTokens.get(resolvedScopeKey) !== scheduleToken) return undefined;
    return this.runtimeState.getActiveRunForScope(resolvedScopeKey)?.replyToPlatformMsgId;
  }

  /** 话题内最后一次平台消息 ID；跨进程 IPC 没有 schedule token 时作为回复锚点。 */
  private latestThreadPlatformMsgId(chatId: string, threadId?: string): string | undefined {
    const row = this.db.prepare(`
      SELECT platform_msg_id AS platformMsgId
      FROM messages
      WHERE chat_id = ? AND (? IS NULL OR thread_id = ?)
        AND platform_msg_id IS NOT NULL AND platform_msg_id != ''
      ORDER BY id DESC
      LIMIT 1
    `).get(chatId, threadId ?? null, threadId ?? null) as { platformMsgId: string } | undefined;
    return row?.platformMsgId;
  }

  private async sendPreferringReply(
    platformChatId: string,
    logLabel: string,
    sendReply: (replyToMsgId: string) => Promise<string>,
    sendChat: () => Promise<string>,
    replyToMsgId?: string,
    options: { allowChatFallback?: boolean; replyInThread?: boolean } = {},
  ): Promise<string> {
    const allowChatFallback = options.allowChatFallback !== false;
    if (!replyToMsgId) {
      if (!allowChatFallback) throw new Error("No reply anchor available; create fallback is disabled");
      return sendChat();
    }
    try {
      return await sendReply(replyToMsgId);
    } catch (err) {
      if (isDeliveryUncertainError(err)) throw err;
      this.log.warn(`${logLabel}: reply failed, fallback to chat`, {
        chatId: platformChatId,
        replyToMsgId,
        error: String(err),
      });
      if (!allowChatFallback) throw err;
      return sendChat();
    }
  }

  /** 通过 IPC 发送消息到指定 chat */
  async sendToChat(
    platformChatId: string,
    text: string,
    scheduleToken?: string,
    scope?: { scopeKey?: string; threadId?: string; replyToMsgId?: string },
  ): Promise<void> {
    const scopeKey = scope?.scopeKey ?? this.platformChatIdToScopeKey(platformChatId) ?? platformChatId;
    const threadId = scope?.threadId;
    const strict = Boolean(threadId) || this.isStrictTopicChat(parseScopeKey(scopeKey).chatId);
    const replyToMsgId = scope?.replyToMsgId
      ?? this.currentTurnReplyTarget(platformChatId, scheduleToken, scopeKey)
      ?? (threadId ? this.latestThreadPlatformMsgId(parseScopeKey(scopeKey).chatId, threadId) : undefined);
    const prepared = this.prepareOutboundText(platformChatId, text);
    const platformMsgId = await this.sendPreferringReply(
      platformChatId,
      "sendToChat",
      (replyToMsgId) => this.transport.sendReply(
        platformChatId,
        prepared.text,
        replyToMsgId,
        { replyInThread: strict },
      ),
      () => this.transport.sendText(platformChatId, prepared.text),
      replyToMsgId,
      { allowChatFallback: !strict, replyInThread: strict },
    );
    const chatRow = this.db.prepare("SELECT id FROM chats WHERE platform_id = ?")
      .get(platformChatId) as { id: string } | undefined;
    if (chatRow) {
      this.storeBotResponse(chatRow.id, prepared.historyText, platformMsgId, "text", threadId);
    }
  }

  /** 通过 IPC 发送卡片到指定 chat */
  async sendCardToChat(
    platformChatId: string,
    header: string,
    content: string,
    scheduleToken?: string,
    scope?: { scopeKey?: string; threadId?: string; replyToMsgId?: string },
  ): Promise<void> {
    const scopeKey = scope?.scopeKey ?? this.platformChatIdToScopeKey(platformChatId) ?? platformChatId;
    const threadId = scope?.threadId;
    const strict = Boolean(threadId) || this.isStrictTopicChat(parseScopeKey(scopeKey).chatId);
    const replyToMsgId = scope?.replyToMsgId
      ?? this.currentTurnReplyTarget(platformChatId, scheduleToken, scopeKey)
      ?? (threadId ? this.latestThreadPlatformMsgId(parseScopeKey(scopeKey).chatId, threadId) : undefined);
    const prepared = this.prepareOutboundText(platformChatId, content);
    const platformMsgId = await this.sendCardKeepingAt(
      platformChatId,
      "sendCardToChat",
      header,
      prepared.text,
      replyToMsgId,
      true,
      { allowChatFallback: !strict, replyInThread: strict },
    );
    const chatRow = this.db.prepare("SELECT id FROM chats WHERE platform_id = ?")
      .get(platformChatId) as { id: string } | undefined;
    if (chatRow) {
      this.storeBotResponse(chatRow.id, prepared.historyText, platformMsgId, "text", threadId);
    }
  }

  /** 卡片失败时，完整飞书 at 改走文本，避免对方 Bot 收不到。 */
  private async sendCardKeepingAt(
    platformChatId: string,
    logLabel: string,
    header: string,
    text: string,
    replyToMsgId?: string,
    preferReply = true,
    options: { allowChatFallback?: boolean; replyInThread?: boolean } = {},
  ): Promise<string> {
    const sendCard = () => this.transport.sendCard(platformChatId, header, text);
    const sendCardReply = (id: string) => this.transport.sendCard(
      platformChatId,
      header,
      text,
      undefined,
      id,
      { replyInThread: options.replyInThread },
    );
    try {
      if (!preferReply) return await sendCard();
      return await this.sendPreferringReply(
        platformChatId,
        logLabel,
        sendCardReply,
        sendCard,
        replyToMsgId,
        options,
      );
    } catch (err) {
      if (isDeliveryUncertainError(err) || !hasFeishuAtTag(text)) throw err;
      this.log.warn(`${logLabel}: card failed, fallback to at text`, {
        chatId: platformChatId,
        error: String(err),
      });
      return this.sendPreferringReply(
        platformChatId,
        logLabel,
        (id) => this.transport.sendReply(
          platformChatId,
          text,
          id,
          { replyInThread: options.replyInThread },
        ),
        () => this.transport.sendText(platformChatId, text),
        preferReply ? replyToMsgId : undefined,
        options,
      );
    }
  }

  private loadMentionUsers(): MentionUser[] {
    const rows = this.db.prepare(
      "SELECT id, name, platform_id, is_bot FROM users",
    ).all() as Array<{ id: string; name: string | null; platform_id: string; is_bot: number }>;
    return rows.map((row) => ({
      id: row.id,
      platformId: row.platform_id,
      name: row.name,
      isBot: row.is_bot === 1,
    }));
  }

  private prepareOutboundText(
    platformChatId: string,
    text: string,
  ): {
    text: string;
    historyText: string;
  } {
    const chatRow = this.db.prepare("SELECT id, type FROM chats WHERE platform_id = ?")
      .get(platformChatId) as { id: string; type: string } | undefined;
    const chatId = chatRow?.id;
    const isGroup = chatRow?.type === "group";
    const fuseTripped = isGroup && !!chatId && (this.botTurnCounts.get(chatId) ?? 0) > BOT_COLLAB_FUSE_LIMIT;
    const users = this.loadMentionUsers();
    const result = rewriteOutboundMentions(text, users, {
      selfUserId: this.botUserId,
      stripAllBotAts: fuseTripped,
    });
    let out = result.text;
    if (fuseTripped) {
      this.log.info("bot-collab fuse tripped", { chatId, count: chatId ? this.botTurnCounts.get(chatId) : undefined });
      out = appendFuseNotice(out);
    }
    return {
      text: out,
      historyText: invertFeishuAtsToShortLabels(out, users),
    };
  }

  private async sendPreparedFinalResponse(
    platformChatId: string,
    options: {
      header: string;
      content: string;
      footer?: string;
      replyToMsgId?: string;
      replyInThread?: boolean;
      allowChatFallback?: boolean;
      signal?: AbortSignal;
      textFallback?: string | ((error: unknown) => string);
    },
  ): Promise<SendResult & { historyText: string; sentText: string }> {
    const prepared = this.prepareOutboundText(platformChatId, options.content);
    const result = await this.responseSender.sendFinalResponse({
      chatId: platformChatId,
      header: options.header,
      content: prepared.text,
      footer: options.footer,
      replyToMsgId: options.replyToMsgId,
      replyInThread: options.replyInThread,
      allowChatFallback: options.allowChatFallback,
      signal: options.signal,
      textFallback: options.textFallback,
    });
    return {
      ...result,
      historyText: prepared.historyText,
      sentText: prepared.text,
    };
  }

  /** 内置命令卡片：有当前消息就 reply 到话题，始终不主动 create 新话题。 */
  private sendBuiltinCard(
    platformChatId: string,
    chatId: string,
    header: string,
    content: string,
    msgId?: string,
    threadId?: string,
  ): Promise<string> {
    const strict = Boolean(threadId) || this.isStrictTopicChat(chatId);
    if (strict && !msgId) {
      const error = new Error("No reply anchor available; create fallback is disabled");
      this.log.warn("strict topic card skipped without reply anchor", {
        chatId,
        platformChatId,
        header,
      });
      return Promise.reject(error);
    }
    return this.transport.sendCard(
      platformChatId,
      header,
      content,
      undefined,
      msgId,
      { replyInThread: strict },
    );
  }

  private noteHumanInbound(chatId: string, senderIsBot?: boolean): void {
    if (!senderIsBot) this.botTurnCounts.set(chatId, 0);
  }

  private noteBotCollabTurn(chatId: string, chatType: "p2p" | "group", messages: QueuedMessage[]): void {
    if (chatType !== "group") return;
    const inbound = messages.filter((message) => !message.triggerKind || message.triggerKind === "user");
    if (inbound.length === 0) return;
    const anyHuman = inbound.some((message) => !message.senderId || !getUserIsBot(this.db, message.senderId));
    if (anyHuman) {
      this.botTurnCounts.set(chatId, 0);
      return;
    }
    const next = (this.botTurnCounts.get(chatId) ?? 0) + 1;
    this.botTurnCounts.set(chatId, next);
    this.log.info("bot-collab turn", { chatId, count: next });
  }

  /** 通过 IPC 发送文件到指定 chat */
  async sendFileToChat(
    platformChatId: string,
    filePath: string,
    scheduleToken?: string,
    scope?: { scopeKey?: string; threadId?: string; replyToMsgId?: string },
  ): Promise<void> {
    const scopeKey = scope?.scopeKey ?? this.platformChatIdToScopeKey(platformChatId) ?? platformChatId;
    const threadId = scope?.threadId;
    const strict = Boolean(threadId) || this.isStrictTopicChat(parseScopeKey(scopeKey).chatId);
    const replyToMsgId = scope?.replyToMsgId
      ?? this.currentTurnReplyTarget(platformChatId, scheduleToken, scopeKey)
      ?? (threadId ? this.latestThreadPlatformMsgId(parseScopeKey(scopeKey).chatId, threadId) : undefined);
    const platformMsgId = await this.sendPreferringReply(
      platformChatId,
      "sendFileToChat",
      (replyToMsgId) => this.transport.sendFile(
        platformChatId,
        filePath,
        undefined,
        { replyToMsgId, replyInThread: strict },
      ),
      () => this.transport.sendFile(platformChatId, filePath),
      replyToMsgId,
      { allowChatFallback: !strict, replyInThread: strict },
    );
    const chatRow = this.db.prepare("SELECT id FROM chats WHERE platform_id = ?")
      .get(platformChatId) as { id: string } | undefined;
    if (chatRow) {
      this.storeBotResponse(chatRow.id, `[文件] ${filePath}`, platformMsgId, "file", threadId);
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
        threadId: event.threadId,
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

  private async ensureChatMetadata(
    chatId: string,
    platformChatId: string,
  ): Promise<{ chatMode?: string; groupMessageType?: string }> {
    const stored = getStoredChatMetadata(this.db, chatId);
    if (stored?.fetchedAt && Date.now() - stored.fetchedAt < CHAT_MODE_TTL_MS) {
      return stored;
    }
    const fetched = await this.transport.getChatMetadata?.(platformChatId);
    if (fetched) {
      updateChatMetadata(this.db, chatId, fetched);
      return fetched;
    }
    return stored ?? {};
  }

  private isStrictTopicChat(chatId: string): boolean {
    const metadata = getStoredChatMetadata(this.db, chatId) ?? {};
    return shouldStrictTopicReply({
      chatMode: metadata.chatMode,
      groupMessageType: metadata.groupMessageType,
    });
  }

  private isIsolatedTopicChat(chatId: string): boolean {
    const metadata = getStoredChatMetadata(this.db, chatId) ?? {};
    return shouldIsolateChat({
      chatMode: metadata.chatMode,
      groupMessageType: metadata.groupMessageType,
    });
  }

  /** 这个话题已经请过本 Bot：内存队列/session、带 session_key 的本 Bot 回复，或根帖已被本引擎处理。 */
  private topicThreadBelongsToBot(chatId: string, threadId: string, rootId?: string): boolean {
    const scopeKey = buildScopeKey(chatId, threadId);
    if (this.chatSessions.has(scopeKey)) return true;
    if (this.queue.pendingCount(scopeKey) > 0 || this.queue.isBusy(scopeKey)) return true;
    if (this.lookupActiveUserSession(chatId, threadId)) return true;
    if (this.botUserId) {
      const botReply = this.db.prepare(
        `SELECT 1 AS ok FROM messages
         WHERE chat_id = ? AND thread_id = ? AND sender_id = ? AND session_key IS NOT NULL
         LIMIT 1`,
      ).get(chatId, threadId, this.botUserId);
      if (botReply) return true;
    }
    if (!rootId) return false;
    const root = this.db.prepare(
      `SELECT sender_id, session_key, thread_id
       FROM messages
       WHERE platform = ? AND platform_msg_id = ? AND chat_id = ?
       LIMIT 1`,
    ).get(this.botIdentity.platform, rootId, chatId) as {
      sender_id: string | null;
      session_key: string | null;
      thread_id: string | null;
    } | undefined;
    if (!root) return false;
    if (root.thread_id && root.thread_id !== threadId) return false;
    return Boolean(root.session_key);
  }

  private resolveMessageScope(
    chatId: string,
    platformChatId: string,
    msg: NormalizedMessage,
  ): SessionScope {
    const metadata = getStoredChatMetadata(this.db, chatId) ?? {};
    if (msg.chatType === "group"
      && (!metadata.fetchedAt || Date.now() - metadata.fetchedAt >= CHAT_MODE_TTL_MS)) {
      void this.transport.getChatMetadata?.(platformChatId).then(async (fetched) => {
        if (fetched) {
          updateChatMetadata(this.db, chatId, fetched);
        }
      }).catch(() => {});
    }
    return resolveSessionScope({
      chatId,
      platformChatId,
      chatType: msg.chatType,
      chatMode: metadata.chatMode,
      groupMessageType: metadata.groupMessageType,
      threadId: msg.threadId,
    });
  }

  /** Standard Transport entrypoint. Platform events are persisted before reaching this method. */
  async handleInbound(delivery: InboundDelivery): Promise<void> {
    if (delivery.message.chatType === "group") {
      const chatId = ensureChat(
        this.db,
        this.botIdentity.platform,
        delivery.message.chatPlatformId,
        delivery.message.chatType,
        delivery.message.chatName,
      );
      const stored = getStoredChatMetadata(this.db, chatId);
      if (!stored?.fetchedAt || Date.now() - stored.fetchedAt >= CHAT_MODE_TTL_MS) {
        const fetched = await this.transport.getChatMetadata?.(delivery.message.chatPlatformId);
        if (fetched) updateChatMetadata(this.db, chatId, fetched);
      }
      const metadata = getStoredChatMetadata(this.db, chatId);
      const shouldIsolate = shouldIsolateChat({
        chatMode: metadata?.chatMode,
        groupMessageType: metadata?.groupMessageType,
      });
      if (shouldIsolate && !delivery.message.threadId && delivery.message.platformMsgId) {
        const probed = await this.transport.getMessageThreadId?.(delivery.message.platformMsgId);
        if (probed) {
          delivery.message.threadId = probed;
          this.log.info("topic thread id probed from message.get", {
            chatId,
            platformMsgId: delivery.message.platformMsgId,
            threadId: probed,
          });
        } else {
          this.log.debug("topic thread id probe returned none", {
            chatId,
            platformMsgId: delivery.message.platformMsgId,
          });
        }
      }
    }
    try {
      const result = this.handleMessage(
        delivery.message,
        delivery.replayed,
        delivery.inboxId,
        delivery.claimToken,
        delivery.messageId,
      );
      if (result) {
        await result.catch((error) => {
          if (delivery.message.platformMsgId) {
            this.processedMsgIds.delete(delivery.message.platformMsgId);
          }
          throw error;
        });
        return;
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

    // 群聊触发：@bot、回复本 Bot，或已请过本 Bot 的隔离话题里的人跟帖。
    // 明确 @ 了其他应用时，以被 @ 的 Bot 为目标，不能被下面两个兜底条件带起。
    if (msg.chatType === "group" && !msg.botMentioned) {
      const explicitlyTargetsOtherBot = msg.mentions?.some((mention) => mention.isApp === true) ?? false;
      const isReplyToBot = msg.parentPlatformMsgId
        ? this.isMessageFromBot(platform, msg.parentPlatformMsgId)
        : false;
      const chatIdForTrigger = ensureChat(this.db, platform, msg.chatPlatformId, msg.chatType, msg.chatName);
      const isTopicFollowUp = !msg.senderIsBot
        && Boolean(msg.threadId)
        && this.isIsolatedTopicChat(chatIdForTrigger)
        && this.topicThreadBelongsToBot(chatIdForTrigger, msg.threadId!, msg.rootId);

      if (explicitlyTargetsOtherBot || (!isReplyToBot && !isTopicFollowUp) || msg.senderIsBot) {
        // 群聊中未 @ bot 也未回复 bot，只存消息不触发。
        // Bot 只回复不 at：飞书通常不推；即便推到也不当触发。
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
        if (m.platformUserId) {
          const mentionUserId = ensureUser(this.db, platform, m.platformUserId, m.name || undefined, mentionMarksApp(m) ? "bot_info" : "mention");
          if (mentionMarksApp(m)) setUserIsBot(this.db, mentionUserId);
          if (m.name) {
            const shortLabel = getUserShortLabel(this.db, mentionUserId);
            msg.contentText = msg.contentText.replaceAll(`@${m.name}`, `@${shortLabel}`);
          }
        }
      }
    }

    const userId = ensureUser(this.db, platform, msg.senderPlatformId, msg.senderName, "bot_sender");
    if (msg.senderIsBot) setUserIsBot(this.db, userId);

    // Fallback: if no admin detected yet and this is a p2p message, first user becomes owner
    if (this.adminRoles.size === 0 && msg.chatType === "p2p") {
      this.setAdminRole(userId, "owner", "first_p2p_user", msg.senderPlatformId);
    }

    // For p2p chats, link user_id
    const chatUserId = msg.chatType === "p2p" ? msg.senderPlatformId : undefined;
    const chatId = ensureChat(this.db, platform, msg.chatPlatformId, msg.chatType, msg.chatName, chatUserId);
    const scope = this.resolveMessageScope(chatId, msg.chatPlatformId, msg);
    this.noteHumanInbound(chatId, msg.senderIsBot);

    if (this.globalSessionTransition || this.sessionTransitionLocks.has(scope.scopeKey)) {
      this.log.info("message deferred during session transition", {
        chatId,
        scopeKey: scope.scopeKey,
        msgId: msg.platformMsgId,
        type: msg.contentType,
      });
      return this.enqueuePendingTransitionMessage(scope.scopeKey, msg, inboxId, claimToken, recoveredMessageId);
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

    let replyQuoted = "";
    if (msg.parentPlatformMsgId) {
      replyQuoted = this.buildReplyQuoted(platform, msg.parentPlatformMsgId);
    }

    // Store platform_ts as ISO string
    const platformTsStr = msg.platformTs
      ? utcDateTimeForSql(new Date(msg.platformTs))
      : undefined;

    const sessionId = this.chatSessions.get(scope.scopeKey)?.sessionId;
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
        threadId: msg.threadId,
        platformTs: platformTsStr,
        platformRaw: JSON.stringify(msg.raw),
      }),
    });

    this.log.info("message received", {
      chatId, userId,
      scopeKey: scope.scopeKey,
      threadId: scope.threadId,
      type: msg.contentType,
      textLength: msg.contentText.length,
      mentions: msg.mentions?.length ?? 0,
      hasParent: !!msg.parentPlatformMsgId,
      senderIsBot: !!msg.senderIsBot,
    });

    // 缓存映射
    this.platformChatIds.set(chatId, msg.chatPlatformId);
    this.chatUserIds.set(chatId, userId);

    // 独立消息：纯文本（保持 skill 等模式匹配可用）
    // 回复 / 转发：标签树表达嵌套关系
    let agentText: string;
    const label = getUserShortLabel(this.db, userId);

    if (msg.contentType === "merge_forward" && msg.children?.length) {
      agentText = renderForward(label, msg.children);
      if (replyQuoted) agentText += `\n${replyQuoted}`;
    } else if (replyQuoted) {
      agentText = `${renderMsg(label, msg.contentText)}\n${replyQuoted}`;
    } else {
      // 独立消息：纯文本（hybrid 创建命令在此翻译为「任务原文 + nbt 建议」；reply/forward 保持原样）
      // 群聊 @Bot //cmd 与 @Bot /loop 创建：只剥开头 at，保留正文里的 @U4。
      const strippedLeading = stripLeadingAtMentions(msg.contentText.trim());
      const text = this.normalizeUserTextForAgent(strippedLeading.startsWith("//") ? strippedLeading : msg.contentText);
      agentText = rewriteHybridCreationCommand(stripLeadingAtMentions(text)) ?? text;
    }

    // Save trigger msg ID for reply-to-message（process() 会快照并清除）
    if (msg.platformMsgId) {
      this.triggerMsgIds.set(scope.scopeKey, msg.platformMsgId);
    }

    // 短词打断检测（不清空队列，只 kill 当前进程，与 /stop 行为一致）
    const trimmedText = msg.contentText.trim().toLowerCase();
    if (INTERRUPT_WORDS.has(trimmedText) && this.chatSessions.has(scope.scopeKey)) {
      persistIncomingMessage("processing");
      this.log.info("interrupt word detected", { chatId, scopeKey: scope.scopeKey, word: trimmedText });
      const activeRun = this.runtimeState.getActiveRunForScope(scope.scopeKey);
      const hasActiveRun = !!activeRun;
      if (activeRun) {
        this.markRuntimeRun(activeRun.runId, "stopped");
      }
      if (hasActiveRun && this.chatSessions.has(scope.scopeKey)) {
        this.cancelChat(scope.scopeKey, chatId).catch(() => {});
      }
      // 与 /stop 一致：abort 队列信号，保证 agent 进程杀不掉时 run 也能退出、busy 恢复
      if (hasActiveRun || this.queue.isBusy(scope.scopeKey)) {
        this.queue.cancel(scope.scopeKey);
      }
      const interruptText = "好的，已停止。";
      this.sendPreferringReply(
        msg.chatPlatformId,
        "interrupt",
        (replyToMsgId) => this.transport.sendReply(
          msg.chatPlatformId,
          interruptText,
          replyToMsgId,
          { replyInThread: scope.strict },
        ),
        () => this.transport.sendText(msg.chatPlatformId, interruptText),
        msg.platformMsgId,
        { allowChatFallback: !scope.strict, replyInThread: scope.strict },
      ).then((pmid) => {
        this.storeBotResponse(chatId, interruptText, pmid, "text", scope.threadId);
      }).catch(() => {});
      if (inboxId != null && claimToken) {
        this.transport.markInboundTerminal?.(inboxId, claimToken, "completed");
      }
      return;
    }

    // 内置命令拦截：/xxx 开头的消息先匹配内置命令，命中则不传给 agent。
    // 群聊必须先 at，内容常是 `@U3(NiuBot) /help`，先剥掉开头的 at 再认。
    const commandText = extractBuiltinCommandText(msg.contentText.trim());
    if (this.isBuiltinCommand(commandText, userId)) {
      persistIncomingMessage("processing");
      this.handleBuiltinCommand(
        commandText,
        userId,
        chatId,
        msg.chatPlatformId,
        msg.chatType,
        msg.platformMsgId,
        scope.threadId,
        scope.scopeKey,
      );
      if (inboxId != null && claimToken) {
        this.transport.markInboundTerminal?.(inboxId, claimToken, "completed");
      }
      return;
    }

    const incomingMsgId = persistIncomingMessage("queued");

    // Reaction 策略：收到即二选一；pending 先 Pin，非 pending 先 Get；pending 开始处理后再补 Get
    const isPending = this.queue.push({
      chatId,
      scopeKey: scope.scopeKey,
      threadId: scope.threadId,
      strict: scope.strict,
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
      scopeKey: scope.scopeKey,
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
  private storeBotResponse(
    chatId: string,
    text: string,
    platformMsgId?: string,
    contentType?: string,
    threadId?: string,
  ): void {
    if (!this.botUserId) return;
    storeMessage(this.db, {
      chatId,
      senderId: this.botUserId,
      sessionId: this.chatSessions.get(buildScopeKey(chatId, threadId))?.sessionId
        ?? this.chatSessions.get(chatId)?.sessionId,
      role: "assistant",
      contentText: text,
      contentType,
      platform: this.botIdentity.platform,
      platformMsgId,
      threadId,
      agentSeen: true,
    });
  }

  /** Store message without triggering agent (for group chat non-targeted messages) */
  private storeMessageOnly(msg: NormalizedMessage, platform: string): number {
    const userId = ensureUser(this.db, platform, msg.senderPlatformId, msg.senderName, "bot_sender");
    if (msg.senderIsBot) setUserIsBot(this.db, userId);
    const chatId = ensureChat(this.db, platform, msg.chatPlatformId, msg.chatType, msg.chatName);
    this.noteHumanInbound(chatId, msg.senderIsBot);

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
      threadId: msg.threadId,
      platformTs: platformTsStr,
      platformRaw: JSON.stringify(msg.raw),
    });

    // Collect user info from mentions + replace @name with @shortLabel
    if (msg.mentions) {
      for (const m of msg.mentions) {
        if (m.platformUserId) {
          const mentionUserId = ensureUser(this.db, platform, m.platformUserId, m.name || undefined, mentionMarksApp(m) ? "bot_info" : "mention");
          if (mentionMarksApp(m)) setUserIsBot(this.db, mentionUserId);
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

  /** 被回复的那条：`<quoted speaker="...">正文</quoted>`，找不到则空。 */
  private buildReplyQuoted(platform: string, parentPlatformMsgId: string): string {
    const dbMsg = getMessageByPlatformId(this.db, platform, parentPlatformMsgId);
    if (dbMsg?.contentText) {
      const label = getUserShortLabel(this.db, dbMsg.senderId);
      return renderQuotedText(label, dbMsg.contentText);
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
  private handleBuiltinCommand(
    text: string,
    userId: string,
    chatId: string,
    platformChatId: string,
    chatType: string,
    msgId?: string,
    threadId?: string,
    scopeKey?: string,
  ): boolean {
    if (!this.isBuiltinCommand(text, userId)) return false;
    const effectiveScopeKey = scopeKey ?? chatId;

    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const isAdmin = this.adminRoles.has(userId);

    if (isTimezoneChangeUtterance(text)) {
      if (!isAdmin) {
        this.replyText(chatId, platformChatId, msgId, "/tz 仅管理员可用。");
        return true;
      }
      this.handleTimezoneCommand([text], chatId, platformChatId, msgId);
      return true;
    }

    // 1. 内置命令
    switch (cmd) {
      case "/restart": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "restart 仅管理员可用。");
          return true;
        }
        this.log.info("builtin command: restart", { userId });
        this.triggerRestart({
          chatId,
          platformChatId,
          scopeKey: effectiveScopeKey,
          threadId,
          replyToMsgId: msgId,
        });
        return true;
      }
      case "/update": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "/update 仅管理员可用。");
          return true;
        }
        this.log.info("builtin command: update", { userId });
        if (parts[1] === "auto") {
          this.handleAutoUpdateCommand(parts.slice(2), chatId, platformChatId, msgId, threadId);
          return true;
        }
        if (parts.length === 1 || !parts[1]) {
          // /update 不带参数：版本卡片里附带自动升级状态/帮助，单卡片展示
          this.handleUpdate(chatId, platformChatId, msgId, false, true, threadId, effectiveScopeKey);
          return true;
        }
        this.handleUpdate(chatId, platformChatId, msgId, isUpdateConfirmedArg(parts[1]), false, threadId, effectiveScopeKey);
        return true;
      }
      case "/service": {
        this.log.info("builtin command: service", { userId });
        this.sendStatus(chatId, platformChatId, msgId, effectiveScopeKey, userId);
        return true;
      }
      case "/awake": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "/awake 仅管理员可用。");
          return true;
        }
        this.handleAwakeCommand(parts.slice(1), chatId, platformChatId, msgId, threadId);
        return true;
      }
      case "/new": {
        this.log.info("builtin command: reset-session", { userId, cmd, chatId });
        this.startSessionTransition(effectiveScopeKey, () => this.resetSession(effectiveScopeKey, chatId, platformChatId, msgId, threadId));
        return true;
      }
      case "/goal": {
        this.handleGoalCommand(parts.slice(1), userId, chatId, effectiveScopeKey, platformChatId, msgId);
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
          threadId,
          effectiveScopeKey,
        );
        return true;
      }
      case "/agent": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "/agent 仅管理员可用。");
          return true;
        }
        void this.handleAgentCommand(parts.slice(1), chatId, platformChatId, msgId, effectiveScopeKey, threadId, userId).catch((err) => {
          this.log.error("agent command failed", { error: String(err) });
          this.sendAgentCard(chatId, platformChatId, msgId, "Agent|red", `处理 /agent 失败: ${String(err)}`, threadId);
        });
        return true;
      }
      case "/model": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "/model 仅管理员可用。");
          return true;
        }
        void this.handleModelCommand(parts.slice(1), chatId, platformChatId, msgId, effectiveScopeKey, userId).catch((err) => {
          this.log.error("model command failed", { error: String(err) });
          this.sendAgentCard(chatId, platformChatId, msgId, "Model|red", `处理 /model 失败: ${String(err)}`, threadId);
        });
        return true;
      }
      case "/effort": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "/effort 仅管理员可用。");
          return true;
        }
        this.handleEffortCommand(parts.slice(1), chatId, platformChatId, msgId, effectiveScopeKey, userId);
        return true;
      }
      case "/timezone":
      case "/tz": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "/timezone 仅管理员可用。");
          return true;
        }
        this.handleTimezoneCommand(parts.slice(1), chatId, platformChatId, msgId, threadId);
        return true;
      }
      case "/autoupdate": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "/autoupdate 仅管理员可用。");
          return true;
        }
        // 兼容别名：/update auto 是正式入口，/autoupdate 保留为同义命令
        this.handleAutoUpdateCommand(parts.slice(1), chatId, platformChatId, msgId, threadId);
        return true;
      }
      case "/admin": {
        if (!isAdmin) {
          this.replyText(chatId, platformChatId, msgId, "/admin 仅管理员可用。");
          return true;
        }
        this.handleAdminCommand(parts.slice(1), userId, chatId, platformChatId, msgId, threadId);
        return true;
      }
      case "/help": {
        this.log.info("builtin command: help", { userId });
        this.sendHelpCard(chatId, platformChatId, msgId, isAdmin, threadId);
        return true;
      }
      case "/stop": {
        this.log.info("builtin command: stop", { userId, chatId });
        const activeRun = this.runtimeState.getActiveRunForScope(effectiveScopeKey);
        const hasActiveRun = !!activeRun;
        const pendingBefore = this.queue.pendingCount(effectiveScopeKey);
        if (activeRun) {
          this.markRuntimeRun(activeRun.runId, "stopped");
        }
        if (hasActiveRun && this.chatSessions.has(effectiveScopeKey)) {
          this.cancelChat(effectiveScopeKey, chatId).catch(() => {});
        }
        if (hasActiveRun || this.queue.isBusy(effectiveScopeKey)) {
          this.queue.cancel(effectiveScopeKey);
        }
        const dropped = this.queue.drain(effectiveScopeKey);
        this.log.info("stop command applied", {
          userId,
          chatId,
          scopeKey: effectiveScopeKey,
          activeRunId: activeRun?.runId ?? null,
          activeRunStage: activeRun?.stage ?? null,
          pendingBefore,
          dropped,
        });
        if (hasActiveRun) {
          if (dropped > 0) {
            this.replyText(chatId, platformChatId, msgId, `已停止当前任务，并清空 ${dropped} 条排队消息。`, threadId);
          } else {
            this.replyText(chatId, platformChatId, msgId, "已停止当前任务。", threadId);
          }
        } else {
          if (dropped > 0) {
            this.replyText(chatId, platformChatId, msgId, `当前没有正在执行的任务，已清空 ${dropped} 条排队消息。`, threadId);
          } else {
            this.replyText(chatId, platformChatId, msgId, "当前没有正在执行的任务。", threadId);
          }
        }
        return true;
      }
      case "/clear": {
        this.log.info("builtin command: clear", { userId, chatId });
        const dropped = this.queue.drain(effectiveScopeKey);
        if (dropped > 0) {
          this.replyText(chatId, platformChatId, msgId, `已清空 ${dropped} 条排队消息。`, threadId);
        } else {
          this.replyText(chatId, platformChatId, msgId, "队列是空的，没啥可清的。", threadId);
        }
        return true;
      }
      case "/flush": {
        this.log.info("builtin command: flush", { userId, chatId });
        const pending = this.queue.pendingCount(effectiveScopeKey);
        const activeRun = this.runtimeState.getActiveRunForScope(effectiveScopeKey);
        if (pending === 0) {
          this.replyText(chatId, platformChatId, msgId, "队列是空的，没有需要 flush 的消息。", threadId);
        } else if (activeRun) {
          this.markRuntimeRun(activeRun.runId, "stopped");
          if (this.chatSessions.has(effectiveScopeKey)) {
            this.cancelChat(effectiveScopeKey, chatId).catch(() => {});
          }
          this.queue.cancel(effectiveScopeKey);
          this.replyText(chatId, platformChatId, msgId, `中断当前回复，合并处理队列中的 ${pending} 条消息。`, threadId);
        } else {
          this.replyText(chatId, platformChatId, msgId, `队列中有 ${pending} 条消息，即将处理。`, threadId);
        }
        this.log.info("flush command applied", {
          userId,
          chatId,
          scopeKey: effectiveScopeKey,
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
          this.stopAllTasks(chatId, platformChatId, msgId, threadId, effectiveScopeKey);
          return true;
        }
        const taskPrompt = parts.slice(1).join(" ").trim();
        if (!taskPrompt) {
          this.replyText(chatId, platformChatId, msgId, "用法：/task <任务描述>\n子命令：/task stop", threadId);
          return true;
        }
        this.log.info("builtin command: task", { userId, chatId, promptLength: taskPrompt.length });
        this.replyText(chatId, platformChatId, msgId, "任务已提交，完成后会发送结果。", threadId);
        this.processIndependentSession(
          chatId,
          userId,
          taskPrompt,
          taskPrompt.slice(0, 40),
          "task",
          undefined,
          { scopeKey: effectiveScopeKey, threadId, replyToMsgId: msgId },
        ).catch((err) => {
          this.log.error("task execution failed", { chatId, error: String(err) });
        });
        return true;
      }
      case "/status": {
        this.log.info("builtin command: status", { userId, chatId });
        this.sendRunningList(chatId, effectiveScopeKey, platformChatId, msgId, threadId);
        return true;
      }
      case "/history": {
        this.log.info("builtin command: history", { userId, chatId });
        this.sendShellHistory(chatId, platformChatId, msgId, threadId);
        return true;
      }
    }

    // 2. 管理员 shell 命令。Windows PowerShell cmdlet/alias 不是 PATH 中的独立文件，
    // 因此 Windows 上直接交给 PowerShell；//xxx 仍强制透传给 Agent。
    if (shouldHandleAdminShellCommand(text, isAdmin, { commandExists: commandExistsSync })) {
      this.tryShellCommand(
        text.slice(1),
        userId,
        chatId,
        chatType,
        platformChatId,
        msgId,
        threadId,
        effectiveScopeKey,
      );
      return true;
    }

    // 3. 未识别的 / 命令，交给 agent 处理
    return false;
  }

  private isBuiltinCommand(text: string, userId: string): boolean {
    if (isTimezoneChangeUtterance(text)) return true;
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
    // /tz：能认出的时区本地切换；认不出的放行给 Agent 做语义解析
    if (firstToken === "/tz" || firstToken === "/timezone") {
      return timezoneCommandIsResolved(text.trim().split(/\s+/).slice(1));
    }
    if (firstToken && BUILTIN_COMMANDS.has(firstToken)) return true;
    return shouldHandleAdminShellCommand(text, this.adminRoles.has(userId), {
      commandExists: commandExistsSync,
    });
  }

  private handleScheduleBuiltinCommand(
    mode: "loop" | "cron",
    args: string[],
    userId: string,
    chatId: string,
    chatType: "p2p" | "group",
    platformChatId: string,
    msgId?: string,
    threadId?: string,
    scopeKey?: string,
  ): void {
    const subcommand = args[0]?.toLowerCase() ?? "list";
    if (subcommand === "list" || subcommand === "ls") {
      this.sendScheduleBuiltinList(mode, chatId, platformChatId, msgId, scopeKey);
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
        if (job.status === "running") this.cancelActiveLoopRun(id, scopeKey ?? chatId);
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
    scopeKey?: string,
  ): void {
    const threadId = scopeKey ? parseScopeKey(scopeKey).threadId : undefined;
    const lines: string[] = [];
    if (mode === "loop") {
      for (const job of listLoopJobs(this.db, chatId, threadId)) {
        const progress = job.maxTimes ? `${job.runCount}/${job.maxTimes}` : `${job.runCount} 次`;
        lines.push(`· loop:${job.id} · ${job.status} · 每 ${formatLoopInterval(job.intervalSeconds)} · ${progress}`);
        lines.push(`  ${escapeLarkMarkdownText(job.prompt.replace(/\s+/g, " ").slice(0, 120))}`);
      }
    } else {
      for (const job of listCronJobs(this.db, chatId, threadId)) {
        const schedule = job.cronExpr
          ? describeCronSchedule(job.cronExpr, null, job.timezone)
          : formatLocalDateTimeWithTZ(job.runAt!);
        const progress = job.maxTimes ? ` · ${job.runCount}/${job.maxTimes}` : job.runCount ? ` · 已执行 ${job.runCount} 次` : "";
        lines.push(`· cron:${job.id} · ${job.status} · ${schedule}${progress}`);
        lines.push(`  ${escapeLarkMarkdownText(job.prompt.replace(/\s+/g, " ").slice(0, 120))}`);
      }
    }
    if (lines.length === 0) lines.push(`当前没有 ${mode === "loop" ? "Loop" : "Cron"} 任务。`);
    lines.push("", `创建：/${mode} <任务与时间>`, `删除：/${mode} del <id>`);
    const content = lines.join("\n");
    this.sendAgentCard(
      chatId,
      platformChatId,
      msgId,
      mode === "loop" ? "循环任务|turquoise" : "定时任务|turquoise",
      content,
      threadId,
    );
  }

  private async cancelRunningCronSessions(id: number): Promise<void> {
    const running = [...this.runningTasks.values()].filter(
      (task) => task.source === "cron" && task.cronJobId === id,
    );
    await Promise.all(running.map((task) => task.backend.cancelSession(task.agentSession).catch((err) => {
      this.log.warn("failed to stop cancelled Cron session", { id, error: String(err) });
    })));
  }

  private cancelActiveLoopRun(id: number, scopeKey: string): void {
    const active = this.activeLoopRuns.get(id);
    if (!active || active.scopeKey !== scopeKey) return;
    if (active.runId) this.markRuntimeRun(active.runId, "stopped");
    // 先 abort 当前 queue run，RunManager 会立即结束等待，聊天随后继续处理 pending。
    this.queue.cancel(scopeKey);
    const session = this.chatSessions.get(scopeKey);
    if (session) {
      void this.backendForSession(session).cancelSession(session.agentSession).catch((err) => {
        this.log.warn("failed to stop cancelled Loop session", { id, scopeKey, error: String(err) });
      });
    }
  }

  /** //xxx 表示强制透传给 agent，实际发送时去掉一个前缀 / */
  private normalizeUserTextForAgent(text: string): string {
    return text.startsWith("//") ? text.slice(1) : text;
  }

  /** 回复文本：有 msgId 时引用回复，否则直接发送，并存入 DB */
  private replyText(
    chatId: string,
    platformChatId: string,
    msgId: string | undefined,
    text: string,
    threadId?: string,
    replyInThread = false,
  ): void {
    const strict = replyInThread || Boolean(threadId) || this.isStrictTopicChat(chatId);
    if (!msgId && strict) {
      this.log.warn("strict topic reply skipped without reply anchor", {
        chatId,
        platformChatId,
        text,
      });
      return;
    }
    const sendPromise = msgId
      ? this.transport.sendReply(platformChatId, text, msgId, { replyInThread: strict })
      : this.transport.sendText(platformChatId, text);
    sendPromise.then((pmid) => {
      this.storeBotResponse(chatId, text, pmid, "text", threadId);
    }).catch(() => {});
  }

  /**
   * /list：列出所有运行中的会话（主 session + 独立 task），含最近日志。
   */
  private sendRunningList(
    chatId: string,
    scopeKey: string,
    platformChatId: string,
    msgId?: string,
    threadId?: string,
  ): void {
    const session = this.chatSessions.get(scopeKey);
    const cliAgent = this.backendForScope(scopeKey) as CliAgentBackend<any>;
    const sections: string[] = [];
    let count = 0;

    // 主会话 Runtime State
    const activeRun = this.runtimeState.getActiveRunForScope(scopeKey);
    if (activeRun) {
      count++;
      const elapsed = formatUptime(Date.now() - activeRun.startedAt);
      const agentSid = (session && typeof cliAgent.getAgentSessionId === "function")
        ? nativeSessionId(cliAgent.getAgentSessionId(session.agentSession.id), session.agentSession.id)
        : undefined;
      const statusLabel = activeRun.stage === "agent_running" || activeRun.stage === "sending_response"
        ? "处理中" : displayRunStage(activeRun.stage);

      const mainLines: string[] = [];
      mainLines.push(`**⚡ ${statusLabel}** · ${elapsed}`);
      const scopeModel = this.resolveScopeModels(scopeKey).model;
      if (scopeModel) {
        mainLines.push(`模型: ${scopeModel}`);
      }
      if (agentSid) {
        mainLines.push(`Session: ${agentSid}`);
      }
      mainLines.push(`本轮: ${activeRun.triggerMessageIds.length} 条消息 · 队列: ${this.queue.pendingCount(scopeKey)}`);
      sections.push(mainLines.join("\n"));

      const a = typeof cliAgent.getActivity === "function"
        ? (session ? cliAgent.getActivity(session.agentSession.id) : undefined)
        : undefined;
      if (a?.status === "running" && a.recentLines.length > 0) {
        const logBlock = a.recentLines.map((l) => l.replace(/`{3,}/g, "``").slice(0, ERROR_DISPLAY_MAX_LEN)).join("\n");
        sections.push(`\`\`\`\n${logBlock}\n\`\`\``);
      }
    } else {
      const latestRun = this.runtimeState.getRunsForScope(scopeKey).at(-1);
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
          threadId,
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
    const tasks = [...this.runningTasks.entries()].filter(([, t]) => (t.scopeKey ?? t.chatId) === scopeKey);
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

    const loopStatus = this.buildLoopStatusSection(chatId, scopeKey);
    if (loopStatus) {
      count += loopStatus.runningCount;
      sections.push(loopStatus.content);
    }

    if (count === 0 && sections.length === 0) {
      this.replyText(chatId, platformChatId, msgId, "当前没有正在执行的任务。", threadId);
      return;
    }

    const latestDataAt = this.getLatestAgentOutputAt(scopeKey, chatId);
    const latestDataAge = latestDataAt !== undefined
      ? formatRelativeAgeMs(latestDataAt)
      : "无";
    const content = [
      `**最新数据:** ${latestDataAge}`,
      ...sections,
    ].join("\n\n");
    const header = count > 0 ? `运行中 · ${count} 个任务|orange` : "Status|blue";
    this.sendBuiltinCard(platformChatId, chatId, header, content, msgId, threadId)
      .then((pmid) => { this.storeBotResponse(chatId, content, pmid, "text", threadId); })
      .catch((err) => this.log.error("running list card send failed", { chatId, scopeKey, error: String(err) }));
  }

  private buildLoopStatusSection(chatId: string, scopeKey: string): {
    content: string;
    runningCount: number;
  } | undefined {
    const jobs = listLoopJobs(this.db, chatId, parseScopeKey(scopeKey).threadId);
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

  private stopAllTasks(
    chatId: string,
    platformChatId: string,
    msgId?: string,
    threadId?: string,
    scopeKey?: string,
  ): void {
    const effectiveScopeKey = scopeKey ?? chatId;
    const tasks = [...this.runningTasks.entries()].filter(([, t]) =>
      (t.scopeKey ?? t.chatId) === effectiveScopeKey && t.source === "task");
    if (tasks.length === 0) {
      this.replyText(chatId, platformChatId, msgId, "当前没有运行中的 task。", threadId);
      return;
    }
    for (const [, t] of tasks) {
      t.backend.cancelSession(t.agentSession).catch(() => {});
    }
    this.replyText(chatId, platformChatId, msgId, `正在停止 ${tasks.length} 个 task。`, threadId);
  }

  private sendStatus(chatId: string, platformChatId: string, msgId?: string, scopeKey?: string, userId?: string): void {
    const engine = this.engineLifecycle?.getStatus();
    const uptimeStr = engine ? formatUptime(engine.uptimeMs) : "unknown";

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
      `**Version:** ${engine?.version ?? "unknown"}`,
      `**Env:** ${engine?.environment ?? "unknown"}`,
      `**Platform:** ${this.botIdentity.platform}`,
      `**Backend:** ${displayBackendType(this.resolveScopeBackendType(scopeKey ?? chatId, userId))}`,
      `**Model:** ${this.resolveScopeModels(scopeKey ?? chatId, undefined, userId).model ?? "default"}`,
      `**Timezone:** ${TZ}`,
      `**Uptime:** ${uptimeStr}`,
      `**Active sessions:** ${activeSessions}`,
      `**Cron jobs:** ${cronCount}`,
      `**Loop jobs:** ${loopCount}`,
      `**Path:** \`${engine?.runtimePath ?? "unknown"}\``,
      `**Working directory:** \`${this.workingDirectory}\``,
    ].join("\n");

    this.sendAgentCard(
      chatId,
      platformChatId,
      msgId,
      "服务|blue",
      content,
      parseScopeKey(scopeKey ?? chatId).threadId,
    );
  }

  /** /status：与 watchdog 一致，取 agent activity.lastActiveAt */
  private getLatestAgentOutputAt(scopeKey: string, chatId: string): number | undefined {
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

    const chatSession = this.chatSessions.get(scopeKey);
    if (chatSession) {
      considerSession(this.backendForSession(chatSession), chatSession.agentSession.id);
    }
    for (const [sessionId, task] of this.runningTasks) {
      if ((task.scopeKey ?? task.chatId) === scopeKey) {
        considerSession(task.backend, sessionId);
      }
    }

    return latest;
  }

  // ── 独立 Cron 执行 ────────────────────────────────────────────

  /** /goal：创建或查询 Goal（纯内存，重启即断）。 */
  /** /goal 内置命令：只处理查询（无参）。带参创建由 hybrid 翻译层转发给 Agent（nbt goal start）。 */
  private handleGoalCommand(
    args: string[],
    userId: string,
    chatId: string,
    scopeKey: string,
    platformChatId: string,
    msgId?: string,
  ): void {
    const existing = this.activeGoals.get(scopeKey);
    if (!existing) {
      this.replyText(chatId, platformChatId, msgId, "当前没有进行中的 Goal。");
      return;
    }
    const elapsed = formatUptime(Math.max(0, Date.now() - existing.startedAt));
    this.replyText(chatId, platformChatId, msgId,
      `**⚡ 当前 Goal**\n目标：${existing.objective.slice(0, 200)}\n轮次：${existing.turnCount} · 耗时：${elapsed}`);
  }

  /** nbt goal finish：Agent 显式结束请求（令牌 + Run 一致性校验；三条件结算在回合收尾时做）。 */
  async executeGoalFinishCommand(
    chatId: string,
    command: GoalFinishCommand,
    scheduleToken?: string,
    scope?: { scopeKey?: string; threadId?: string },
  ): Promise<{ output: string }> {
    const scopeKey = scope?.scopeKey ?? chatId;
    const goal = this.activeGoals.get(scopeKey);
    if (!goal) throw new Error("当前没有进行中的 Goal");
    if (goal.endedAt) throw new Error("Goal 已结束");
    const activeRun = this.runtimeState.getActiveRunForScope(scopeKey);
    if (!activeRun || activeRun.stage !== "agent_running") {
      throw new Error("Goal finish 必须在当前 Goal 的活动回合内执行");
    }
    // 绑定 Goal 的 Run：只有该 Goal 自己的回合（同一 run）能提交 finish，防过期进程结算
    if (goal.startRunId && activeRun.runId !== goal.startRunId) {
      throw new Error("Goal finish 必须来自该 Goal 的回合");
    }
    if (scheduleToken && scheduleToken !== this.chatScheduleTokens.get(scopeKey)) {
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
  async executeGoalStartCommand(
    chatId: string,
    objective: string,
    scheduleToken?: string,
    scope?: { scopeKey?: string; threadId?: string },
  ): Promise<{ output: string }> {
    const scopeKey = scope?.scopeKey ?? chatId;
    if (objective.length > GOAL_DEFAULTS.maxObjectiveLength) {
      throw new Error(`目标过长（上限 ${GOAL_DEFAULTS.maxObjectiveLength} 字符）`);
    }
    const existing = this.activeGoals.get(scopeKey);
    if (existing && !existing.endedAt) {
      throw new Error("已有进行中的 Goal");
    }
    if ([...this.activeGoals.values()].length >= GOAL_DEFAULTS.maxConcurrentGoals) {
      throw new Error("全局并发 Goal 已达上限");
    }
    const activeRun = this.runtimeState.getActiveRunForScope(scopeKey);
    if (!activeRun || activeRun.stage !== "agent_running") {
      throw new Error("nbt goal start 必须在当前 Agent 回合内调用");
    }
    if (scheduleToken && scheduleToken !== this.chatScheduleTokens.get(scopeKey)) {
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
    this.activeGoals.set(scopeKey, goal);
    this.log.info("goal started by agent", { chatId, scopeKey, objectiveLength: objective.length, runId: activeRun.runId });
    return { output: `goal started: ${objective.slice(0, 100)}` };
  }

  /**
   * nbt goal progress：中间轮静默记录进展（不发送 IM）。
   * content = 本次步骤（一两句话，保留最近 N 条）；status = 全局进展状态（覆盖式：任务整体进行到哪、还剩什么）。
   */
  async executeGoalProgressCommand(
    chatId: string,
    content: string,
    status?: string,
    scope?: { scopeKey?: string; threadId?: string },
  ): Promise<{ output: string }> {
    const scopeKey = scope?.scopeKey ?? chatId;
    const goal = this.activeGoals.get(scopeKey);
    if (!goal) throw new Error("当前没有进行中的 Goal");
    if (goal.endedAt) throw new Error("Goal 已结束");
    // 与 start/finish 同级：必须在当前 Goal 的活动回合内调用
    const activeRun = this.runtimeState.getActiveRunForScope(scopeKey);
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
  async executeWakeCommand(
    chatId: string,
    prompt: string,
    scope?: { scopeKey?: string; threadId?: string; replyToMsgId?: string },
  ): Promise<{ output: string }> {
    const scopeKey = scope?.scopeKey ?? chatId;
    const threadId = scope?.threadId;
    const replyToMsgId = scope?.replyToMsgId
      ?? (threadId ? this.latestThreadPlatformMsgId(chatId, threadId) : undefined);
    this.queue.push({
      chatId,
      scopeKey,
      threadId,
      replyToMsgId,
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
    scopeKey: string,
    goal: ActiveGoal,
    runId: string | undefined,
    signal?: AbortSignal,
    initialTurn?: RunAgentResult,
  ): Promise<void> {
    const threadId = parseScopeKey(scopeKey).threadId;
    const chatSession = await this.getOrCreateSession(scopeKey, chatId, threadId, undefined, signal);
    if (!chatSession) {
      this.log.error("goal run without active session", { chatId, runId: runId ?? null });
      this.finishGoal(chatId, goal, "failed", "会话不可用");
      this.cleanupGoal(chatId, scopeKey, goal, runId);
      return;
    }
    let consecutiveFailures = 0;

    // 初始回合（Agent 通过 nbt goal start 主动进入）：本轮已执行（turnCount 在 start 时置 1），直接处理其结果
    if (initialTurn) {
      const settled = await this.consumeGoalTurn(chatSession, chatId, scopeKey, goal, runId, initialTurn, signal);
      if (settled) {
        this.cleanupGoal(chatId, scopeKey, goal, runId);
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
          agent: this.backendForSession(chatSession),
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

      const settled = await this.consumeGoalTurn(chatSession, chatId, scopeKey, goal, runId, agentResult, signal);
      if (settled) break;
    }

    this.cleanupGoal(chatId, scopeKey, goal, runId);
  }

  /** 处理一轮 Goal 回合结果：停止/结算（交付）/未结束时落库统计。返回 true = Goal 已结束。 */
  private async consumeGoalTurn(
    chatSession: ChatSession,
    chatId: string,
    scopeKey: string,
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
      const activeRun = this.runtimeState.getActiveRunForScope(scopeKey);
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
      threadId: chatSession.threadId,
    });
    const backend = this.backendForSession(chatSession);
    const cumulativeBytes = backend.getCumulativeBytes?.(chatSession.agentSession.id) ?? 0;
    const agentSessionId = this.resolveNativeAgentSessionId(
      backend.getAgentSessionId?.(chatSession.agentSession.id),
      chatSession.sessionId,
      chatSession.agentSession.id,
    );
    this.db.prepare(`
      UPDATE sessions
      SET message_count = (SELECT COUNT(*) FROM messages WHERE session_key = ?),
          turn_count = turn_count + 1,
          cumulative_bytes = ?,
          last_active_at = datetime('now'),
          end_msg_id = ?,
          agent_session_id = ?,
          backend_type = ?
      WHERE id = ?
    `).run(
      chatSession.sessionId,
      cumulativeBytes,
      replyMsgId,
      agentSessionId,
      chatSession.backendType ?? this.resolveScopeBackendType(buildScopeKey(chatId, chatSession.threadId)),
      chatSession.sessionId,
    );
    return replyMsgId;
  }

  /** Goal 结束清理：状态与 Run 收尾（队列释放由 process 返回后 queue 接管）。 */
  private cleanupGoal(
    chatId: string,
    scopeKey: string,
    goal: ActiveGoal,
    runId: string | undefined,
  ): void {
    this.activeGoals.delete(scopeKey);
    this.activeScheduleAgentCommands.delete(scopeKey);
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
    const text = stripInternalTags(response.text);
    const elapsedMs = Date.now() - goal.startedAt;
    // footer 与常规交付一致：session 短 ID + session 累计轮次 + context + model
    // （goal 自身轮次在 header 中展示，不参与 footer 的 #N）
    const agentSessionId = this.backendForSession(chatSession).getAgentSessionId?.(chatSession.agentSession.id);
    const sessionStats = this.db.prepare(
      "SELECT turn_count FROM sessions WHERE id = ?",
    ).get(chatSession.sessionId) as { turn_count: number } | undefined;
    const result = await this.sendPreparedFinalResponse(chatSession.platformChatId, {
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
      replyInThread: chatSession.strict,
      allowChatFallback: !chatSession.strict,
      signal,
    });
    if (!result.ok) {
      this.log.warn("goal final response delivery failed", { error: result.error, methodsTried: result.methodsTried });
    }
    return result.ok;
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
    threadId?: string,
  ): Promise<void> {
    const cronRun = cronJobId !== undefined && claimToken !== undefined ? { cronJobId, claimToken } : undefined;
    const cronJob = cronJobId !== undefined ? getCronJob(this.db, cronJobId) : undefined;
    return this.processIndependentSession(
      chatId,
      userId,
      prompt,
      description,
      "cron",
      cronRun,
      {
        scopeKey: threadId ? buildScopeKey(chatId, threadId) : chatId,
        threadId,
        replyToMsgId: cronJob?.replyToMsgId ?? undefined,
      },
    );
  }

  async reportCronJobFailure(
    chatId: string,
    description: string,
    error: string,
    paused: boolean,
    threadId?: string,
    replyToMsgId?: string,
  ): Promise<void> {
    let platformChatId = this.platformChatIds.get(chatId);
    if (!platformChatId) {
      const row = this.db.prepare("SELECT platform_id FROM chats WHERE id = ?").get(chatId) as
        | { platform_id: string }
        | undefined;
      platformChatId = row?.platform_id;
    }
    if (!platformChatId) return;
    const strict = this.isStrictTopicChat(chatId);
    if (strict && !replyToMsgId) {
      this.log.warn("cron failure skipped for strict topic without reply anchor", {
        chatId,
        threadId,
        description,
      });
      return;
    }
    const detail = stripInternalTags(error).trim().slice(0, ERROR_DISPLAY_MAX_LEN);
    const content = paused
      ? `定时任务连续失败 ${CRON_FAILURE_LIMIT} 次，已暂停。\n\n${detail || "未知错误"}`
      : `定时任务执行失败，后续会按计划重试。\n\n${detail || "未知错误"}`;
    const platformMsgId = await this.transport.sendCard(
      platformChatId,
      `⏰ ${description || "定时任务"}|${paused ? "red" : "orange"}`,
      content,
      undefined,
      replyToMsgId,
      { replyInThread: strict },
    );
    this.storeBotResponse(chatId, content, platformMsgId, "text", threadId);
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
    if (job.creatorUserId) this.chatUserIds.set(job.chatId, job.creatorUserId);
    this.queue.enqueueLoop(
      job.chatId,
      job.id,
      job.threadId ?? undefined,
      job.replyToMsgId ?? undefined,
    );
    this.log.info("loop job dispatched", {
      chatId: job.chatId,
      scopeKey: job.threadId ? buildScopeKey(job.chatId, job.threadId) : job.chatId,
      loopJobId: job.id,
    });
  }

  /** 进程恢复：用户主 session 懒加载，有人说话 / Loop / wake 时再 attach。 */
  async recover(): Promise<void> {
    const activeCount = this.db.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE status = 'active' AND source = 'user'",
    ).get() as { count: number } | undefined;
    this.log.info("lazy session recovery: active user sessions kept unattached", {
      count: activeCount?.count ?? 0,
      eagerAttach: false,
    });
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
      "如果判定不必再循环，用 nbt schedule cancel loop:<id> 结束这个 Loop，并在回复里说明为什么停。" +
      "不要复述或展示 loop-continuation 标签、内部字段和本段说明。";
  }

  private async processIndependentSession(
    chatId: string, userId: string, prompt: string, description: string,
    source: "cron" | "task",
    cronRun?: { cronJobId: number; claimToken: string },
    scope?: { scopeKey?: string; threadId?: string; replyToMsgId?: string },
  ): Promise<void> {
    const threadId = scope?.threadId;
    const scopeKey = scope?.scopeKey ?? chatId;
    const strict = this.isStrictTopicChat(chatId);
    // 从入口开始跟踪完整生命周期（含清理），优雅关闭只有在全部收尾后才放行 DB。
    this.independentRunCount += 1;
    try {
    const sessionBackendType = this.resolveScopeBackendType(scopeKey, userId);
    const sessionBackend = await this.ensureBackend(sessionBackendType);
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

    // 独立任务只注入可见任务索引，不自动带入执行时最新聊天内容。
    // 这样 Cron 的行为只由创建时保存的 prompt 决定，不会被后续群聊消息改变。
    const normalContext = buildActiveTaskContext(this.workingDirectory, chatType, sessionUserId);

    if (cronRun && !this.isCronClaimCurrent(cronRun.cronJobId, cronRun.claimToken)) {
      throw new Error(`cron:${cronRun.cronJobId} 已取消或运行令牌失效`);
    }

    // Create independent agent session
    const cronModels = this.resolveScopeModels(scopeKey, sessionBackendType, userId);
    const agentSession = await this.createAgentSession({
      workingDirectory: this.workingDirectory,
      reasoningEffort: cronModels.effort,
      importantContext: stableContext || undefined,
      userId: sessionUserId,
      chatId,
      scopeKey,
      threadId,
      chatType,
      dbPath: this.dbPath,
      botId: this.botIdentity.platformBotId,
      botName: this.botIdentity.name,
      platform: this.botIdentity.platform,
      model: cronModels.model,
      isAdmin,
      botProfilePath: this.stableContextOptions.botProfilePath,
    }, sessionBackend);

    // Create session record
    const sessionId = randomUUID().slice(0, 8);
    this.db.prepare(`
      INSERT INTO sessions (id, chat_id, user_id, source, status, thread_id, started_at, last_active_at, backend_type)
      VALUES (?, ?, ?, ?, 'active', ?, datetime('now'), datetime('now'), ?)
    `).run(sessionId, chatId, userId, source, threadId ?? null, sessionBackendType);

    // 独立任务的 prompt 只属于 session transcript，不是平台收到的用户消息。
    storeMessage(this.db, {
      chatId,
      senderId: this.botUserId!,
      sessionId,
      role: "user",
      contentText: prompt,
      contentType: "internal_prompt",
      platform: this.botIdentity.platform,
      threadId,
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
      chatId, scopeKey, description, startedAt: Date.now(), source,
      replyToMsgId: scope?.replyToMsgId,
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

      const agentSessionId = nativeSessionId(
        sessionBackend.getAgentSessionId?.(agentSession.id),
        agentSession.id,
      ) ?? null;

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
      const sendResult = await this.sendPreparedFinalResponse(platformChatId, {
        header,
        content,
        footer,
        replyToMsgId: scope?.replyToMsgId,
        replyInThread: strict,
        allowChatFallback: !strict,
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
                agent_session_id = ?, backend_type = ?
            WHERE id = ?
          `).run(
            archivedAt,
            this.resolveNativeAgentSessionId(
              sessionBackend.getAgentSessionId?.(agentSession.id),
              sessionId,
              agentSession.id,
            ),
            sessionBackendType,
            sessionId,
          );
        } catch (archiveErr) {
          const failedStatus = archiveErr instanceof AgentSessionNotStartedError ? "discarded" : "archive_failed";
          try {
            this.db.prepare(`
              UPDATE sessions SET status = ?, ended_at = ?, last_active_at = datetime('now'),
                  agent_session_id = ?, backend_type = ?
              WHERE id = ?
            `).run(
              failedStatus,
              archivedAt,
              this.resolveNativeAgentSessionId(
                sessionBackend.getAgentSessionId?.(agentSession.id),
                sessionId,
                agentSession.id,
              ),
              sessionBackendType,
              sessionId,
            );
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
  private async resetSession(
    scopeKey: string,
    chatId: string,
    platformChatId: string,
    msgId?: string,
    threadId?: string,
  ): Promise<void> {
    await this.stopActiveRunForSessionTransition(scopeKey, chatId);
    await this.waitForSessionCreation(scopeKey);
    await this.archiveSession(scopeKey, chatId)
      .then((status) => {
        const text = status === false
          ? "当前没有进行中的会话；下一条消息会新建会话。"
          : status === "archive_failed"
            ? "已开始新会话，当前上下文已清空；旧会话记录归档失败。"
            : "已开始新会话，当前上下文已清空。";
        this.replyText(chatId, platformChatId, msgId, text, threadId);
      })
      .catch((err) => {
        this.log.error("reset session failed", { chatId, error: String(err) });
        this.replyText(chatId, platformChatId, msgId, `新建会话失败: ${String(err)}`, threadId);
      });
  }

  private startSessionTransition(scopeKey: string, task: () => Promise<void>): void {
    if (this.sessionTransitionLocks.has(scopeKey)) return;

    const transitionPromise = task()
      .finally(() => {
        if (this.sessionTransitionLocks.get(scopeKey) === transitionPromise) {
          this.sessionTransitionLocks.delete(scopeKey);
        }
        if (!this.globalSessionTransition) this.drainPendingTransitionMessages(scopeKey);
      });

    this.sessionTransitionLocks.set(scopeKey, transitionPromise);
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

  private async stopActiveRunForSessionTransition(scopeKey: string, chatId?: string): Promise<void> {
    const activeRun = this.runtimeState.getActiveRunForScope(scopeKey);
    const shouldCancelAgent = !!activeRun && !isTerminalRunStage(activeRun.stage);
    if (shouldCancelAgent) this.markRuntimeRun(activeRun.runId, "stopped");
    if (activeRun || this.queue.isBusy(scopeKey)) this.queue.cancel(scopeKey);
    const session = this.chatSessions.get(scopeKey);
    if (session && shouldCancelAgent) {
      await this.backendForSession(session).cancelSession(session.agentSession).catch((err) => {
        this.log.warn("failed to cancel session before transition", { chatId, scopeKey, error: String(err) });
      });
    }
  }

  private async waitForSessionCreation(scopeKey: string): Promise<void> {
    const creation = this.sessionCreations.get(scopeKey);
    if (creation) await creation.catch((err) => {
      this.log.warn("session creation failed during transition", { scopeKey, error: String(err) });
    });
  }

  private enqueuePendingTransitionMessage(
    scopeKey: string,
    msg: NormalizedMessage,
    inboxId?: number,
    claimToken?: string,
    recoveredMessageId?: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const pending = this.pendingTransitionMessages.get(scopeKey) ?? [];
      pending.push({ msg, inboxId, claimToken, recoveredMessageId, resolve, reject });
      this.pendingTransitionMessages.set(scopeKey, pending);
      this.markQueuedMessage(msg.chatPlatformId, msg.platformMsgId);
    });
  }

  private drainPendingTransitionMessages(scopeKey: string): void {
    const pending = this.pendingTransitionMessages.get(scopeKey);
    if (!pending || pending.length === 0) return;

    this.pendingTransitionMessages.delete(scopeKey);
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
  private handleAdminCommand(args: string[], userId: string, chatId: string, platformChatId: string, msgId?: string, threadId?: string): void {
    const sub = args[0]?.toLowerCase();

    if (!sub || sub === "list") {
      const admins = getAdminUserIds(this.db);
      if (admins.length === 0) {
        this.replyText(chatId, platformChatId, msgId, "当前没有管理员。", threadId);
        return;
      }
      const lines = admins.map(({ id, role }) => {
        const label = getUserShortLabel(this.db, id);
        return role === "owner" ? `- ${label} (owner)` : `- ${label}`;
      });
      this.replyText(chatId, platformChatId, msgId, `管理员列表：\n${lines.join("\n")}`, threadId);
      return;
    }

    if (sub === "add" || sub === "remove") {
      // Only owner can add/remove
      if (!this.isOwner(userId)) {
        this.replyText(chatId, platformChatId, msgId, "只有 owner 可以管理管理员。", threadId);
        return;
      }

      const rest = args.slice(1).join(" ");
      const match = rest.match(/@(u\d+)/i);
      if (!match) {
        this.replyText(chatId, platformChatId, msgId, `用法：/admin ${sub} @某人`, threadId);
        return;
      }
      const targetUserId = match[1].toLowerCase();

      const userRow = this.db.prepare("SELECT id, name FROM users WHERE id = ?").get(targetUserId) as { id: string; name: string | null } | undefined;
      if (!userRow) {
        this.replyText(chatId, platformChatId, msgId, `用户 ${targetUserId} 不存在。`, threadId);
        return;
      }

      const label = getUserShortLabel(this.db, targetUserId);

      if (sub === "add") {
        if (this.adminRoles.has(targetUserId)) {
          this.replyText(chatId, platformChatId, msgId, `${label} 已经是管理员了。`, threadId);
          return;
        }
        this.setAdminRole(targetUserId, "admin", "manual");
        this.replyText(chatId, platformChatId, msgId, `已添加 ${label} 为管理员。`, threadId);
      } else {
        if (!this.adminRoles.has(targetUserId)) {
          this.replyText(chatId, platformChatId, msgId, `${label} 不是管理员。`, threadId);
          return;
        }
        if (this.isOwner(targetUserId)) {
          this.replyText(chatId, platformChatId, msgId, `${label} 是 owner，不能被移除。`, threadId);
          return;
        }
        this.removeAdmin(targetUserId);
        this.replyText(chatId, platformChatId, msgId, `已移除 ${label} 的管理员权限。`, threadId);
      }
      return;
    }

    this.replyText(chatId, platformChatId, msgId, "用法：/admin [list|add|remove] [@某人]", threadId);
  }

  /**
   * /agent 命令：查看或切换当前对话的 agent backend。
   * 私聊写默认，群/话题写覆盖。没覆盖的跟着私聊默认走。
   */
  private async handleAgentCommand(
    args: string[],
    chatId: string,
    platformChatId: string,
    msgId?: string,
    scopeKey?: string,
    threadId?: string,
    userId?: string,
  ): Promise<void> {
    const effectiveScopeKey = scopeKey ?? chatId;
    const replyThreadId = threadId ?? parseScopeKey(effectiveScopeKey).threadId;
    const currentBackend = this.resolveScopeBackendType(effectiveScopeKey, userId);
    let capabilities: BackendCapability[];
    try {
      capabilities = await this.getBackendCapabilities();
    } catch (err) {
      this.log.error("failed to refresh backend capabilities", { error: String(err) });
      this.sendAgentCard(chatId, platformChatId, msgId, "Agent|red", `读取 backend 状态失败: ${String(err)}`, replyThreadId);
      return;
    }
    if (args.length === 0) {
      const currentModel = this.resolveScopeModels(effectiveScopeKey, currentBackend, userId).model ?? "default";
      const lines: string[] = [
        `**Agent:** ${currentBackend}`,
        `**Model:** ${currentModel}`,
        "",
      ];
      lines.push("**Agent 状态:**");
      for (let i = 0; i < capabilities.length; i++) {
        const capability = capabilities[i]!;
        const current = capability.backend === currentBackend ? "  ✓ 当前" : "";
        const status = capability.selectable
          ? `可用${capability.version ? ` · ${capability.version}` : ""}`
          : `不可用 · ${capability.reason ?? "当前平台或安装状态不支持"}`;
        lines.push(`  ${i + 1}. ${capability.backend} — ${status}${current}`);
      }
      lines.push("", "`/agent <名字或编号>` 切换");
      this.sendAgentCard(chatId, platformChatId, msgId, "Agent|blue", lines.join("\n"), replyThreadId);
      return;
    }

    if (args.length === 1 && (args[0] === "reset" || args[0] === "default")) {
      this.resetScopeAgentConfig(effectiveScopeKey, chatId, platformChatId, msgId, replyThreadId, userId);
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
      this.sendAgentCard(chatId, platformChatId, msgId, "Agent|orange", content, replyThreadId);
      return;
    }

    if (target === currentBackend) {
      if (!this.hasOwnScopeConfig(effectiveScopeKey)) {
        const current = this.resolveScopeConfig(effectiveScopeKey, userId);
        this.persistScopeConfig(effectiveScopeKey, current);
        const pinNote = this.isP2pScope(effectiveScopeKey)
          ? "这是你的默认，没单独切过的群和话题会跟着走。"
          : "只影响当前对话。";
        this.sendAgentCard(
          chatId,
          platformChatId,
          msgId,
          "Agent|green",
          `已固定为 **${displayBackendType(target)}**。\n${pinNote}`,
          replyThreadId,
        );
        return;
      }
      this.sendAgentCard(chatId, platformChatId, msgId, "Agent|green", `已经是 **${displayBackendType(target)}**，无需切换。`, replyThreadId);
      return;
    }

    if (!this.backendResolver) {
      this.sendAgentCard(chatId, platformChatId, msgId, "Agent|orange", "backend resolver 未配置，无法切换。", replyThreadId);
      return;
    }

    this.log.info("switching agent backend", {
      from: currentBackend,
      to: target,
      scopeKey: effectiveScopeKey,
    });

    try {
      // Validate and start the target before stopping work or archiving this scope.
      await this.ensureBackend(target);
    } catch (err) {
      this.log.error("failed to switch agent backend", { error: String(err), scopeKey: effectiveScopeKey });
      this.sendAgentCard(chatId, platformChatId, msgId, "Agent|red", `切换失败: ${String(err)}`, replyThreadId);
      return;
    }

    this.startSessionTransition(effectiveScopeKey, async () => {
      try {
        await this.stopActiveRunForSessionTransition(effectiveScopeKey, chatId);
        await this.waitForSessionCreation(effectiveScopeKey);
        await this.archiveSession(effectiveScopeKey, chatId);
        const fallback = this.resolveFallbackConfig(effectiveScopeKey, userId);
        const next: ScopeRuntimeConfig = {
          backendType: target,
          model: fallback.backendType === target ? fallback.model : undefined,
          effort: fallback.backendType === target ? fallback.effort : undefined,
        };
        this.persistScopeConfig(effectiveScopeKey, next);
        const model = next.model ?? "default";
        const defaultNote = this.isP2pScope(effectiveScopeKey)
          ? "这是你的默认，没单独切过的群和话题会跟着走。"
          : "只影响当前对话。";
        this.sendAgentCard(chatId, platformChatId, msgId, "Agent|green",
          `已切换到 **${displayBackendType(target)}** (Model: ${model})\n${defaultNote}\n重启后仍保持。上下文已重置。`,
          replyThreadId);
        this.log.info("agent backend switched for scope", {
          backend: target,
          scopeKey: effectiveScopeKey,
          model,
        });
      } catch (err) {
        this.log.error("failed to switch agent backend", { error: String(err), scopeKey: effectiveScopeKey });
        this.sendAgentCard(chatId, platformChatId, msgId, "Agent|red", `切换失败: ${String(err)}`, replyThreadId);
      }
    });
  }

  private resetScopeAgentConfig(
    scopeKey: string,
    chatId: string,
    platformChatId: string,
    msgId: string | undefined,
    replyThreadId: string | undefined,
    userId: string | undefined,
  ): void {
    this.startSessionTransition(scopeKey, async () => {
      try {
        await this.stopActiveRunForSessionTransition(scopeKey, chatId);
        await this.waitForSessionCreation(scopeKey);
        await this.archiveSession(scopeKey, chatId);
        deleteScopeRuntimeConfig(this.db, this.botIdentity.name, scopeKey);
        this.sendAgentCard(
          chatId,
          platformChatId,
          msgId,
          "Agent|green",
          this.isP2pScope(scopeKey)
            ? "已恢复为引擎默认。没单独切过的群和话题会跟着走。"
            : "已去掉这里的单独设置，之后跟私聊默认走。",
          replyThreadId,
        );
      } catch (err) {
        this.log.error("failed to reset agent config", { error: String(err), scopeKey });
        this.sendAgentCard(chatId, platformChatId, msgId, "Agent|red", `恢复默认失败: ${String(err)}`, replyThreadId);
      }
    });
  }

  /**
   * /model 命令：查看或切换模型。
   * - /model              → 显示当前模型 + 可选列表
   * - /model <name|index> → 切主模型
   * - /model reset        → 恢复为配置初始值
   */
  private async handleModelCommand(args: string[], chatId: string, platformChatId: string, msgId?: string, scopeKey?: string, userId?: string): Promise<void> {
    const effectiveScopeKey = scopeKey ?? chatId;
    const replyThreadId = parseScopeKey(effectiveScopeKey).threadId;
    if (args.length === 0) {
      this.sendModelList(chatId, platformChatId, msgId, effectiveScopeKey, userId);
      return;
    }

    if (args[0] === "reset") {
      if (!this.isP2pScope(effectiveScopeKey) && !this.hasOwnScopeConfig(effectiveScopeKey)) {
        this.sendAgentCard(
          chatId,
          platformChatId,
          msgId,
          "Model|blue",
          "当前跟着默认，没有单独设置。",
          replyThreadId,
        );
        return;
      }
      this.setScopeModels(effectiveScopeKey, { model: undefined }, userId);
      this.updateActiveScopeSessionModels(effectiveScopeKey, {
        model: undefined,
      });
      this.sendAgentCard(
        chatId,
        platformChatId,
        msgId,
        "Model|green",
        this.isP2pScope(effectiveScopeKey)
          ? "已恢复为默认模型。这是你的默认，没单独切过的群和话题会跟着走。"
          : "已恢复为默认模型。只影响当前对话。",
        replyThreadId,
      );
      this.log.info("model reset to backend defaults", {
        backend: this.resolveScopeBackendType(effectiveScopeKey, userId),
        scopeKey: effectiveScopeKey,
      });
      return;
    }

    if (args[0] === "lite") {
      this.sendAgentCard(chatId, platformChatId, msgId, "Model|blue", "Lite 模型已移除。使用 `/model <名字或编号>` 切换当前模型。", replyThreadId);
      return;
    }

    const modelArg = args.join(" ");

    if (!modelArg) {
      this.sendModelList(chatId, platformChatId, msgId, effectiveScopeKey, userId);
      return;
    }

    // 解析 model：支持编号或名字
    const scopeBackendType = this.resolveScopeBackendType(effectiveScopeKey, userId);
    const candidates = this.buildModelCandidates(scopeBackendType);
    const resolvedModel = this.resolveModelArg(modelArg, candidates);
    let scopeBackend: AgentBackend;
    try {
      scopeBackend = await this.ensureBackend(scopeBackendType);
    } catch (err) {
      this.log.error("failed to load backend for /model", {
        error: String(err),
        backend: scopeBackendType,
        scopeKey: effectiveScopeKey,
      });
      this.sendAgentCard(
        chatId,
        platformChatId,
        msgId,
        "Model|red",
        `处理 /model 失败: ${String(err)}`,
        replyThreadId,
      );
      return;
    }

    // 新模型名不在候选列表中 → 探测验证（同步等待，先发进度避免看起来卡住）
    if (!candidates.includes(resolvedModel) && scopeBackend.validateModel) {
      this.log.info("probing unknown model", { model: resolvedModel, backend: scopeBackendType });
      const progress = `正在探测模型 **${resolvedModel}**，可能需要几十秒，请稍等…`;
      try {
        // 进度提示不入库，避免污染会话历史；发送失败不阻断探测
        await this.sendBuiltinCard(platformChatId, chatId, "Model|orange", progress, msgId, replyThreadId);
      } catch (err) {
        this.log.warn("model probe progress send failed", { model: resolvedModel, error: String(err) });
      }
      try {
        const result = await scopeBackend.validateModel(resolvedModel);
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
          this.sendAgentCard(chatId, platformChatId, msgId, "Model|red", lines.join("\n"), replyThreadId);
          return;
        }
      } catch (err) {
        this.log.warn("model probe error, allowing switch", { model: resolvedModel, error: String(err) });
      }
    }

    this.setScopeModels(effectiveScopeKey, { model: resolvedModel }, userId);
    this.updateActiveScopeSessionModels(effectiveScopeKey, { model: resolvedModel });
    this.recordModelHistory(scopeBackendType, resolvedModel);
    const modelNote = this.isP2pScope(effectiveScopeKey)
      ? "这是你的默认，没单独切过的群和话题会跟着走。"
      : "只影响当前对话。";
    this.sendAgentCard(chatId, platformChatId, msgId, "Model|green", `模型已切换为 **${resolvedModel}**\n${modelNote}`, replyThreadId);
    this.log.info("model switched (runtime)", { model: resolvedModel, backend: scopeBackendType, scopeKey: effectiveScopeKey });
  }

  /**
   * /effort 命令：查看或切换推理强度。
   * - /effort              → 显示当前 effort + 可选值 + 当前 backend 是否支持
   * - /effort <level>      → 切换（low/medium/high/xhigh/max）
   * - /effort reset        → 恢复 backend 默认
   */
  private handleEffortCommand(args: string[], chatId: string, platformChatId: string, msgId?: string, scopeKey?: string, userId?: string): void {
    const effectiveScopeKey = scopeKey ?? chatId;
    const replyThreadId = parseScopeKey(effectiveScopeKey).threadId;
    const scopeBackendType = this.resolveScopeBackendType(effectiveScopeKey, userId);
    const supported = EFFORT_SUPPORTED_BACKENDS.has(scopeBackendType);

    if (args.length === 0) {
      const lines = [
        `**Agent:** ${scopeBackendType}`,
        `**Effort:** ${this.resolveScopeModels(effectiveScopeKey, scopeBackendType, userId).effort ?? "default"}`,
        "",
        supported
          ? `可选：${EFFORT_LEVELS.map((level, i) => `${i + 1}. \`${level}\``).join("  ")}`
          : `当前 backend（${scopeBackendType}）不支持 effort 参数，设置会保存但不生效。`,
        "",
        "`/effort <级别|编号>` 切换",
        "`/effort reset` 恢复默认",
      ];
      this.sendAgentCard(chatId, platformChatId, msgId, "Effort|violet", lines.join("\n"), replyThreadId);
      return;
    }

    if (args[0] === "reset") {
      if (!this.isP2pScope(effectiveScopeKey) && !this.hasOwnScopeConfig(effectiveScopeKey)) {
        this.sendAgentCard(
          chatId,
          platformChatId,
          msgId,
          "Effort|blue",
          "当前跟着默认，没有单独设置。",
          replyThreadId,
        );
        return;
      }
      this.setScopeModels(effectiveScopeKey, { effort: undefined }, userId);
      this.updateActiveScopeSessionModels(effectiveScopeKey, { effort: undefined });
      this.sendAgentCard(
        chatId,
        platformChatId,
        msgId,
        "Effort|green",
        this.isP2pScope(effectiveScopeKey)
          ? "已恢复为默认强度。这是你的默认，没单独切过的群和话题会跟着走。"
          : "已恢复为默认强度。只影响当前对话。",
        replyThreadId,
      );
      this.log.info("effort reset", { backend: scopeBackendType, scopeKey: effectiveScopeKey });
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
        chatId, platformChatId, msgId, "Effort|orange",
        `无效级别 **${args[0]}**。\n可选：${EFFORT_LEVELS.map((item, i) => `${i + 1}. ${item}`).join("  ")}`,
        replyThreadId,
      );
      return;
    }

    this.setScopeModels(effectiveScopeKey, { effort: level }, userId);
    this.updateActiveScopeSessionModels(effectiveScopeKey, { effort: level });
    const scopeNote = this.isP2pScope(effectiveScopeKey)
      ? "这是你的默认，没单独切过的群和话题会跟着走。"
      : "只影响当前对话。";
    const note = supported
      ? scopeNote
      : `当前 backend（${scopeBackendType}）不支持 effort 参数，值已保存；切换到支持的 backend 后自动生效。`;
    this.sendAgentCard(chatId, platformChatId, msgId, "Effort|green", `推理强度已切换为 **${level}**\n${note}`, replyThreadId);
    this.log.info("effort switched (runtime)", { effort: level, backend: scopeBackendType, scopeKey: effectiveScopeKey });
  }

  /**
   * /tz：查看或切换展示时区。时刻仍按 UTC 存储。
   * - /tz                         → 显示当前时区
   * - /tz 东京 或 /tz 把时区改成纽约 → 切换并写入配置
   * - /tz reset                   → 恢复默认北京时间
   */
  private handleTimezoneCommand(args: string[], chatId: string, platformChatId: string, msgId?: string, threadId?: string): void {
    const action = args[0]?.toLowerCase();
    if (args.length === 0 || (args.length === 1 && (action === "get" || action === "show"))) {
      this.sendAgentCard(
        chatId, platformChatId, msgId, "Timezone|blue",
        [
          `**Timezone:** ${TZ}`,
          "",
          "`/tz 纽约` 切换",
          "`/tz sys` 跟随系统",
          "`/tz reset` 恢复北京",
        ].join("\n"),
        threadId,
      );
      return;
    }

    const requested = action === "reset"
      ? DEFAULT_TIMEZONE
      : (action === "sys" || action === "system")
        ? resolveSystemTimeZone()
        : args.join(" ");
    try {
      const resolved = this.setEngineTimezone(requested);
      this.sendAgentCard(
        chatId, platformChatId, msgId, "Timezone|green",
        `已切换为 **${resolved}**`,
        threadId,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn("failed to update timezone", { error: message });
      this.sendAgentCard(
        chatId, platformChatId, msgId, message.startsWith("未知时区") ? "Timezone|orange" : "Timezone|red",
        message.startsWith("未知时区")
          ? `未知时区 **${requested}**。\n可以说北京、东京、纽约，或 \`Asia/Shanghai\`。`
          : `时区保存失败：${message}`,
        threadId,
      );
    }
  }

  /** /tz 和 agent（nbt timezone set）共用：解析后写入配置并切换展示时区。 */
  setEngineTimezone(raw: string): string {
    const resolved = normalizeTimeZoneInput(raw);
    if (!resolved) throw new Error(`未知时区: ${raw}`);
    if (!this.engineLifecycle) throw new Error("Engine 生命周期服务不可用。");
    this.engineLifecycle.setTimezone(resolved);
    this.log.info("timezone switched", { timezone: resolved });
    return resolved;
  }

  /** /autoupdate：查看/开关自动升级。 */
  private handleAutoUpdateCommand(args: string[], chatId: string, platformChatId: string, msgId?: string, threadId?: string): void {
    const config = this.effectiveAutoUpdateConfig();

    const action = args[0]?.toLowerCase();
    if (action === "on" || action === "enable" || action === "1") {
      if (!this.persistAutoUpdateSetting(true, chatId, platformChatId, msgId, threadId)) return;
      this.sendAgentCard(
        chatId, platformChatId, msgId, "AutoUpdate|green",
        `自动升级已**开启**。\n窗口：${config.windowStartHour}:00-${config.windowEndHour}:00（${config.timezone}），引擎空闲时自动升级。`,
        threadId,
      );
      this.log.info("auto-update enabled (runtime)", { userId: chatId });
      return;
    }
    if (action === "off" || action === "disable" || action === "0") {
      if (!this.persistAutoUpdateSetting(false, chatId, platformChatId, msgId, threadId)) return;
      this.sendAgentCard(chatId, platformChatId, msgId, "AutoUpdate|grey", "自动升级已**关闭**。", threadId);
      this.log.info("auto-update disabled (runtime)", { userId: chatId });
      return;
    }

    // 查看状态（含无效参数）
    const enabled = this.isAutoUpdateEnabled();
    const lines = [
      `**自动升级：** ${enabled ? "✅ 开启" : "⛔ 关闭"}`,
      `**Env：** ${this.engineLifecycle?.getStatus().environment ?? "unknown"}`,
      `**窗口：** ${config.windowStartHour}:00-${config.windowEndHour}:00（${config.timezone}）`,
      `**空闲判定：** 无进行中任务 + 无排队 + 窗口内无定时触发`,
      `**结果通知：** ${config.notifyOnResult ? "成功白天汇报" : "完全静默"}`,
      "",
      "`/update auto on` 开启",
      "`/update auto off` 关闭",
      "（`/autoupdate` 为兼容别名）",
    ];
    this.sendAgentCard(chatId, platformChatId, msgId, "AutoUpdate|blue", lines.join("\n"), threadId);
  }

  private persistAutoUpdateSetting(
    enabled: boolean,
    chatId: string,
    platformChatId: string,
    msgId?: string,
    threadId?: string,
  ): boolean {
    try {
      if (!this.engineLifecycle) {
        throw new Error("Engine 生命周期服务不可用。");
      }
      this.engineLifecycle.setAutoUpdateEnabled(enabled);
      return true;
    } catch (err) {
      this.log.warn("failed to update auto-update config", { error: String(err) });
      this.sendAgentCard(
        chatId,
        platformChatId,
        msgId,
        "AutoUpdate|red",
        `自动升级设置保存失败：${err instanceof Error ? err.message : String(err)}`,
        threadId,
      );
      return false;
    }
  }

  /** 当前对话覆盖 ?? 私聊默认 ?? 引擎启动配置。没有覆盖就不写库。 */
  private resolveScopeConfig(scopeKey: string, userId?: string): ScopeRuntimeConfig {
    const own = getScopeRuntimeConfig(this.db, this.botIdentity.name, scopeKey);
    if (own) return own;
    return this.resolveFallbackConfig(scopeKey, userId);
  }

  private resolveFallbackConfig(scopeKey: string, userId?: string): ScopeRuntimeConfig {
    const p2pChatId = this.p2pFallbackChatId(scopeKey, userId);
    if (p2pChatId) {
      const p2p = getScopeRuntimeConfig(this.db, this.botIdentity.name, p2pChatId);
      if (p2p) return p2p;
    }
    return {
      backendType: this.backendType,
      model: this.botIdentity.model,
      effort: this.botIdentity.effort,
    };
  }

  private persistScopeConfig(scopeKey: string, config: ScopeRuntimeConfig): void {
    setScopeRuntimeConfig(this.db, this.botIdentity.name, scopeKey, config);
  }

  private resolveScopeBackendType(scopeKey: string, userId?: string): AgentBackendType {
    return this.resolveScopeConfig(scopeKey, userId).backendType;
  }

  private isP2pScope(scopeKey: string): boolean {
    const { chatId, threadId } = parseScopeKey(scopeKey);
    if (threadId) return false;
    const chat = this.db.prepare("SELECT type FROM chats WHERE id = ?").get(chatId) as { type: string | null } | undefined;
    return chat?.type !== "group";
  }

  private hasOwnScopeConfig(scopeKey: string): boolean {
    return Boolean(getScopeRuntimeConfig(this.db, this.botIdentity.name, scopeKey));
  }

  /** Loop/wake 重启后 map 是空的，要从 session 或私聊行找回说话的人，才能读到私聊默认。 */
  private resolveChatUserId(chatId: string, threadId?: string): string | undefined {
    const mapped = this.chatUserIds.get(chatId);
    if (mapped) return mapped;
    const fromSession = this.lookupActiveUserSession(chatId, threadId)?.user_id ?? undefined;
    if (fromSession) {
      this.chatUserIds.set(chatId, fromSession);
      return fromSession;
    }
    const owner = this.db.prepare(`
      SELECT u.id AS id
      FROM chats c
      JOIN users u ON u.platform = c.platform AND u.platform_id = c.user_id
      WHERE c.id = ? AND c.type = 'p2p'
    `).get(chatId) as { id: string } | undefined;
    if (!owner) return undefined;
    this.chatUserIds.set(chatId, owner.id);
    return owner.id;
  }

  /** 群/话题没有自己的覆盖时，跟这个人私聊里的设置。已经在私聊里则不再回指。 */
  private p2pFallbackChatId(scopeKey: string, userId?: string): string | undefined {
    if (!userId) return undefined;
    const chatId = parseScopeKey(scopeKey).chatId;
    const chat = this.db.prepare("SELECT type FROM chats WHERE id = ?").get(chatId) as { type: string | null } | undefined;
    if (chat?.type === "p2p") return undefined;
    const p2pChatId = findP2pChatIdForUser(this.db, userId);
    if (!p2pChatId || p2pChatId === chatId) return undefined;
    return p2pChatId;
  }

  private async ensureBackend(type: AgentBackendType): Promise<AgentBackend> {
    const cached = this.backends.get(type);
    if (cached) return cached;
    const inflight = this.backendLoads.get(type);
    if (inflight) return inflight;
    if (!this.backendResolver) {
      throw new Error("backend resolver 未配置，无法切换。");
    }
    const load = this.backendResolver(type).then((backend) => {
      this.backends.set(type, backend);
      return backend;
    }).finally(() => {
      this.backendLoads.delete(type);
    });
    this.backendLoads.set(type, load);
    return load;
  }

  private backendForType(type: AgentBackendType | undefined): AgentBackend {
    if (type) {
      const cached = this.backends.get(type);
      if (cached) return cached;
    }
    return this.agent;
  }

  private backendForSession(session: ChatSession): AgentBackend {
    return this.backendForType(session.backendType ?? this.backendType);
  }

  private backendForScope(scopeKey: string, userId?: string): AgentBackend {
    const session = this.chatSessions.get(scopeKey);
    if (session) return this.backendForSession(session);
    return this.backendForType(this.resolveScopeBackendType(scopeKey, userId));
  }

  private resolveScopeModels(
    scopeKey: string,
    backendType?: AgentBackendType,
    userId?: string,
  ): { model?: string; effort?: string } {
    const config = this.resolveScopeConfig(scopeKey, userId);
    const resolvedBackend = backendType ?? config.backendType;
    if (config.backendType === resolvedBackend) {
      return { model: config.model, effort: config.effort };
    }
    return {};
  }

  private setScopeModels(scopeKey: string, state: { model?: string; effort?: string }, userId?: string): void {
    const current = this.resolveScopeConfig(scopeKey, userId);
    const next: ScopeRuntimeConfig = {
      backendType: current.backendType,
      model: "model" in state ? state.model : current.model,
      effort: "effort" in state ? state.effort : current.effort,
    };
    this.persistScopeConfig(scopeKey, next);
  }

  /** 同步当前 scope 已存在的 backend session；各 backend resume 时会从 session 对象读取 model/effort。 */
  private updateActiveScopeSessionModels(scopeKey: string, models: { model?: string; effort?: string }): void {
    const chatSession = this.chatSessions.get(scopeKey);
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

    this.backendForSession(chatSession).updateSessionModels?.(chatSession.agentSession.id, models);
  }

  /** 构建模型候选列表：初始配置 → 历史 → 运行时新增，顺序稳定 */
  private buildModelCandidates(backendType = this.backendType): string[] {
    const seen = new Set<string>();
    const list: string[] = [];

    const add = (name: string | undefined) => {
      if (name && !seen.has(name)) {
        seen.add(name);
        list.push(name);
      }
    };

    // 1. 初始配置值（顺序锚点，不随运行时切换而变动）
    const initCache = this.backendModelCache.get(backendType);
    add(initCache?.model);

    // 2. 历史记录
    try {
      const rows = this.db.prepare(
        "SELECT model_name FROM model_history WHERE backend = ? ORDER BY last_used_at DESC, id DESC LIMIT 10",
      ).all(backendType) as Array<{ model_name: string }>;
      for (const row of rows) {
        add(row.model_name);
      }
    } catch { /* table may not exist yet */ }

    // 3. 运行时新值（手动输入的新模型名，追加到末尾）
    if (backendType === this.backendType) add(this.botIdentity.model);

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
  private sendModelList(chatId: string, platformChatId: string, msgId?: string, scopeKey?: string, userId?: string): void {
    const effectiveScopeKey = scopeKey ?? chatId;
    const backendType = this.resolveScopeBackendType(effectiveScopeKey, userId);
    const candidates = this.buildModelCandidates(backendType);
    const currentModel = this.resolveScopeModels(effectiveScopeKey, backendType, userId).model;

    const lines: string[] = [
      `**Agent:** ${backendType}`,
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
    this.sendAgentCard(
      chatId,
      platformChatId,
      msgId,
      "Model|blue",
      content,
      parseScopeKey(effectiveScopeKey).threadId,
    );
  }

  /** 发送 Agent 命令卡片回复。话题里必须带 threadId 落库，否则 nbt messages 会显示成主群。 */
  private sendAgentCard(
    chatId: string,
    platformChatId: string,
    msgId: string | undefined,
    header: string,
    content: string,
    threadId?: string,
  ): void {
    const resolvedThreadId = threadId
      ?? (msgId
        ? getMessageByPlatformId(this.db, this.botIdentity.platform, msgId)?.threadId ?? undefined
        : undefined);
    const send = this.sendBuiltinCard(platformChatId, chatId, header, content, msgId, resolvedThreadId);
    send
      .then((pmid) => { this.storeBotResponse(chatId, content, pmid, "text", resolvedThreadId); })
      .catch((err) => this.log.warn("agent card send failed", {
        chatId,
        header,
        error: String(err),
      }));
  }

  /** 发送 /help 卡片 */
  private sendHelpCard(
    chatId: string,
    platformChatId: string,
    msgId: string | undefined,
    isAdmin: boolean,
    threadId?: string,
  ): void {
    const lines = [
      "⚡ **常用命令**",
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
        "🛠 **管理员**",
        "`/admin`　　管理员列表/添加/移除",
        "`/model`　　查看/切换模型",
        "`/effort`　 查看/切换推理强度",
        "`/tz`　　查看/切换展示时区",
        "`/agent`　　查看/切换 Agent backend",
        "`/restart`　重启引擎",
        "`/update`　　检查更新",
        "`/awake`　　查看/切换防休眠",
        "`/<cmd>`　　执行 shell 命令",
      );
    }
    if (threadId) {
      lines.push(
        "",
        "ℹ️ **话题作用域**",
        "`/stop`、`/flush`、`/clear`、`/new`、`/status`、`/agent`、`/model`、`/effort` 只作用于当前话题。",
        "工作目录仍由同群所有话题共享；长任务请用 `/task`。",
      );
    }
    const content = lines.join("\n");
    this.sendAgentCard(chatId, platformChatId, msgId, "帮助|blue", content, threadId);
  }

  private handleAwakeCommand(
    args: string[],
    chatId: string,
    platformChatId: string,
    msgId?: string,
    threadId?: string,
  ): void {
    const lifecycle = this.engineLifecycle;
    if (!lifecycle) {
      this.replyText(chatId, platformChatId, msgId, "Engine 生命周期服务不可用。");
      return;
    }
    const action = args[0]?.toLowerCase();
    if (!action || action === "status") {
      const status = lifecycle.getKeepAwakeStatus();
      const baseText = formatKeepAwakeStatus(status);
      const sendStatus = (content: string, header: string) => {
        this.sendAgentCard(chatId, platformChatId, msgId, header, content, threadId);
      };
      void collectDisplayStatus().then((display) => {
        sendStatus(baseText + formatDisplayStatus(display), formatKeepAwakeHeader(status));
      }).catch((err) => {
        this.log.warn("failed to collect display status", { error: String(err) });
        sendStatus(baseText, formatKeepAwakeHeader(status));
      });
      return;
    }
    if (action !== "on" && action !== "off") {
      this.replyText(chatId, platformChatId, msgId, "用法：/awake [on|off|status]");
      return;
    }
    void lifecycle.setKeepAwakeEnabled(action === "on").then((status) => {
      const content = formatKeepAwakeStatus(status);
      this.sendAgentCard(chatId, platformChatId, msgId, formatKeepAwakeHeader(status), content, threadId);
    }).catch((err) => {
      this.log.error("keep-awake command failed", { action, error: String(err) });
      this.replyText(chatId, platformChatId, msgId, `防休眠切换失败：${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** 管理员命令：Windows 优先 pwsh、回退 powershell.exe，Unix 保持平台默认 shell。 */
  private tryShellCommand(
    cmd: string,
    userId: string,
    chatId: string,
    chatType: string,
    platformChatId: string,
    msgId?: string,
    threadId?: string,
    scopeKey?: string,
  ): void {
    this.log.info("shell command", { cmd });
    const effectiveScopeKey = scopeKey ?? chatId;
    const activeRun = this.runtimeState.getActiveRunForScope(effectiveScopeKey);
    const replyToMsgId = activeRun?.replyToPlatformMsgId;

    const sendResult = (content: string, header = "Shell|blue") => {
      this.sendAgentCard(chatId, platformChatId, msgId, header, content, threadId);
    };

    const env = buildNiubotEnv({
      workingDirectory: this.workingDirectory,
      userId,
      chatId,
      scopeKey: effectiveScopeKey,
      threadId,
      replyToMsgId,
      chatType: chatType as "p2p" | "group",
      dbPath: this.dbPath,
      botId: this.botIdentity.platformBotId,
      botName: this.botIdentity.name,
      platform: this.botIdentity.platform,
      isAdmin: true,
      botProfilePath: this.stableContextOptions.botProfilePath,
    });

    const execOptions = {
      timeoutMs: SHELL_COMMAND_TIMEOUT_MS,
      cwd: this.workingDirectory,
      env: { ...process.env, ...env },
      // 对齐原 exec 默认 maxBuffer（1MB）；4KB 的 SHELL_MAX_OUTPUT_LEN 只控制展示截断
      maxOutputBytes: 1024 * 1024,
    };
    const execution = process.platform === "win32"
      ? (() => {
        const invocation = buildWindowsAdminShellInvocation(cmd, { env: execOptions.env });
        return runCommand(invocation.command, invocation.args, {
          ...execOptions,
          throwOnNonZero: false,
        });
      })()
      : runCommand(cmd, [], {
        ...execOptions,
        shell: true,
        throwOnNonZero: false,
      });

    execution.then(({ stdout, stderr, exitCode }) => {
      const output = (stdout + stderr).trim();
      this.recordShellHistory(cmd, output, exitCode);
      sendResult(formatShellOutput(this.workingDirectory, cmd, output, exitCode), exitCode === 0 ? "Shell|blue" : "Shell|red");
    }).catch((err: unknown) => {
      const { output, exitCode, formatted } = formatShellExecErrorDetails(this.workingDirectory, cmd, err);
      this.recordShellHistory(cmd, output, exitCode);
      sendResult(formatted, "Shell|red");
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

  private sendShellHistory(chatId: string, platformChatId: string, msgId?: string, threadId?: string): void {
    if (this.shellHistory.length === 0) {
      this.replyText(chatId, platformChatId, msgId, "暂无 shell 命令历史。", threadId);
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
    this.sendAgentCard(chatId, platformChatId, msgId, "Shell 历史|blue", lines.join("\n"), threadId);
  }

  private async handleUpdate(
    chatId: string,
    platformChatId: string,
    msgId?: string,
    confirmed = false,
    showAutoInfo = false,
    threadId?: string,
    scopeKey?: string,
  ): Promise<void> {
    // /update 不带参数时附带自动升级状态/帮助，单卡片展示
    const autoInfo = showAutoInfo ? this.buildAutoUpdateStatusLines() : null;
    const effectiveScopeKey = scopeKey ?? chatId;
    const replyOptions = {
      replyInThread: Boolean(threadId) || this.isStrictTopicChat(chatId),
    };
    if (replyOptions.replyInThread && !msgId) {
      this.log.warn("update reply skipped in strict topic without reply anchor", {
        chatId,
        platformChatId,
      });
      return;
    }

    try {
      if (!this.engineLifecycle) throw new Error("Engine 生命周期服务不可用。");
      const update = await this.engineLifecycle.checkForUpdate();
      const { currentVersion, latestVersion, updateAvailable } = update;
      const env = this.engineLifecycle.getStatus().environment;
      if (!updateAvailable) {
        const text = [
          `✅ 已是最新版本 (${currentVersion})。`,
          `Env: ${env}`,
          ...(autoInfo ? ["", ...autoInfo] : []),
        ].join("\n");
        const send = this.transport.sendCard(platformChatId, "更新|green", text, undefined, msgId, replyOptions);
        send.then((pmid) => { this.storeBotResponse(chatId, text, pmid, "text", threadId); }).catch((err) => this.log.warn("update card send failed", { error: String(err) }));
        return;
      }

      if (!confirmed) {
        const text = [
          `🚀 发现新版本：${currentVersion} → ${latestVersion}`,
          `Env: ${env}`,
          `发送 \`${UPDATE_CONFIRM_COMMAND}\` 升级并重启。`,
          ...(autoInfo ? ["", ...autoInfo] : []),
        ].join("\n");
        const send = this.transport.sendCard(platformChatId, "更新|orange", text, undefined, msgId, replyOptions);
        send.then((pmid) => { this.storeBotResponse(chatId, text, pmid, "text", threadId); }).catch((err) => this.log.warn("update card send failed", { error: String(err) }));
        return;
      }

      this.replyText(chatId, platformChatId, msgId, `正在准备 ${latestVersion} 的独立 release；旧服务会保留到新版本预检通过。`, threadId, Boolean(threadId));
      this.triggerRestart({
        chatId,
        platformChatId,
        scopeKey: effectiveScopeKey,
        threadId,
        updateVersion: latestVersion,
        replyToMsgId: msgId,
        silent: true,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.replyText(
        chatId,
        platformChatId,
        msgId,
        `更新失败：${msg.slice(0, 500)}`,
        threadId,
        Boolean(threadId),
      );
    }
  }

  /** 自动升级状态/帮助行（供 /update 默认展示，单卡片合并）。 */
  private buildAutoUpdateStatusLines(): string[] {
    const config = this.effectiveAutoUpdateConfig();
    const enabled = this.isAutoUpdateEnabled();
    return [
      `**自动升级：** ${enabled ? "✅ 开启" : "⛔ 关闭"}`,
      `**窗口：** ${config.windowStartHour}:00-${config.windowEndHour}:00（${config.timezone}）`,
      `**结果通知：** ${config.notifyOnResult ? "成功白天汇报" : "完全静默"}`,
      "",
      "`/update auto on` 开启",
      "`/update auto off` 关闭",
    ];
  }

  /** 向 Engine 暴露本 Bot 的只读空闲状态；Pipeline 不执行升级决策。 */
  getUpgradeSafenessSources(): UpgradeSafenessSource[] {
    return [
      mainRunSource({
        inflightRunCount: () => this.runtimeState.getPipelineHealth().inflightRunIds.length,
        pendingMessageCount: () => this.queue.hasBusyChats() ? 1 : 0,
      }),
      goalSource({ activeGoalCount: () => this.activeGoals.size }),
      cronSource(this.db),
      loopSource(this.db),
    ];
  }

  /** 请求 Engine 启动 restart worker；Pipeline 只负责定位通知会话和展示结果。 */
  triggerRestart(opts?: {
    platformChatId?: string;
    chatId?: string;
    scopeKey?: string;
    threadId?: string;
    updateVersion?: string;
    silent?: boolean;
    replyToMsgId?: string;
  }): void {
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
    const scopeKey = opts?.scopeKey ?? chatId ?? "";
    const threadId = opts?.threadId ?? parseScopeKey(scopeKey).threadId;
    const activeRun = this.runtimeState.getActiveRunForScope(scopeKey);
    const replyToMsgId = opts?.replyToMsgId
      ?? activeRun?.replyToPlatformMsgId
      ?? (threadId ? this.latestThreadPlatformMsgId(parseScopeKey(scopeKey).chatId, threadId) : undefined);
    const strict = Boolean(threadId) || (chatId ? this.isStrictTopicChat(chatId) : false);

    const sendRestartNotice = (text: string): void => {
      if (!platformChatId) return;
      this.sendPreferringReply(
        platformChatId,
        "restart",
        (anchor) => this.transport.sendReply(platformChatId, text, anchor, { replyInThread: strict }),
        () => this.transport.sendText(platformChatId, text),
        replyToMsgId,
        { allowChatFallback: !strict, replyInThread: strict },
      ).catch(() => {});
    };

    // 发送"正在重启..."通知（自动升级静默，不打扰用户）
    if (platformChatId && !opts?.silent) {
      sendRestartNotice("正在重启...");
    }

    try {
      if (!this.engineLifecycle) throw new Error("Engine 生命周期服务不可用。");
      const worker = this.engineLifecycle.restart({
        botName: this.botIdentity.name,
        chatId,
        scopeKey,
        threadId,
        wakeReplyTo: replyToMsgId,
        updateVersion: opts?.updateVersion,
      });
      this.log.info("restart worker launched", {
        pid: worker.pid,
        chatId,
        scopeKey,
        threadId,
        sourceDirectory: worker.sourceDirectory,
        logFile: worker.logFile,
      });
    } catch (err) {
      const errMsg = (err instanceof Error ? err.message : String(err)).slice(0, ERROR_DISPLAY_MAX_LEN);
      this.log.error("restart worker failed to launch", { error: errMsg });
      sendRestartNotice(`重启失败：\n\`\`\`\n${errMsg.replace(/`{3,}/g, "``")}\n\`\`\``);
    }
  }

  private async process(
    scopeKey: string,
    mergedText: string,
    messages: QueuedMessage[] = [],
    signal?: AbortSignal,
    runId?: string,
  ): Promise<void> {
    const parsedScope = parseScopeKey(scopeKey);
    const chatId = parsedScope.chatId;
    const threadId = parsedScope.threadId;
    const isolated = Boolean(threadId);
    const strict = messages.at(-1)?.strict ?? this.isStrictTopicChat(chatId);
    const transition = this.globalSessionTransition ?? this.sessionTransitionLocks.get(scopeKey);
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
    const existingGoal = this.activeGoals.get(scopeKey);
    if (existingGoal && !existingGoal.endedAt && (existingGoal.finishRunId === runId || existingGoal.turnCount > 0)) {
      const goalChatType = (this.db.prepare("SELECT type FROM chats WHERE id = ?").get(chatId) as { type: string } | undefined)?.type;
      this.noteBotCollabTurn(chatId, goalChatType === "group" ? "group" : "p2p", messages);
      await this.runGoalLoop(chatId, scopeKey, existingGoal, runId, signal);
      return;
    }

    let activeLoopJob: LoopJob | undefined;
    let loopSettled = false;
    const clearActiveLoopRun = () => {
      if (!activeLoopJob) return;
      const active = this.activeLoopRuns.get(activeLoopJob.id);
      if (active?.scopeKey === scopeKey && active.runId === runId) {
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
      this.activeLoopRuns.set(activeLoopJob.id, { chatId, scopeKey, runId });
    }

    const platformChatId = this.chatSessions.get(scopeKey)?.platformChatId
      ?? this.platformChatIds.get(chatId);

    // 从消息列表中取最后一条的 platformMsgId 作为 reply 目标。
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : undefined;
    let triggerMsgId = lastMsg?.replyToMsgId ?? lastMsg?.platformMsgId ?? this.triggerMsgIds.get(scopeKey);
    this.triggerMsgIds.delete(scopeKey);
    // Loop / 重启唤醒没有对应的当前用户消息，不引用历史消息，避免挂错位置。
    if (isWakeTurn) triggerMsgId = lastMsg?.replyToMsgId ?? undefined;

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
        settleLoop({ success: false, cancelled: true });
        this.markRuntimeRun(runId, "stopped");
        return;
      }

      const msgIds = messages.map((m) => m.dbMsgId).filter((id): id is number => id != null);
      const firstMsgId = msgIds.length > 0 ? Math.min(...msgIds) : undefined;
      const chatSession = await this.getOrCreateSession(scopeKey, chatId, threadId, firstMsgId, signal);
      const chatTypeRow = this.db.prepare("SELECT type FROM chats WHERE id = ?").get(chatId) as { type: string } | undefined;
      const processChatType = (chatTypeRow?.type ?? "p2p") as "p2p" | "group";

      const baseMessage = isLoopTurn
        ? this.buildLoopContinuationPrompt(activeLoopJob!)
        : isWakeTurn
          ? `【重启完成】\n${mergedText}`
          : mergedText;
      const stableCtx = this.pendingStableContext.get(scopeKey);
      const messageCtx = this.pendingMessageContext.get(scopeKey);
      const compactRecovery = this.pendingCompactRecovery.has(scopeKey);
      const isNewSessionPrompt = this.pendingNewSessionReminder.has(scopeKey);
      const mixedInjection = Boolean(stableCtx || messageCtx || compactRecovery || isNewSessionPrompt);
      const payload = !isLoopTurn && !isWakeTurn && mixedInjection
        ? wrapInjectedUserMessage(baseMessage)
        : baseMessage;
      let messageToSend = payload;
      if (mixedInjection) {
        const parts: string[] = [];
        if (stableCtx) {
          parts.push(stableCtx);
        }
        if (messageCtx && !compactRecovery) {
          parts.push(messageCtx);
        }
        if (compactRecovery) {
          const recoveryParts: string[] = [];
          const processBackend = this.backendForSession(chatSession);
          if (processBackend.needsCompactRecoveryReminder()) {
            recoveryParts.push(COMPACT_RECOVERY_REMINDER);
          }
          if (processBackend.needsStableUserPrefix()) {
            recoveryParts.push(this.buildStableSystemContext());
          }
          const recoveryUserId = processChatType === "group" ? undefined : chatSession.userId;
          recoveryParts.push(this.buildSessionProfile(chatId, processChatType, recoveryUserId));
          const taskContext = buildActiveTaskContext(this.workingDirectory, processChatType, recoveryUserId);
          if (taskContext) {
            recoveryParts.push(`<session-state>\n${taskContext}\n</session-state>`);
          }
          parts.push(recoveryParts.join("\n\n"));
        }
        if (isNewSessionPrompt) {
          parts.push(NEW_SESSION_SEARCH_REMINDER);
        }
        this.pendingStableContext.delete(scopeKey);
        this.pendingMessageContext.delete(scopeKey);
        this.pendingCompactRecovery.delete(scopeKey);
        this.pendingNewSessionReminder.delete(scopeKey);
        messageToSend = `${parts.join("\n\n")}\n\n${payload}`;
      }

      // 群聊：消息级 speaker 注入；内部 Loop 回合没有当前发言者。
      if (!isLoopTurn && processChatType === "group" && messages.length > 0) {
        const senderIds = [...new Set(messages.map((m) => m.senderId).filter((id): id is string => !!id))];
        if (senderIds.length > 0) {
          const speakers: SpeakerInfo[] = senderIds.map((id) => {
            const row = this.db.prepare("SELECT name, is_bot FROM users WHERE id = ?").get(id) as { name: string | null; is_bot: number } | undefined;
            return {
              userId: id,
              userName: row?.name ?? undefined,
              isAdmin: this.adminRoles.has(id),
              isBot: row?.is_bot === 1,
            };
          });
          const speakerCtx = buildSpeakerContext(this.db, speakers);
          if (speakerCtx) {
            messageToSend = `${speakerCtx}\n\n${messageToSend}`;
          }
        }
      }

      markMessagesAgentSeen(this.db, msgIds);

      if (signal?.aborted) {
        this.log.info("process cancelled before sending to agent", { chatId });
        if (!isLoopTurn && !this.globalSessionTransition && !this.sessionTransitionLocks.has(scopeKey)) {
          await this.archiveSession(scopeKey, chatId);
        }
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

      this.noteBotCollabTurn(scopeKey, processChatType, messages);

      this.log.info("sending to agent", {
        chatId,
        sessionId: chatSession.sessionId,
        textLength: messageToSend.length,
      });

      const latestSenderId = [...messages].reverse().find((message) => !!message.senderId)?.senderId;
      const uniqueSenderIds = [...new Set(messages
        .map((message) => message.senderId)
        .filter((senderId): senderId is string => !!senderId))];
      const commandUserId = latestSenderId ?? activeLoopJob?.creatorUserId ?? chatSession.userId;
      const agentResult = await (async () => {
        this.activeScheduleAgentCommands.set(scopeKey, {
          runId: runId!,
          userId: uniqueSenderIds.length === 1 ? uniqueSenderIds[0]! : commandUserId,
          chatType: processChatType,
          userTurn: isLoopTurn || uniqueSenderIds.length === 1,
          token: this.chatScheduleTokens.get(scopeKey) ?? "",
        });
        try {
          return await this.runManager.runAgent({
            runId: runId!,
            chatId,
            agent: this.backendForSession(chatSession),
            session: chatSession.agentSession,
            message: messageToSend,
            signal,
          });
        } finally {
          const scheduleContext = this.activeScheduleAgentCommands.get(scopeKey);
          if (scheduleContext?.runId === runId) this.activeScheduleAgentCommands.delete(scopeKey);
        }
      })();
      if (agentResult.status === "stopped") {
        this.log.info("prompt cancelled, no response to send", { chatId });
        // 本回合若刚通过 nbt goal start 创建了 Goal：以 stopped 结算并清理，避免孤儿 Goal 吞后续消息
        const orphanGoal = this.activeGoals.get(scopeKey);
        if (orphanGoal && !orphanGoal.endedAt && orphanGoal.startRunId === runId) {
          this.log.info("goal start turn cancelled, settling goal as stopped", { chatId, runId });
          this.finishGoal(chatId, orphanGoal, "stopped", "回合被取消");
          this.cleanupGoal(scopeKey, chatId, orphanGoal, runId);
        }
        settleLoop({ success: false, cancelled: true });
        this.markRuntimeRun(runId, "stopped");
        return;
      }
      const response = agentResult.response;

      // Goal 主动进入：本回合 Agent 调用了 nbt goal start → 本回合计入第 1 轮，runGoalLoop 接管
      // （本轮不再按普通回合交付，由 Goal 流程处理：finish 则结算，否则静默继续下一轮）
      const startedGoal = this.activeGoals.get(scopeKey);
      if (startedGoal && !startedGoal.endedAt && startedGoal.startRunId === runId) {
        this.log.info("goal start turn detected, adopting as round 1", { chatId, runId });
        if (isLoopTurn && activeLoopJob && !loopSettled) {
          settleLoop({ success: true, cancelled: true });
        }
        await this.runGoalLoop(chatId, scopeKey, startedGoal, runId, signal, agentResult);
        return;
      }

      // `/loop del` 可在 Agent 执行期间由内置命令立即处理。Agent 返回后先查持久状态，
      // 被用户取消的本轮不写入主会话历史，也不向平台发送。Loop 自己取消则保留本轮结论。
      // 检查后到 sendCard 之间没有 await，因此同一进程内的新取消命令不能插入这段同步路径。
      if (isLoopTurn && activeLoopJob && getLoopJob(this.db, activeLoopJob.id)?.status !== "running") {
        if (!this.activeLoopRuns.get(activeLoopJob.id)?.selfCancelled) {
          loopSettled = true;
          clearActiveLoopRun();
          this.log.info("cancelled loop result discarded", { chatId, loopJobId: activeLoopJob.id });
          this.markRuntimeRun(runId, "stopped");
          return;
        }
        this.log.info("loop self-cancelled, delivering final result", { chatId, loopJobId: activeLoopJob.id });
      }
      const compactedThisTurn = this.updateCompactRecoveryState(scopeKey, response.compactCount);

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
      const agentSessionId = nativeSessionId(
        this.backendForSession(chatSession).getAgentSessionId?.(chatSession.agentSession.id),
        chatSession.agentSession.id,
      );
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

      // 合并消息提示头；出站前强制剥离内部标签（保护：不依赖 LLM 自觉）
      const loopCardHeader = isLoopTurn && activeLoopJob ? buildLoopCardHeader(activeLoopJob) : "";
      const loopTaskQuote = isLoopTurn && activeLoopJob ? buildLoopTaskQuote(activeLoopJob) : undefined;
      const loopFullMarker = isLoopTurn && activeLoopJob ? buildLoopDeliveryMarker(activeLoopJob) : undefined;
      const addLoopTaskQuote = (text: string): string => loopTaskQuote ? `${loopTaskQuote}\n\n${text}` : text;
      const addLoopFullMarker = (text: string): string => loopFullMarker ? `${loopFullMarker}\n\n${text}` : text;
      let displayText = stripInternalTags(response.text);
      let deliveredText = displayText;
      displayText = addLoopTaskQuote(displayText);
      if (isMerged) {
        const lines = messages.map((m) => {
          const brief = m.text.length > 10 ? m.text.slice(0, 10) + "…" : m.text;
          return `• ${brief}`;
        });
        displayText = `> 📌 回复 ${messages.length} 条消息：\n${lines.map((l) => `> ${l}`).join("\n")}\n\n${displayText}`;
      }

      deliveredText = displayText;

      // 统一最终交付：卡片（reply 优先，footer 带 session 信息）→ 文本（带失败提示）→ 文件
      // 降级链由 ResponseSender.sendFinalResponse 统一承担（超时、不确定结果、超长自动转文件）。
      this.markRuntimeRun(runId, "sending_response");
      let sentPlatformMsgId: string | undefined;
      let deliveredResponseBody = false;
      this.log.info("send decision", { chatId, useReply: !!triggerMsgId, merged: isMerged, messageCount: messages.length, triggerMsgId: triggerMsgId ?? "none" });
      const sendResult = await this.sendPreparedFinalResponse(chatSession.platformChatId, {
        header: loopCardHeader,
        content: displayText,
        footer,
        replyToMsgId: triggerMsgId,
        replyInThread: strict,
        allowChatFallback: !strict,
        signal,
        textFallback: (sendErr) => addLoopFullMarker(`发送失败：${extractPlatformErrorDetail(sendErr)}`),
      });
      if (sendResult.ok) {
        sentPlatformMsgId = sendResult.platformMsgId;
        deliveredResponseBody = sendResult.method === "card"
          || sendResult.deliveredContent === sendResult.sentText;
        // 发出去用飞书 at；历史统一成短号。降级错误文案仍按实际交付内容回写。
        deliveredText = sendResult.deliveredContent === sendResult.sentText
          ? sendResult.historyText
          : sendResult.deliveredContent;
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
      const failedGoal = this.activeGoals.get(scopeKey);
      if (failedGoal && !failedGoal.endedAt && failedGoal.startRunId === runId) {
        this.finishGoal(chatId, failedGoal, "failed", `回合异常：${String(err).slice(0, 200)}`);
        this.cleanupGoal(scopeKey, chatId, failedGoal, runId);
      }
      if (isLoopTurn && activeLoopJob && getLoopJob(this.db, activeLoopJob.id)?.status === "cancelled") {
        loopSettled = true;
        clearActiveLoopRun();
        this.log.info("cancelled loop error discarded", { chatId, loopJobId: activeLoopJob.id });
        this.markRuntimeRun(runId, "stopped");
        return;
      }
      settleLoop({ success: false, error: String(err) });
      this.markRuntimeRun(runId, signal?.aborted ? "stopped" : "failed", String(err));

      if (platformChatId) {
        // 异常终态会附带最后一段 assistant 文本；出站前仍要剥离内部标签，
        // 避免 Loop 注入内容经错误提示旁路泄漏。
        const detail = stripInternalTags(extractAgentErrorDetail(err) ?? "").trim();
        const baseErrorText = detail
          ? `处理出错了：\n\`\`\`\n${detail.replace(/`{3,}/g, "``")}\n\`\`\``
          : "处理出错了，请稍后再试。";
        const errorText = isLoopTurn && activeLoopJob
          ? `${buildLoopDeliveryMarker(activeLoopJob)}\n\n${baseErrorText}`
          : baseErrorText;
        try {
          const pmid = await this.sendPreferringReply(
            platformChatId,
            "process-error",
            (replyToMsgId) => this.transport.sendReply(
              platformChatId,
              errorText,
              replyToMsgId,
              { replyInThread: strict },
            ),
            () => this.transport.sendText(platformChatId, errorText),
            triggerMsgId,
            { allowChatFallback: !strict, replyInThread: strict },
          );
          this.storeBotResponse(chatId, errorText, pmid, "text", threadId);
        } catch { /* give up */ }
      }
    }
  }

  private async getOrCreateSession(
    scopeKey: string,
    chatId?: string,
    threadId?: string,
    beforeMsgId?: number,
    signal?: AbortSignal,
  ): Promise<ChatSession> {
    const resolvedChatId = chatId ?? parseScopeKey(scopeKey).chatId;
    const existing = this.chatSessions.get(scopeKey);
    if (existing) return existing;
    const pending = this.sessionCreations.get(scopeKey);
    if (pending) return pending;

    const creation = this.createChatSession(
      scopeKey,
      resolvedChatId,
      threadId,
      beforeMsgId,
      signal,
    ).finally(() => {
      if (this.sessionCreations.get(scopeKey) === creation) this.sessionCreations.delete(scopeKey);
    });
    this.sessionCreations.set(scopeKey, creation);
    return creation;
  }

  private async createChatSession(
    scopeKey: string,
    chatId: string,
    threadId?: string,
    beforeMsgId?: number,
    signal?: AbortSignal,
  ): Promise<ChatSession> {
    const isolated = Boolean(threadId);
    const strict = this.isStrictTopicChat(chatId);
    let platformChatId = this.platformChatIds.get(chatId);
    if (!platformChatId) {
      const platformRow = this.db.prepare("SELECT platform_id FROM chats WHERE id = ?")
        .get(chatId) as { platform_id: string } | undefined;
      platformChatId = platformRow?.platform_id;
    }
    if (!platformChatId) {
      throw new Error(`No platform chat ID for internal chat ${chatId}`);
    }
    this.platformChatIds.set(chatId, platformChatId);

    const userId = this.resolveChatUserId(chatId, threadId);

    // 查 chatType 用于 memory 可见性控制
    const chatRow = this.db.prepare("SELECT type FROM chats WHERE id = ?").get(chatId) as { type: string } | undefined;
    const chatType = (chatRow?.type ?? "p2p") as "p2p" | "group";

    const isAdmin = userId ? this.adminRoles.has(userId) : false;
    const stableContext = this.buildStableSystemContext();

    // 新主会话生成能力令牌；独立 session（Cron/task）不生成，无法借主会话身份。
    if (!this.chatScheduleTokens.has(scopeKey)) {
      const token = randomUUID();
      this.chatScheduleTokens.set(scopeKey, token);
      this.tokenToScope.set(token, scopeKey);
    }

    let activeSession = this.lookupActiveUserSession(chatId, threadId);
    const activeRun = this.runtimeState.getActiveRunForScope(scopeKey);
    const scopeConfig = this.resolveScopeConfig(scopeKey, userId);
    const scopeBackendType = scopeConfig.backendType;

    if (activeSession) {
      const storedBackend = normalizeBackend(activeSession.backend_type ?? undefined) ?? scopeBackendType;
      if (storedBackend !== scopeBackendType) {
        await this.archiveSession(scopeKey, chatId);
        activeSession = undefined;
      }
    }

    if (activeSession) {
      const nativeId = nativeSessionId(activeSession.agent_session_id);
      const canResume = Boolean(nativeId);
      const sessionBackend = await this.ensureBackend(scopeBackendType);
      // native resume 带着旧 transcript，不要把新 session 那套场景/最近消息再灌一遍。
      // 无法 resume 时等于新开 agent，才补动态上下文。
      if (!canResume) {
        this.queueNewAgentMessageContext(scopeKey, chatId, chatType, userId, threadId, beforeMsgId);
      }
      const resumeModels = { model: scopeConfig.model, effort: scopeConfig.effort };
      const agentSession = await this.createAgentSession({
        workingDirectory: this.workingDirectory,
        reasoningEffort: resumeModels.effort,
        importantContext: stableContext || undefined,
        userId: userId ?? undefined,
        chatId,
        scopeKey,
        threadId,
        replyToMsgId: activeRun?.replyToPlatformMsgId,
        chatType,
        dbPath: this.dbPath,
        botId: this.botIdentity.platformBotId,
        botName: this.botIdentity.name,
        platform: this.botIdentity.platform,
        model: resumeModels.model,
        isAdmin,
        botProfilePath: this.stableContextOptions.botProfilePath,
        agentSessionId: canResume ? nativeId : undefined,
        scheduleToken: this.chatScheduleTokens.get(scopeKey),
      }, sessionBackend);
      this.db.prepare(`
        UPDATE sessions
        SET backend_type = ?,
            last_active_at = datetime('now'),
            agent_session_id = ?
        WHERE id = ?
      `).run(
        scopeBackendType,
        canResume ? nativeId : null,
        activeSession.id,
      );
      const resumedSession: ChatSession = {
        agentSession,
        sessionId: activeSession.id,
        platformChatId,
        userId: userId ?? "",
        triggerPlatformMsgId: this.triggerMsgIds.get(scopeKey),
        threadId,
        isolated,
        strict,
        hasReplied: false,
        backendType: scopeBackendType,
      };
      this.chatSessions.set(scopeKey, resumedSession);
      this.log.info("session attached", {
        chatId,
        scopeKey,
        sessionId: activeSession.id,
        resumed: canResume,
        userId,
        engineHandle: agentSession.id,
        nativeSessionId: nativeId ?? null,
        backend: scopeBackendType,
      });
      return resumedSession;
    }

    this.queueNewAgentMessageContext(scopeKey, chatId, chatType, userId, threadId, beforeMsgId);

    const sessionBackend = await this.ensureBackend(scopeBackendType);
    const newModels = { model: scopeConfig.model, effort: scopeConfig.effort };
    const agentSession = await this.createAgentSession({
      workingDirectory: this.workingDirectory,
      reasoningEffort: newModels.effort,
        importantContext: stableContext || undefined,
        userId: userId ?? undefined,
        chatId,
        scopeKey,
        threadId,
        replyToMsgId: activeRun?.replyToPlatformMsgId,
        chatType,
      dbPath: this.dbPath,
      botId: this.botIdentity.platformBotId,
      botName: this.botIdentity.name,
      platform: this.botIdentity.platform,
      model: newModels.model,
      isAdmin,
      botProfilePath: this.stableContextOptions.botProfilePath,
      scheduleToken: this.chatScheduleTokens.get(scopeKey),
    }, sessionBackend);

    if (sessionBackend.needsStableUserPrefix() && stableContext) {
      this.pendingStableContext.set(scopeKey, stableContext);
    }

    const sessionId = randomUUID().slice(0, 8);

    try {
      if (isolated) {
        this.db.prepare(`
          UPDATE sessions
          SET status = 'archived',
              ended_at = datetime('now'),
              last_active_at = datetime('now')
          WHERE chat_id = ? AND status = 'active' AND source = 'user' AND thread_id IS NULL
        `).run(chatId);
      }
      const orphan = this.db.prepare(`
        SELECT MIN(id) as startId
        FROM messages
        WHERE chat_id = ? AND session_key IS NULL
          AND (? IS NULL OR thread_id = ?)
      `).get(chatId, threadId ?? null, threadId ?? null) as { startId: number | null } | undefined;
      const startMsgId = orphan?.startId ?? null;

      this.db.prepare(`
        INSERT INTO sessions (
          id, chat_id, user_id, status, start_msg_id, thread_id, started_at,
          last_active_at, backend_type, agent_session_id
        )
        VALUES (?, ?, ?, 'active', ?, ?, datetime('now'), datetime('now'), ?, NULL)
      `).run(
        sessionId,
        chatId,
        userId ?? null,
        startMsgId,
        threadId ?? null,
        scopeBackendType,
      );

      this.db.prepare(`
        UPDATE messages SET session_key = ?
        WHERE chat_id = ? AND session_key IS NULL
          AND (? IS NULL OR thread_id = ?)
      `).run(sessionId, chatId, threadId ?? null, threadId ?? null);
    } catch (dbErr) {
      await sessionBackend.closeSession(agentSession).catch(() => {});
      throw dbErr;
    }

    this.pendingNewSessionReminder.add(scopeKey);
    const chatSession: ChatSession = {
      agentSession,
      sessionId,
      platformChatId,
      userId: userId ?? "",
      triggerPlatformMsgId: this.triggerMsgIds.get(scopeKey),
      threadId,
      isolated,
      strict,
      hasReplied: false,
      backendType: scopeBackendType,
    };
    this.chatSessions.set(scopeKey, chatSession);

    this.log.info("session created", {
      chatId,
      scopeKey,
      threadId,
      sessionId,
      userId,
      engineHandle: agentSession.id,
      nativeSessionId: null,
    });
    return chatSession;
  }

  /** 新开 agent 时首条消息的动态上下文暂存（native resume 不灌） */
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

  private queueNewAgentMessageContext(
    scopeKey: string,
    chatId: string,
    chatType: "p2p" | "group",
    userId?: string,
    threadId?: string,
    beforeMsgId?: number,
  ): void {
    const sessionProfile = this.buildSessionProfile(chatId, chatType, userId);
    const normalContext = buildNormalContext(
      this.db, chatId, this.workingDirectory, beforeMsgId, chatType, userId, threadId,
      !threadId && this.isIsolatedTopicChat(chatId),
    );
    const parts = [sessionProfile];
    if (threadId) {
      parts.push(`<topic-isolation>
当前是话题群中的一个独立话题 session，与同群其他话题并行。
工作目录是共享的。长写入前先 git status；不要默认独占仓库。
会改同一批文件的长任务：用 nbt task。
cap=4 只限制本群同时跑的主 session，不含 /task。
/stop 只停本话题。
</topic-isolation>`);
    }
    if (normalContext) {
      parts.push(`<session-state>\n${normalContext}\n</session-state>`);
    }
    this.pendingMessageContext.set(scopeKey, parts.join("\n\n"));
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

  private updateCompactRecoveryState(scopeKey: string, compactCount: number | undefined): boolean {
    if (compactCount === undefined || compactCount <= 0) return false;
    const previous = this.lastCompactCounts.get(scopeKey) ?? 0;
    if (compactCount <= previous) return false;
    this.lastCompactCounts.set(scopeKey, compactCount);
    this.pendingCompactRecovery.add(scopeKey);
    return true;
  }

  private async archiveSession(scopeKey: string, chatId?: string): Promise<SessionEndStatus | false> {
    const resolvedChatId = chatId ?? parseScopeKey(scopeKey).chatId;
    const resolvedThreadId = parseScopeKey(scopeKey).threadId;
    const session = this.chatSessions.get(scopeKey);
    const row = session ? undefined : this.lookupActiveUserSession(resolvedChatId, resolvedThreadId);
    if (!session && !row) {
      this.clearChatRuntimeState(scopeKey);
      return false;
    }

    const sessionId = session?.sessionId ?? row!.id;
    const archivedAt = utcDateTimeForSql(new Date());
    const sessionBackendType = session?.backendType
      ?? normalizeBackend(row?.backend_type ?? undefined)
      ?? this.resolveScopeBackendType(scopeKey);
    let sessionBackend: AgentBackend;
    try {
      sessionBackend = await this.ensureBackend(sessionBackendType);
    } catch (err) {
      sessionBackend = this.backendForType(sessionBackendType);
      this.log.warn("archive falling back to loaded backend", {
        chatId: resolvedChatId,
        sessionId,
        backend: sessionBackendType,
        error: String(err),
      });
    }
    let agentSession = session?.agentSession;
    if (!agentSession) {
      const nativeId = nativeSessionId(row!.agent_session_id);
      const storedBackend = normalizeBackend(row!.backend_type ?? undefined);
      if (!nativeId || !storedBackend) {
        const hasTurns = (row!.turn_count ?? 0) > 0 || (row!.message_count ?? 0) > 0;
        const status: SessionEndStatus = hasTurns ? "archive_failed" : "discarded";
        this.markSessionEnded(sessionId, status, archivedAt);
        this.clearChatRuntimeState(scopeKey);
        this.log.info("ending unloaded session without a resumable backend id", {
          chatId: resolvedChatId,
          sessionId,
          status,
        });
        return status;
      }
      try {
        const archiveModels = this.resolveScopeModels(scopeKey, storedBackend);
        agentSession = await this.createAgentSession({
          workingDirectory: this.workingDirectory,
          reasoningEffort: archiveModels.effort,
          chatId: resolvedChatId,
          scopeKey,
          threadId: resolvedThreadId,
          dbPath: this.dbPath,
          botId: this.botIdentity.platformBotId,
          botName: this.botIdentity.name,
          platform: this.botIdentity.platform,
          model: archiveModels.model,
          agentSessionId: nativeId,
        }, sessionBackend);
      } catch (err) {
        this.markSessionEnded(sessionId, "archive_failed", archivedAt);
        this.clearChatRuntimeState(scopeKey);
        this.log.error("failed to reopen unloaded session for archive", {
          chatId: resolvedChatId,
          sessionId,
          error: String(err),
        });
        return "archive_failed";
      }
    }

    let archiveStatus: SessionEndStatus = "archived";
    try {
      await this.archiveTranscript(resolvedChatId, sessionId, agentSession, sessionBackend, archivedAt);
    } catch (err) {
      if (err instanceof AgentSessionNotStartedError) {
        archiveStatus = "discarded";
        this.log.info("discarding session that never started in backend", { chatId: resolvedChatId, sessionId });
      } else {
        archiveStatus = "archive_failed";
        this.log.error("session transcript archive failed; ending session anyway", {
          chatId: resolvedChatId,
          sessionId,
          error: String(err),
        });
      }
    }

    this.markSessionEnded(sessionId, archiveStatus, archivedAt);
    this.chatSessions.delete(scopeKey);
    this.clearChatRuntimeState(scopeKey);

    await sessionBackend.closeSession(agentSession).catch((err) => {
      this.log.warn("failed to close backend session during archive", {
        chatId: resolvedChatId,
        sessionId,
        error: String(err),
      });
    });

    this.log.info("session ended", { chatId: resolvedChatId, sessionId, status: archiveStatus });
    return archiveStatus;
  }

  private lookupActiveUserSession(chatId: string, threadId?: string): {
    id: string;
    user_id: string | null;
    agent_session_id: string | null;
    backend_type: string | null;
    turn_count: number | null;
    message_count: number | null;
  } | undefined {
    return this.db.prepare(`
      SELECT id, user_id, agent_session_id, backend_type, turn_count, message_count
      FROM sessions
      WHERE chat_id = ? AND status = 'active' AND source = 'user'
        AND (
          (? IS NULL AND thread_id IS NULL)
          OR thread_id = ?
        )
      ORDER BY last_active_at DESC, started_at DESC
      LIMIT 1
    `).get(chatId, threadId ?? null, threadId ?? null) as {
      id: string;
      user_id: string | null;
      agent_session_id: string | null;
      backend_type: string | null;
      turn_count: number | null;
      message_count: number | null;
    } | undefined;
  }

  private resolveNativeAgentSessionId(
    reported: string | null | undefined,
    sessionId: string,
    engineSessionId?: string,
  ): string | null {
    const stored = this.db.prepare("SELECT agent_session_id FROM sessions WHERE id = ?")
      .get(sessionId) as { agent_session_id: string | null } | undefined;
    return nativeSessionId(reported, engineSessionId)
      ?? nativeSessionId(stored?.agent_session_id, engineSessionId)
      ?? null;
  }

  private markSessionEnded(sessionId: string, status: SessionEndStatus, archivedAt: string): void {
    this.db.prepare(`
      UPDATE sessions SET status = ?, ended_at = ?, last_active_at = datetime('now')
      WHERE id = ?
    `).run(status, archivedAt, sessionId);
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

  private async cancelChat(scopeKey: string, chatId?: string): Promise<void> {
    const session = this.chatSessions.get(scopeKey);
    if (!session) return;

    // 先 abort 队列 signal：让 runAgent 的 abortable 立即 reject，run 退出、busy 恢复。
    // 不依赖进程能否被 kill——进程挂起（不在 activeProcesses 或杀不掉）时也能解卡。
    if (this.queue.isBusy(scopeKey)) {
      this.queue.cancel(scopeKey);
    }
    await this.backendForSession(session).cancelSession(session.agentSession);
  }

  private async maybeUnloadScope(scopeKey: string): Promise<void> {
    if (this.queue.isBusy(scopeKey) || this.queue.pendingCount(scopeKey) > 0) return;
    if (this.runtimeState.getActiveRunForScope(scopeKey)) return;
    const session = this.chatSessions.get(scopeKey);
    if (!session) return;
    await this.backendForSession(session).closeSession(session.agentSession).catch((err) => {
      this.log.warn("failed to close session during unload", { scopeKey, error: String(err) });
      return;
    });
    this.chatSessions.delete(scopeKey);
    this.sessionCreations.delete(scopeKey);
    this.triggerMsgIds.delete(scopeKey);
    this.pendingMessageContext.delete(scopeKey);
    this.pendingStableContext.delete(scopeKey);
    this.pendingNewSessionReminder.delete(scopeKey);
    const token = this.chatScheduleTokens.get(scopeKey);
    if (token) this.tokenToScope.delete(token);
    this.chatScheduleTokens.delete(scopeKey);
    this.log.info("session unloaded; database row remains active", { scopeKey });
  }

  // ── Watchdog ─────────────────────────────────────────────

  private resolveWatchdogTarget(scopeKey: string): {
    chatId: string;
    platformChatId: string;
    threadId?: string;
  } | undefined {
    const parsed = parseScopeKey(scopeKey);
    let platformChatId = this.platformChatIds.get(parsed.chatId);
    if (!platformChatId) {
      const row = this.db.prepare("SELECT platform_id FROM chats WHERE id = ?")
        .get(parsed.chatId) as { platform_id: string } | undefined;
      platformChatId = row?.platform_id;
      if (platformChatId) this.platformChatIds.set(parsed.chatId, platformChatId);
    }
    if (!platformChatId) return undefined;
    return {
      chatId: parsed.chatId,
      platformChatId,
      threadId: parsed.threadId,
    };
  }

  /** 向指定 chat 发送系统通知（不走 pipeline 队列） */
  private sendWatchdogNotification(scopeKey: string, text: string): void {
    const target = this.resolveWatchdogTarget(scopeKey);
    if (!target) return;
    const chatId = target.chatId;
    const threadId = target.threadId;
    const strict = Boolean(threadId) || this.isStrictTopicChat(chatId);
    const replyToMsgId = this.runtimeState.getActiveRunForScope(scopeKey)?.replyToPlatformMsgId
      ?? this.chatSessions.get(scopeKey)?.triggerPlatformMsgId
      ?? (threadId ? this.latestThreadPlatformMsgId(chatId, threadId) : undefined);
    if (strict && !replyToMsgId) {
      this.log.warn("watchdog notification skipped in strict topic without reply anchor", {
        chatId,
        scopeKey,
      });
      return;
    }
    const prepared = this.prepareOutboundText(target.platformChatId, text);
    this.sendPreferringReply(
      target.platformChatId,
      "watchdog",
      (anchor) => this.transport.sendReply(
        target.platformChatId,
        prepared.text,
        anchor,
        { replyInThread: strict },
      ),
      () => this.transport.sendText(target.platformChatId, prepared.text),
      replyToMsgId,
      { allowChatFallback: !strict, replyInThread: strict },
    ).then((pmid) => {
      this.storeBotResponse(chatId, prepared.historyText, pmid, "text", threadId);
    }).catch(() => {});
  }

  private sendWatchdogCard(
    scopeKey: string,
    header: string,
    content: string,
    preferReply = false,
    explicitReplyToMsgId?: string,
  ): void {
    const target = this.resolveWatchdogTarget(scopeKey);
    if (!target) return;
    const chatId = target.chatId;
    const threadId = target.threadId;
    const strict = Boolean(threadId) || this.isStrictTopicChat(chatId);
    const replyToMsgId = explicitReplyToMsgId
      ?? this.runtimeState.getActiveRunForScope(scopeKey)?.replyToPlatformMsgId
      ?? this.chatSessions.get(scopeKey)?.triggerPlatformMsgId
      ?? (threadId ? this.latestThreadPlatformMsgId(chatId, threadId) : undefined);
    const prepared = this.prepareOutboundText(target.platformChatId, content);
    this.sendCardKeepingAt(
      target.platformChatId,
      "watchdog-card",
      header,
      prepared.text,
      replyToMsgId,
      strict || preferReply,
      { allowChatFallback: !strict, replyInThread: strict },
    ).then((pmid) => {
      this.storeBotResponse(chatId, prepared.historyText, pmid, "text", threadId);
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
    const now = Date.now();
    for (const [chatId, session] of this.chatSessions) {
      const backend = this.backendForSession(session);
      if (!(backend instanceof CliAgentBackend)) continue;
      const cliAgent = backend;
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
        this.sendWatchdogCard(chatId, header, parts.join("\n\n"), true);
        a.lastLongRunningNotifiedAt = now;
        continue;
      }

      // 工具执行期间可能长时间没有新日志；一小时内先不按“无输出”误报。
      // tool_started 不是持续心跳，超过一小时仍恢复原 idle 策略，避免永久挂住。
      if (a.executingTool && idleMs <= INDEPENDENT_IDLE_KILL_MS) continue;

      // ── 策略 3: 无 completion + 长时间无活动 → 通知，不杀 ──
      if (!a.completionDetected) {
        if (a.notifyCount >= 2) continue;  // 两次封顶，只提醒，不强制中止

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
          this.sendWatchdogCard(chatId, header, content, true);
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
        this.sendWatchdogCard(
          task.scopeKey ?? task.chatId,
          header,
          parts.join("\n\n"),
          false,
          task.replyToMsgId,
        );
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
          this.sendWatchdogCard(
            task.scopeKey ?? task.chatId,
            header,
            content,
            false,
            task.replyToMsgId,
          );
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
          parts.push(unwrapNestedAgentError(event.message.trim()));
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

/** grok 会把瞬时网络失败包成 Internal error: { message, promptUsage... }，只留内层原因。 */
function unwrapNestedAgentError(text: string): string {
  const match = text.match(/^Internal error:\s*(\{[\s\S]*\})\s*$/);
  if (!match?.[1]) return text;
  try {
    const inner = JSON.parse(match[1]) as { message?: unknown };
    if (typeof inner.message === "string" && inner.message.trim()) {
      return inner.message.trim();
    }
  } catch {
    // 内层不是 JSON 就保留原文
  }
  return text;
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

function formatKeepAwakeStatus(status: ReturnType<EngineLifecycle["getKeepAwakeStatus"]>): string {
  if (!status.supported) return "💤 防休眠：当前系统不支持（仅支持 macOS 和 Windows）。";
  if (!status.enabled) return "💤 防休眠：**已关闭**\n用 `/awake on` 开启";
  return `✅ 防休眠：**已开启**（${status.method ?? "系统 API"}）\nEngine 停止或执行 \`/awake off\` 后自动恢复`;
}

/** /awake 状态卡片的 header（带颜色） */
function formatKeepAwakeHeader(status: ReturnType<EngineLifecycle["getKeepAwakeStatus"]>): string {
  if (!status.supported) return "防休眠|grey";
  return status.enabled ? "防休眠|green" : "防休眠|grey";
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
  const result = (err as { result?: { stdout?: string; stderr?: string; exitCode?: number } }).result;
  const lines: string[] = [];
  const output = ((execErr.stdout ?? "") + (execErr.stderr ?? "")).trim()
    || ((result?.stdout ?? "") + (result?.stderr ?? "")).trim();
  if (output) lines.push(output);
  const message = err instanceof Error ? err.message : String(err);
  if (execErr.killed || /timed out/i.test(message)) lines.push(`command timed out after ${SHELL_COMMAND_TIMEOUT_MS}ms`);
  if (execErr.signal) lines.push(`signal: ${execErr.signal}`);

  const exitCode = execErr.code ?? result?.exitCode ?? 1;
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
