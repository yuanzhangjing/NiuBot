/**
 * 自动升级：安全窗口判定 + 升级锁。
 *
 * 核心抽象：UpgradeSafenessSource——各执行链（主会话/Cron/Loop/Goal）
 * 自己实现「是否空闲」，主流程只做汇总，不感知具体任务类型。
 *
 * 设计见 tasks/niubot-engine/auto-update.md。
 */
import type { Database } from "better-sqlite3";
import { matchesCron } from "./cron.js";
import { listLoopJobs } from "./loop.js";
import { getZonedDateTimeParts } from "../tz.js";

/** 升级窗口余量（分钟）：窗口结束前不再启动新升级，覆盖升级耗时。 */
export const DEFAULT_UPGRADE_MARGIN_MINUTES = 10;

/** 等待当前 run 收尾的超时上限（毫秒）：长跑任务强制升级，中断靠 continuation 恢复兜底。 */
export const UPGRADE_WAIT_RUN_TIMEOUT_MS = 5 * 60_000;

/**
 * cron/loop 未来触发检查窗口（毫秒）：覆盖「升级执行耗时 + 余量」。
 * 不沿用整个可升级窗口——升级只需几分钟，用 30 分钟窗口即可避开
 * 真正会撞上升级的 cron，同时不因窗口内远端 cron 白白顺延。
 */
export const UPGRADE_SAFENESS_WINDOW_MS = 30 * 60_000;

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
        const runAt = parseSqlUtc(job.runAt);
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
        const next = parseSqlUtc(job.nextRunAt);
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

/** 解析 SQLite UTC datetime（YYYY-MM-DD HH:MM:SS 或带 T）为 Date。 */
function parseSqlUtc(value: string): Date {
  return new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}


/** 本地时区小时是否在 [startHour, endHour) 窗口内（跨天支持）。 */
export function isInUpgradeWindow(date: Date, config: AutoUpdateConfig): boolean {
  const { windowStartHour, windowEndHour, timezone } = config;
  const hour = getZonedDateTimeParts(date, timezone).hour;
  if (windowStartHour <= windowEndHour) {
    return hour >= windowStartHour && hour < windowEndHour;
  }
  // 跨天（如 22:00 → 02:00）
  return hour >= windowStartHour || hour < windowEndHour;
}

/** 距窗口结束的分钟数（若当前在窗口外则返回 0）。 */
export function minutesUntilUpgradeWindowEnd(date: Date, config: AutoUpdateConfig): number {
  if (!isInUpgradeWindow(date, config)) return 0;
  const { windowEndHour, timezone } = config;
  const { hour, minute, second } = getZonedDateTimeParts(date, timezone);
  let minutes = (windowEndHour - hour) * 60 - minute - second / 60;
  if (minutes < 0) minutes += 24 * 60; // 跨天窗口：已过午夜，补到次日结束
  return minutes;
}
