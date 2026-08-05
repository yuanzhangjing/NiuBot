/**
 * Chat-scoped loop scheduling.
 *
 * The scheduler only claims due rows and hands their IDs to Pipeline. Pipeline
 * owns Agent execution and settles each run after the response is delivered.
 */

import type Database from "better-sqlite3";
import { createLogger } from "../logger.js";
import { utcDateTimeForSql } from "../tz.js";
import { assertChatAccess, type ChatAccessContext } from "./access.js";

const log = createLogger("loop");

export const MIN_LOOP_INTERVAL_SECONDS = 60;
export const DEFAULT_LOOP_DURATION_SECONDS = 24 * 60 * 60;
export const MAX_LOOP_DURATION_SECONDS = 7 * 24 * 60 * 60;
export const MAX_ACTIVE_LOOPS_PER_CHAT = 3;
export const LOOP_FAILURE_LIMIT = 3;
const CHECK_INTERVAL_MS = 1_000;

export type LoopStatus = "active" | "queued" | "running" | "paused" | "completed" | "cancelled";

export interface LoopJob {
  id: number;
  chatId: string;
  creatorUserId: string;
  intervalSeconds: number;
  prompt: string;
  maxTimes: number | null;
  untilTime: string;
  runCount: number;
  status: LoopStatus;
  nextRunAt: string;
  lastRunAt: string | null;
  runStartedAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

interface RawLoopRow {
  id: number;
  chat_id: string;
  creator_user_id: string;
  interval_seconds: number;
  prompt: string;
  max_times: number | null;
  until_time: string;
  run_count: number;
  status: LoopStatus;
  next_run_at: string;
  last_run_at: string | null;
  run_started_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

function toLoopJob(row: RawLoopRow): LoopJob {
  return {
    id: row.id,
    chatId: row.chat_id,
    creatorUserId: row.creator_user_id,
    intervalSeconds: row.interval_seconds,
    prompt: row.prompt,
    maxTimes: row.max_times,
    untilTime: row.until_time,
    runCount: row.run_count,
    status: row.status,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    runStartedAt: row.run_started_at,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function addSeconds(date: Date, seconds: number): string {
  return utcDateTimeForSql(new Date(date.getTime() + seconds * 1_000));
}

export function parseLoopDuration(value: string): number | undefined {
  const match = /^(\d+)(s|m|h|d)$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;
  const unitSeconds: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400 };
  const seconds = amount * unitSeconds[match[2]!.toLowerCase()]!;
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

export function formatLoopInterval(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} 天`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

export function addLoopJob(
  db: Database.Database,
  options: {
    chatId: string;
    creatorUserId: string;
    intervalSeconds: number;
    prompt: string;
    maxTimes?: number;
    durationSeconds?: number;
    /** 覆盖 next_run_at（UTC SQL 时间），用于一次性定时/延迟任务；缺省为 now + interval */
    runAt?: string;
    now?: Date;
  },
): number {
  const now = options.now ?? new Date();
  const prompt = options.prompt.trim();
  if (!prompt) throw new Error("Loop 任务不能为空");
  if (!Number.isInteger(options.intervalSeconds) || options.intervalSeconds < MIN_LOOP_INTERVAL_SECONDS) {
    throw new Error(`Loop 最小间隔是 ${formatLoopInterval(MIN_LOOP_INTERVAL_SECONDS)}`);
  }
  if (options.maxTimes !== undefined && (!Number.isInteger(options.maxTimes) || options.maxTimes <= 0)) {
    throw new Error("Loop 次数必须是正整数");
  }
  const durationSeconds = options.durationSeconds ?? DEFAULT_LOOP_DURATION_SECONDS;
  if (!Number.isInteger(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_LOOP_DURATION_SECONDS) {
    throw new Error(`Loop 最长只能运行 ${formatLoopInterval(MAX_LOOP_DURATION_SECONDS)}`);
  }
  if (durationSeconds < options.intervalSeconds) {
    throw new Error("Loop 运行时限不能短于执行间隔");
  }

  const activeCount = db.prepare(`
    SELECT COUNT(*) AS count FROM loop_jobs
    WHERE chat_id = ? AND status IN ('active', 'queued', 'running', 'paused')
  `).get(options.chatId) as { count: number };
  if (activeCount.count >= MAX_ACTIVE_LOOPS_PER_CHAT) {
    throw new Error(`每个聊天最多保留 ${MAX_ACTIVE_LOOPS_PER_CHAT} 个 Loop`);
  }

  const result = db.prepare(`
    INSERT INTO loop_jobs (
      chat_id, creator_user_id, interval_seconds, prompt,
      max_times, until_time, next_run_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    options.chatId,
    options.creatorUserId,
    options.intervalSeconds,
    prompt,
    options.maxTimes ?? null,
    addSeconds(now, durationSeconds),
    options.runAt ?? addSeconds(now, options.intervalSeconds),
  );
  return Number(result.lastInsertRowid);
}

export function getLoopJob(db: Database.Database, id: number): LoopJob | undefined {
  const row = db.prepare("SELECT * FROM loop_jobs WHERE id = ?").get(id) as RawLoopRow | undefined;
  return row ? toLoopJob(row) : undefined;
}

export function listLoopJobs(db: Database.Database, chatId: string): LoopJob[] {
  const rows = db.prepare(`
    SELECT * FROM loop_jobs
    WHERE chat_id = ? AND status IN ('active', 'queued', 'running', 'paused')
    ORDER BY id
  `).all(chatId) as RawLoopRow[];
  return rows.map(toLoopJob);
}

export function cancelLoopJobForAccess(
  db: Database.Database,
  id: number,
  context: ChatAccessContext & { userId?: string },
): LoopJob | undefined {
  const job = getLoopJob(db, id);
  if (!job || job.status === "completed" || job.status === "cancelled") return undefined;
  assertChatAccess({
    currentChatId: context.currentChatId,
    chatType: context.chatType,
    targetChatId: job.chatId,
  });
  if (!context.userId) throw new Error("NIUBOT_USER_ID not set");
  if (job.creatorUserId !== context.userId) throw new Error("can only stop your own loop jobs");
  db.prepare(`
    UPDATE loop_jobs
    SET status = 'cancelled', updated_at = datetime('now')
    WHERE id = ? AND status IN ('active', 'queued', 'running', 'paused')
  `).run(id);
  return job;
}

/** Restore rows whose in-memory queue/Agent run disappeared with the process. */
export function recoverInterruptedLoopJobs(db: Database.Database, now: Date = new Date()): number {
  const nowStr = utcDateTimeForSql(now);
  const restored = db.prepare(`
      UPDATE loop_jobs
      SET status = 'active', next_run_at = ?, run_started_at = NULL,
          last_error = 'Engine restarted during Loop execution',
          updated_at = ?
      WHERE status IN ('queued', 'running')
    `).run(nowStr, nowStr).changes;
  if (restored > 0) {
    log.info("recovered loop jobs", { restored });
  }
  return restored;
}

/** Atomically claim all currently due loops. */
export function claimDueLoopJobs(db: Database.Database, now: Date = new Date()): LoopJob[] {
  const nowStr = utcDateTimeForSql(now);
  const claim = db.transaction(() => {
    // Boundaries are checked before claiming so expired loops never enter the queue.
    db.prepare(`
      UPDATE loop_jobs
      SET status = 'completed', updated_at = ?
      WHERE status = 'active'
        AND (until_time < ? OR (max_times IS NOT NULL AND run_count >= max_times))
    `).run(nowStr, nowStr);

    const rows = db.prepare(`
      SELECT * FROM loop_jobs
      WHERE status = 'active' AND next_run_at <= ? AND until_time >= ?
        AND (max_times IS NULL OR run_count < max_times)
      ORDER BY next_run_at, id
    `).all(nowStr, nowStr) as RawLoopRow[];
    const update = db.prepare(`
      UPDATE loop_jobs SET status = 'queued', updated_at = ?
      WHERE id = ? AND status = 'active'
    `);
    const claimed: LoopJob[] = [];
    for (const row of rows) {
      if (update.run(nowStr, row.id).changes === 1) {
        claimed.push(toLoopJob({ ...row, status: "queued", updated_at: nowStr }));
      }
    }
    return claimed;
  });
  return claim();
}

/** Atomically start a queued Loop turn. */
export function startLoopRun(
  db: Database.Database,
  id: number,
  now: Date = new Date(),
): LoopJob | undefined {
  const nowStr = utcDateTimeForSql(now);
  const start = db.transaction(() => {
    db.prepare(`
      UPDATE loop_jobs SET status = 'completed', updated_at = ?
      WHERE id = ? AND status = 'queued'
        AND (until_time < ? OR (max_times IS NOT NULL AND run_count >= max_times))
    `).run(nowStr, id, nowStr);
    return db.prepare(`
      UPDATE loop_jobs
      SET status = 'running', run_started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'queued'
        AND until_time >= ? AND (max_times IS NULL OR run_count < max_times)
    `).run(nowStr, nowStr, id, nowStr).changes;
  });
  return start() === 1 ? getLoopJob(db, id) : undefined;
}

export function completeLoopRun(
  db: Database.Database,
  id: number,
  result: { success: boolean; error?: string; cancelled?: boolean; now?: Date },
): LoopJob | undefined {
  const job = getLoopJob(db, id);
  if (!job || job.status !== "running") return job;
  const now = result.now ?? new Date();
  const nowStr = utcDateTimeForSql(now);

  if (result.cancelled) {
    db.prepare(`
      UPDATE loop_jobs
      SET status = 'active', next_run_at = ?, run_started_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(addSeconds(now, job.intervalSeconds), nowStr, id);
    return getLoopJob(db, id);
  }

  if (result.success) {
    const nextCount = job.runCount + 1;
    const completed = (job.maxTimes !== null && nextCount >= job.maxTimes)
      || nowStr >= job.untilTime;
    db.prepare(`
      UPDATE loop_jobs
      SET status = ?, run_count = ?, last_run_at = ?, next_run_at = ?,
          run_started_at = NULL, last_error = NULL, consecutive_failures = 0, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(
      completed ? "completed" : "active",
      nextCount,
      nowStr,
      addSeconds(now, job.intervalSeconds),
      nowStr,
      id,
    );
    return getLoopJob(db, id);
  }

  const failures = job.consecutiveFailures + 1;
  db.prepare(`
    UPDATE loop_jobs
    SET status = ?, next_run_at = ?, run_started_at = NULL, last_error = ?,
        consecutive_failures = ?, updated_at = ?
    WHERE id = ? AND status = 'running'
  `).run(
    failures >= LOOP_FAILURE_LIMIT ? "paused" : "active",
    addSeconds(now, job.intervalSeconds),
    (result.error ?? "Loop execution failed").slice(0, 2_000),
    failures,
    nowStr,
    id,
  );
  return getLoopJob(db, id);
}

/** A queued event discarded by /clear or /stop should remain scheduled. */
export function releaseQueuedLoopJob(db: Database.Database, id: number, now: Date = new Date()): boolean {
  const job = getLoopJob(db, id);
  if (!job || job.status !== "queued") return false;
  const nowStr = utcDateTimeForSql(now);
  return db.prepare(`
    UPDATE loop_jobs
    SET status = 'active', next_run_at = ?, updated_at = ?
    WHERE id = ? AND status = 'queued'
  `).run(addSeconds(now, job.intervalSeconds), nowStr, id).changes === 1;
}

export type LoopExecutor = (job: LoopJob) => Promise<void> | void;

export class LoopScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private currentTick: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly db: Database.Database,
    private readonly executor: LoopExecutor,
    private readonly checkIntervalMs = CHECK_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    recoverInterruptedLoopJobs(this.db);
    this.timer = setInterval(() => this.scheduleTick(), this.checkIntervalMs);
    this.scheduleTick();
    log.info("loop scheduler started");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.currentTick;
    log.info("loop scheduler stopped");
  }

  async tick(now: Date = new Date()): Promise<number> {
    const jobs = claimDueLoopJobs(this.db, now);
    for (const job of jobs) {
      if (this.stopping) {
        releaseQueuedLoopJob(this.db, job.id, now);
        continue;
      }
      try {
        await this.executor(job);
      } catch (error) {
        releaseQueuedLoopJob(this.db, job.id, now);
        log.error("failed to enqueue loop job", { id: job.id, error: String(error) });
      }
    }
    return jobs.length;
  }

  private async tickSafely(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tick();
    } catch (error) {
      log.error("loop scheduler tick failed", { error: String(error) });
    } finally {
      this.ticking = false;
    }
  }

  private scheduleTick(): void {
    if (this.currentTick) return;
    const tick = this.tickSafely().finally(() => {
      if (this.currentTick === tick) this.currentTick = undefined;
    });
    this.currentTick = tick;
  }
}
