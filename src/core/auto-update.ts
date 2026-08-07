/**
 * 自动升级：安全窗口判定 + 升级锁。
 *
 * 核心抽象：UpgradeSafenessSource——各执行链（主会话/Worker/Cron/Loop/Goal）
 * 自己实现「是否空闲」，主流程只做汇总，不感知具体任务类型。
 *
 * 设计见 tasks/niubot-engine/auto-update.md。
 */
import type { Database } from "better-sqlite3";
import { matchesCron } from "./cron.js";
import { listLoopJobs } from "./loop.js";

/** 升级窗口余量（分钟）：窗口结束前不再启动新升级，覆盖升级耗时。 */
export const DEFAULT_UPGRADE_MARGIN_MINUTES = 10;

/** 等待当前 run 收尾的超时上限（毫秒）：长跑任务强制升级，中断靠 continuation 恢复兜底。 */
export const UPGRADE_WAIT_RUN_TIMEOUT_MS = 5 * 60_000;

/** 升级锁在 DB 中的键名。 */
export const UPGRADE_LOCK_KEY = "auto_update_lock";

export interface AutoUpdateConfig {
  enabled: boolean;
  /** 当地时区固定可升级窗口（24h 制） */
  windowStartHour: number;
  windowEndHour: number;
  timezone: string;
  /** 窗口结束前余量（分钟），覆盖升级耗时 */
  marginMinutes: number;
  /** 默认 true：升级成功结果在白天通知窗口汇报；false = 完全静默 */
  notifyOnResult: boolean;
}

export const AUTO_UPDATE_DEFAULTS: Omit<AutoUpdateConfig, "enabled"> = {
  windowStartHour: 2,
  windowEndHour: 5,
  timezone: "Asia/Shanghai",
  marginMinutes: DEFAULT_UPGRADE_MARGIN_MINUTES,
  notifyOnResult: true,
};

/** 各执行链向自动升级暴露的「空闲」协议。 */
export interface UpgradeSafenessSource {
  /** 链路名，用于日志/诊断 */
  readonly name: string;
  /**
   * 是否空闲（safe for upgrade）。
   * 语义：该链路上没有「正在运行」也没有「排队中」的任务，
   *       且未来 upgradeWindowMs 内不会有新触发。
   */
  isIdle(now: number, upgradeWindowMs: number): boolean;
  /** 该链路当前不空闲时的原因（诊断用），空串 = 空闲 */
  describeBlockers(now: number, upgradeWindowMs: number): string;
}

/** 汇总结果。 */
export interface SafenessResult {
  safe: boolean;
  blockers: string[];
}

/** 汇总：所有链路都 idle 才算安全。 */
export function isSafeForUpgrade(
  sources: UpgradeSafenessSource[],
  now: number,
  upgradeWindowMs: number,
): SafenessResult {
  const blockers: string[] = [];
  for (const source of sources) {
    if (!source.isIdle(now, upgradeWindowMs)) {
      blockers.push(`${source.name}: ${source.describeBlockers(now, upgradeWindowMs)}`);
    }
  }
  return { safe: blockers.length === 0, blockers };
}

// ─── 各链路 Source 实现 ───────────────────────────────────────────

export interface MainRunStateQuery {
  /** 全局进行中的 run 数量（RuntimeStateStore.getPipelineHealth().inflightRunIds.length） */
  inflightRunCount: () => number;
  /** 所有 chat 的队列积压消息总数 */
  pendingMessageCount: () => number;
}

/** 主会话 run 链路：无 inflight + 无队列积压。 */
export function mainRunSource(state: MainRunStateQuery): UpgradeSafenessSource {
  return {
    name: "main-session",
    isIdle: () => state.inflightRunCount() === 0 && state.pendingMessageCount() === 0,
    describeBlockers: () => {
      const parts: string[] = [];
      const inflight = state.inflightRunCount();
      const pending = state.pendingMessageCount();
      if (inflight > 0) parts.push(`${inflight} 个 run 进行中`);
      if (pending > 0) parts.push(`${pending} 条消息排队`);
      return parts.join("；");
    },
  };
}

export interface WorkerStateQuery {
  /** worker_jobs 非终态（queued/running/cancelling）数量 */
  nonTerminalJobCount: () => number;
  /** agent_continuations 非终态（pending/claimed）数量 */
  nonTerminalContinuationCount: () => number;
}

/** Worker 链路：无进行中/排队 job，无未完成 continuation。 */
export function workerSource(state: WorkerStateQuery): UpgradeSafenessSource {
  return {
    name: "worker",
    isIdle: () => state.nonTerminalJobCount() === 0 && state.nonTerminalContinuationCount() === 0,
    describeBlockers: () => {
      const parts: string[] = [];
      const jobs = state.nonTerminalJobCount();
      const conts = state.nonTerminalContinuationCount();
      if (jobs > 0) parts.push(`${jobs} 个 job 未完成`);
      if (conts > 0) parts.push(`${conts} 个 continuation 未交付`);
      return parts.join("；");
    },
  };
}

export interface GoalStateQuery {
  activeGoalCount: () => number;
}

/** Goal 链路：无活跃 Goal 循环。 */
export function goalSource(state: GoalStateQuery): UpgradeSafenessSource {
  return {
    name: "goal",
    isIdle: () => state.activeGoalCount() === 0,
    describeBlockers: () => (state.activeGoalCount() > 0 ? `${state.activeGoalCount()} 个 Goal 循环进行中` : ""),
  };
}

export interface CronStateQuery {
  /** 返回所有 active/running cron 任务的 cronExpr/runAt/timezone */
  listJobs: () => Array<{ cronExpr: string | null; runAt: string | null; timezone: string | null }>;
}

/** Cron 链路：无 running，且未来 upgradeWindowMs 内无到点触发。 */
export function cronSource(db: Database, query?: CronStateQuery): UpgradeSafenessSource {
  const list = query?.listJobs ?? (() => {
    const rows = db.prepare("SELECT cron_expr, run_at, timezone FROM cron_jobs WHERE status IN ('active', 'running')")
      .all() as Array<{ cron_expr: string | null; run_at: string | null; timezone: string | null }>;
    return rows.map((r) => ({ cronExpr: r.cron_expr, runAt: r.run_at, timezone: r.timezone }));
  });
  const willTriggerIn = (now: number, windowMs: number): boolean => {
    const horizon = new Date(now + windowMs);
    const nowDate = new Date(now);
    for (const job of list()) {
      if (job.cronExpr) {
        // 未来窗口内任一时刻命中 cron 表达式即视为会触发（分钟粒度探测）
        for (let t = nowDate.getTime(); t <= horizon.getTime(); t += 60_000) {
          if (matchesCron(job.cronExpr, new Date(t), job.timezone ?? "Asia/Shanghai")) return true;
        }
      }
      if (job.runAt) {
        const runAt = new Date(job.runAt.endsWith("Z") ? job.runAt : `${job.runAt}Z`);
        if (runAt.getTime() > now && runAt.getTime() <= horizon.getTime()) return true;
      }
    }
    return false;
  };
  return {
    name: "cron",
    isIdle: (now, windowMs) => !willTriggerIn(now, windowMs),
    describeBlockers: (now, windowMs) => (willTriggerIn(now, windowMs) ? "未来窗口内有 cron 触发" : ""),
  };
}

export interface LoopStateQuery {
  /** 返回所有 loop 任务的运行状态和触发信息 */
  listJobs: () => Array<{ status: string; nextRunAt: string | null }>;
}

/** Loop 链路：无 running/queued，且未来窗口内无触发。 */
export function loopSource(db: Database, query?: LoopStateQuery): UpgradeSafenessSource {
  const list = query?.listJobs ?? (() => {
    const rows = db.prepare("SELECT status, next_run_at FROM loop_jobs WHERE status IN ('active', 'queued', 'running', 'paused')")
      .all() as Array<{ status: string; next_run_at: string | null }>;
    return rows.map((r) => ({ status: r.status, nextRunAt: r.next_run_at }));
  });
  const active = (now: number, windowMs: number): boolean => {
    const horizon = new Date(now + windowMs);
    for (const job of list()) {
      if (job.status === "running" || job.status === "queued") return true;
      if (job.status === "active" && job.nextRunAt) {
        const next = new Date(job.nextRunAt.endsWith("Z") ? job.nextRunAt : `${job.nextRunAt}Z`);
        if (next.getTime() > now && next.getTime() <= horizon.getTime()) return true;
      }
    }
    return false;
  };
  return {
    name: "loop",
    isIdle: (now, windowMs) => !active(now, windowMs),
    describeBlockers: (now, windowMs) => (active(now, windowMs) ? "未来窗口内有 loop 触发或运行中" : ""),
  };
}

// ─── 固定窗口 ─────────────────────────────────────────────────────

/** 本地时区小时是否在 [startHour, endHour) 窗口内（跨天支持）。 */
export function isInUpgradeWindow(date: Date, config: AutoUpdateConfig): boolean {
  const { windowStartHour, windowEndHour, timezone } = config;
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: timezone,
    }).format(date),
  );
  if (windowStartHour <= windowEndHour) {
    return hour >= windowStartHour && hour < windowEndHour;
  }
  // 跨天（如 22:00 → 02:00）
  return hour >= windowStartHour || hour < windowEndHour;
}

// ─── 升级锁（DB 持久化）───────────────────────────────────────────

/** 读取升级锁；返回 null 表示无锁。 */
export function readUpgradeLock(
  db: Database,
): { lockedAt: string; version: string | null } | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(UPGRADE_LOCK_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as { lockedAt: string; version: string | null };
  } catch {
    return null;
  }
}

/** 写入升级锁（幂等：已有锁不覆盖，返回 false）。 */
export function acquireUpgradeLock(db: Database, version: string | null): boolean {
  const existing = readUpgradeLock(db);
  if (existing) return false;
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(UPGRADE_LOCK_KEY, JSON.stringify({ lockedAt: new Date().toISOString(), version }));
  return true;
}

/** 解除升级锁。 */
export function releaseUpgradeLock(db: Database): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(UPGRADE_LOCK_KEY);
}
