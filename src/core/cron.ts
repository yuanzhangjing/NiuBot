/**
 * Cron scheduler — runs scheduled tasks at specified intervals.
 * Jobs are stored in the cron_jobs DB table and executed by sending prompts
 * to the agent via the pipeline.
 */

import type Database from "better-sqlite3";
import { createLogger } from "../logger.js";
import {
  getZonedDateTimeParts,
  TZ,
  userDateTimeToUtcSql,
  utcDateTimeForSql,
} from "../tz.js";
import { assertChatAccess, type ChatAccessContext } from "./access.js";

const log = createLogger("cron");

/** Check interval: 60 seconds */
const CHECK_INTERVAL_MS = 60_000;
export const MAX_ACTIVE_CRON_JOBS_PER_CHAT = 20;
export const DEFAULT_MAX_CONCURRENT_CRON_RUNS = 4;
export const CRON_FAILURE_LIMIT = 3;

interface CronJob {
  id: number;
  chatId: string;
  creatorUserId: string;
  cronExpr: string | null;
  runAt: string | null;
  prompt: string;
  description: string;
  maxTimes: number | null;
  untilTime: string | null;
  runCount: number;
  status: string;
  lastRunAt: string | null;
  timezone: string;
  claimedAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

interface RawCronRow {
  id: number;
  chat_id: string;
  creator_user_id: string;
  cron_expr: string | null;
  run_at: string | null;
  prompt: string;
  description: string;
  max_times: number | null;
  until_time: string | null;
  run_count: number;
  status: string;
  last_run_at: string | null;
  created_at: string;
  timezone: string | null;
  claimed_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
}

function toJob(r: RawCronRow): CronJob {
  return {
    id: r.id,
    chatId: r.chat_id,
    creatorUserId: r.creator_user_id,
    cronExpr: r.cron_expr,
    runAt: r.run_at,
    prompt: r.prompt,
    description: r.description,
    maxTimes: r.max_times,
    untilTime: r.until_time,
    runCount: r.run_count,
    status: r.status,
    lastRunAt: r.last_run_at,
    timezone: r.timezone ?? TZ,
    claimedAt: r.claimed_at,
    lastError: r.last_error,
    consecutiveFailures: r.consecutive_failures,
  };
}

export type CronExecutor = (chatId: string, userId: string, prompt: string, description: string) => Promise<void>;
export type CronFailureReporter = (
  chatId: string,
  description: string,
  error: string,
  paused: boolean,
) => Promise<void> | void;

export interface CronSchedulerOptions {
  maxConcurrent?: number;
  reportFailure?: CronFailureReporter;
}

export class CronScheduler {
  private db: Database.Database;
  private executor: CronExecutor;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** 当前 tick 的 Promise；stop() 等待它结束，保证 cron_jobs 更新在 DB 关闭前完成。 */
  private currentTick: Promise<void> | null = null;
  private stopping = false;
  private readonly maxConcurrent: number;
  private readonly reportFailure?: CronFailureReporter;

  constructor(db: Database.Database, executor: CronExecutor, options: CronSchedulerOptions = {}) {
    this.db = db;
    this.executor = executor;
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_CRON_RUNS));
    this.reportFailure = options.reportFailure;
    migrateLegacyCronTimezones(db);
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    recoverInterruptedCronJobs(this.db);
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.currentTick = this.tick().catch((err) => {
        log.error("cron tick error", { error: String(err) });
      }).finally(() => {
        this.running = false;
        this.currentTick = null;
      });
    }, CHECK_INTERVAL_MS);
    log.info("cron scheduler started");
  }

  /** 停止调度并等待当前 tick 结束（tick 内会更新 cron_jobs，必须在 DB 关闭前完成）。 */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.currentTick;
    log.info("cron scheduler stopped");
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const nowStr = utcDateTimeForSql(now);
    const jobs = claimDueCronJobs(this.db, now);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(this.maxConcurrent, jobs.length) }, async () => {
      while (nextIndex < jobs.length) {
        const job = jobs[nextIndex++]!;
        if (this.stopping) {
          releaseCronClaim(this.db, job);
          continue;
        }
        await this.executeClaimedJob(job, nowStr);
      }
    });
    await Promise.all(workers);
  }

  private async executeClaimedJob(job: CronJob, nowStr: string): Promise<void> {
    log.info("executing cron job", { id: job.id, desc: job.description });
    try {
      await this.executor(job.chatId, job.creatorUserId, job.prompt, job.description);
      const nextCount = job.runCount + 1;
      const completed = !!job.runAt || (job.maxTimes !== null && nextCount >= job.maxTimes);
      this.db.prepare(`
        UPDATE cron_jobs
        SET status = ?, run_count = ?, last_run_at = ?, claimed_at = NULL,
            last_error = NULL, consecutive_failures = 0
        WHERE id = ? AND status = 'running'
      `).run(completed ? "completed" : "active", nextCount, nowStr, job.id);
    } catch (err) {
      const error = String(err).slice(0, 2_000);
      const failures = job.consecutiveFailures + 1;
      const paused = failures >= CRON_FAILURE_LIMIT;
      const changed = this.db.prepare(`
        UPDATE cron_jobs
        SET status = ?, claimed_at = NULL, last_run_at = ?, last_error = ?, consecutive_failures = ?
        WHERE id = ? AND status = 'running'
      `).run(paused ? "paused" : "active", job.lastRunAt, error, failures, job.id).changes;
      log.error("cron job execution failed", { id: job.id, error, failures, paused });
      if (changed === 1) {
        await Promise.resolve(this.reportFailure?.(job.chatId, job.description || job.prompt.slice(0, 40), error, paused))
          .catch((reportError) => log.warn("failed to report cron failure", { id: job.id, error: String(reportError) }));
      }
    }
  }
}

/** Restore claims left behind by a stopped process. Recurring jobs keep the claim minute
 * in last_run_at, so they do not repeat within that minute after restart. */
export function recoverInterruptedCronJobs(db: Database.Database): number {
  const restored = db.prepare(`
    UPDATE cron_jobs
    SET status = 'active', claimed_at = NULL,
        last_error = COALESCE(last_error, 'Engine restarted during Cron execution')
    WHERE status = 'running'
  `).run().changes;
  if (restored > 0) log.info("recovered interrupted cron jobs", { restored });
  return restored;
}

function releaseCronClaim(db: Database.Database, job: CronJob): boolean {
  return db.prepare(`
    UPDATE cron_jobs SET status = 'active', claimed_at = NULL, last_run_at = ?
    WHERE id = ? AND status = 'running'
  `).run(job.lastRunAt, job.id).changes === 1;
}

/** Select and atomically claim every job due at this instant. */
export function claimDueCronJobs(db: Database.Database, now: Date = new Date()): CronJob[] {
  const nowStr = utcDateTimeForSql(now);
  const claim = db.transaction(() => {
    const rows = db.prepare("SELECT * FROM cron_jobs WHERE status = 'active' ORDER BY id").all() as RawCronRow[];
    const updateStatus = db.prepare("UPDATE cron_jobs SET status = 'completed' WHERE id = ? AND status = 'active'");
    const claimJob = db.prepare(`
      UPDATE cron_jobs SET status = 'running', claimed_at = ?, last_run_at = ?
      WHERE id = ? AND status = 'active'
    `);
    const claimed: CronJob[] = [];
    for (const raw of rows) {
      const job = toJob(raw);
      if (job.maxTimes !== null && job.runCount >= job.maxTimes) {
        updateStatus.run(job.id);
        continue;
      }
      if (job.untilTime && nowStr > normalizeDatetime(job.untilTime)) {
        updateStatus.run(job.id);
        continue;
      }

      let shouldRun = false;
      if (job.runAt) {
        shouldRun = nowStr >= normalizeDatetime(job.runAt) && job.runCount === 0;
      } else if (job.cronExpr) {
        shouldRun = matchesCron(job.cronExpr, now, job.timezone);
        if (shouldRun && job.lastRunAt) {
          shouldRun = normalizeDatetime(job.lastRunAt).slice(0, 16) !== nowStr.slice(0, 16);
        }
      }
      if (shouldRun && claimJob.run(nowStr, nowStr, job.id).changes === 1) {
        claimed.push({ ...job, status: "running", claimedAt: nowStr });
      }
    }
    return claimed;
  });
  return claim();
}

/** Add a cron job */
export function addCronJob(
  db: Database.Database,
  opts: {
    chatId: string;
    creatorUserId: string;
    cronExpr?: string;
    runAt?: string;
    prompt: string;
    description?: string;
    maxTimes?: number;
    untilTime?: string;
    timeZone?: string;
  },
): number {
  migrateLegacyCronTimezones(db);
  const prompt = opts.prompt.trim();
  if (!prompt) throw new Error("Cron 任务不能为空");
  if (opts.maxTimes !== undefined && (!Number.isInteger(opts.maxTimes) || opts.maxTimes <= 0)) {
    throw new Error("Cron 次数必须是正整数");
  }
  if ((opts.cronExpr ? 1 : 0) + (opts.runAt ? 1 : 0) !== 1) {
    throw new Error("must provide exactly one of cronExpr or runAt");
  }
  if (opts.runAt && opts.maxTimes !== undefined && opts.maxTimes !== 1) {
    throw new Error("一次性 Cron 只能执行 1 次");
  }
  if (opts.cronExpr) validateCronExpression(opts.cronExpr);
  const timeZone = opts.timeZone ?? TZ;
  const runAt = opts.runAt ? userDateTimeToUtcSql(opts.runAt, timeZone) : null;
  const untilTime = opts.untilTime ? userDateTimeToUtcSql(opts.untilTime, timeZone) : null;

  // Validate: runAt must be in the future.
  if (runAt) {
    const runAtTime = new Date(runAt.replace(" ", "T") + "Z");
    if (runAtTime.getTime() <= Date.now()) {
      throw new Error("run_at must be in the future");
    }
  }

  // Validate: untilTime must be in the future and not earlier than a one-time runAt,
  // otherwise the job is created only to be marked completed on the next tick.
  if (untilTime) {
    const untilTimeDate = new Date(untilTime.replace(" ", "T") + "Z");
    if (untilTimeDate.getTime() <= Date.now()) {
      throw new Error("until_time must be in the future");
    }
    if (runAt && untilTime < runAt) {
      throw new Error("until_time must not be earlier than run_at");
    }
  }

  const insert = db.transaction(() => {
    const activeCount = db.prepare(`
      SELECT COUNT(*) AS count FROM cron_jobs
      WHERE chat_id = ? AND status IN ('active', 'running', 'paused')
    `).get(opts.chatId) as { count: number };
    if (activeCount.count >= MAX_ACTIVE_CRON_JOBS_PER_CHAT) {
      throw new Error(`每个聊天最多保留 ${MAX_ACTIVE_CRON_JOBS_PER_CHAT} 个 Cron`);
    }
    const result = db.prepare(`
      INSERT INTO cron_jobs (
        chat_id, creator_user_id, cron_expr, run_at, prompt, description, max_times, until_time, timezone
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      opts.chatId,
      opts.creatorUserId,
      opts.cronExpr ?? null,
      runAt,
      prompt,
      opts.description ?? "",
      opts.maxTimes ?? null,
      untilTime,
      timeZone,
    );
    return Number(result.lastInsertRowid);
  });
  return insert();
}

/** Validate the five-field Cron subset implemented by matchesCron(). */
export function validateCronExpression(expression: string): void {
  const fields = expression.trim().split(/\s+/);
  const ranges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  if (fields.length !== ranges.length) {
    throw new Error("cron expression must contain exactly 5 fields");
  }
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    const [minimum, maximum] = ranges[index]!;
    for (const part of field.split(",")) {
      if (part === "*") continue;
      const step = /^\*\/(\d+)$/.exec(part);
      if (step) {
        const value = Number(step[1]);
        if (value >= 1 && value <= maximum - minimum + 1) continue;
        throw new Error(`invalid cron field: ${field}`);
      }
      const range = /^(\d+)-(\d+)$/.exec(part);
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        if (start >= minimum && end <= maximum && start <= end) continue;
        throw new Error(`invalid cron field: ${field}`);
      }
      if (/^\d+$/.test(part)) {
        const value = Number(part);
        if (value >= minimum && value <= maximum) continue;
      }
      throw new Error(`unsupported cron field: ${field}`);
    }
  }
}

/** List active cron jobs for a chat */
export function listCronJobs(
  db: Database.Database,
  chatId?: string,
): Array<CronJob & { createdAt: string }> {
  migrateLegacyCronTimezones(db);
  let sql = "SELECT * FROM cron_jobs WHERE status IN ('active', 'running', 'paused')";
  const params: unknown[] = [];
  if (chatId) {
    sql += " AND chat_id = ?";
    params.push(chatId);
  }
  sql += " ORDER BY id";
  const rows = db.prepare(sql).all(...params) as RawCronRow[];
  return rows.map((r) => ({ ...toJob(r), createdAt: r.created_at }));
}

/** List active cron jobs visible from the current access context */
export function listCronJobsForAccess(
  db: Database.Database,
  options: ChatAccessContext & { targetChatId?: string },
): Array<CronJob & { createdAt: string }> {
  if (options.targetChatId) {
    assertChatAccess({
      currentChatId: options.currentChatId,
      chatType: options.chatType,
      targetChatId: options.targetChatId,
    });
  } else if (options.chatType === "group") {
    if (!options.currentChatId) {
      throw new Error("NIUBOT_CHAT_ID not set");
    }
    return listCronJobs(db, options.currentChatId);
  }
  return listCronJobs(db, options.targetChatId);
}

/** Delete a cron job */
export function deleteCronJob(db: Database.Database, id: number): boolean {
  const result = db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
  return result.changes > 0;
}

/** Delete a cron job after checking chat visibility and creator ownership. */
export function deleteCronJobForAccess(
  db: Database.Database,
  id: number,
  ctx: ChatAccessContext & { userId?: string },
): CronJob & { createdAt: string } | undefined {
  const job = getCronJob(db, id);
  if (!job) return undefined;
  assertChatAccess({
    currentChatId: ctx.currentChatId,
    chatType: ctx.chatType,
    targetChatId: job.chatId,
  });
  if (!ctx.userId) {
    throw new Error("NIUBOT_USER_ID not set");
  }
  if (job.creatorUserId !== ctx.userId) {
    throw new Error("can only delete your own cron jobs");
  }
  deleteCronJob(db, id);
  return job;
}

/** Get a cron job by ID */
export function getCronJob(db: Database.Database, id: number): (CronJob & { createdAt: string }) | undefined {
  migrateLegacyCronTimezones(db);
  const row = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(id) as RawCronRow | undefined;
  return row ? { ...toJob(row), createdAt: row.created_at } : undefined;
}

/**
 * Simple cron expression matcher.
 * Supports: minute hour day month weekday
 * Each field: number, *, or comma-separated values
 */
function matchesCron(expr: string, date: Date, timeZone: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return false;

  const local = getZonedDateTimeParts(date, timeZone);
  if (!matchesCronField(parts[0]!, local.minute, 0)) return false;
  if (!matchesCronField(parts[1]!, local.hour, 0)) return false;
  if (!matchesCronField(parts[3]!, local.month, 1)) return false;

  const dayOfMonthMatches = matchesCronField(parts[2]!, local.day, 1);
  const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
  const weekdayMatches = matchesCronField(parts[4]!, weekday, 0)
    || (weekday === 0 && matchesCronField(parts[4]!, 7, 0));
  const dayOfMonthAny = parts[2] === "*";
  const weekdayAny = parts[4] === "*";
  if (dayOfMonthAny) return weekdayMatches;
  if (weekdayAny) return dayOfMonthMatches;
  return dayOfMonthMatches || weekdayMatches;
}

function matchesCronField(field: string, value: number, minimum: number): boolean {
  for (const part of field.split(",")) {
    if (part === "*") return true;
    if (part.startsWith("*/")) {
      const step = Number(part.slice(2));
      if (!Number.isNaN(step) && step > 0 && (value - minimum) % step === 0) return true;
      continue;
    }
    if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      if (value >= start! && value <= end!) return true;
    } else {
      if (Number(part) === value) return true;
    }
  }
  return false;
}

/** Normalize datetime string: replace 'T' separator with space for consistent comparison */
function normalizeDatetime(s: string): string {
  return s.replace("T", " ");
}

/** Convert pre-v16 cron timestamps, which were stored as local wall-clock text, to UTC once. */
export function migrateLegacyCronTimezones(db: Database.Database, timeZone: string = TZ): number {
  const rows = db.prepare(`
    SELECT id, run_at, until_time, last_run_at
    FROM cron_jobs
    WHERE timezone IS NULL OR timezone = ''
  `).all() as Array<{
    id: number;
    run_at: string | null;
    until_time: string | null;
    last_run_at: string | null;
  }>;
  if (rows.length === 0) return 0;

  const update = db.prepare(`
    UPDATE cron_jobs
    SET run_at = ?, until_time = ?, last_run_at = ?, timezone = ?
    WHERE id = ?
  `);
  const migrate = db.transaction(() => {
    for (const row of rows) {
      update.run(
        row.run_at ? userDateTimeToUtcSql(row.run_at, timeZone) : null,
        row.until_time ? userDateTimeToUtcSql(row.until_time, timeZone) : null,
        row.last_run_at ? userDateTimeToUtcSql(row.last_run_at, timeZone) : null,
        timeZone,
        row.id,
      );
    }
  });
  migrate();
  log.info("migrated legacy cron timestamps to UTC", { count: rows.length, timezone: timeZone });
  return rows.length;
}
