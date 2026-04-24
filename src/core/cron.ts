/**
 * Cron scheduler — runs scheduled tasks at specified intervals.
 * Jobs are stored in the cron_jobs DB table and executed by sending prompts
 * to the agent via the pipeline.
 */

import type Database from "better-sqlite3";
import { createLogger } from "../logger.js";
import { assertChatAccess, type ChatAccessContext } from "./access.js";

const log = createLogger("cron");

/** Check interval: 60 seconds */
const CHECK_INTERVAL_MS = 60_000;

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
  };
}

export type CronExecutor = (chatId: string, userId: string, prompt: string, description: string) => Promise<void>;

export class CronScheduler {
  private db: Database.Database;
  private executor: CronExecutor;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(db: Database.Database, executor: CronExecutor) {
    this.db = db;
    this.executor = executor;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.tick().catch((err) => {
        log.error("cron tick error", { error: String(err) });
      }).finally(() => {
        this.running = false;
      });
    }, CHECK_INTERVAL_MS);
    log.info("cron scheduler started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("cron scheduler stopped");
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const nowStr = formatLocalDateTime(now);

    const jobs = this.db.prepare(
      "SELECT * FROM cron_jobs WHERE status = 'active'",
    ).all() as RawCronRow[];

    for (const raw of jobs) {
      const job = toJob(raw);

      // Check bounded conditions
      if (job.maxTimes && job.runCount >= job.maxTimes) {
        this.db.prepare("UPDATE cron_jobs SET status = 'completed' WHERE id = ?").run(job.id);
        log.info("cron job completed (max times)", { id: job.id });
        continue;
      }
      if (job.untilTime && nowStr > normalizeDatetime(job.untilTime)) {
        this.db.prepare("UPDATE cron_jobs SET status = 'completed' WHERE id = ?").run(job.id);
        log.info("cron job completed (until time)", { id: job.id });
        continue;
      }

      let shouldRun = false;

      if (job.runAt) {
        // One-time job
        if (nowStr >= normalizeDatetime(job.runAt) && job.runCount === 0) {
          shouldRun = true;
        }
      } else if (job.cronExpr) {
        // Recurring job — check if current minute matches cron expression
        shouldRun = matchesCron(job.cronExpr, now);
        // Don't run if already ran in this minute
        if (shouldRun && job.lastRunAt) {
          const lastMinute = normalizeDatetime(job.lastRunAt).slice(0, 16);
          const currentMinute = nowStr.slice(0, 16);
          if (lastMinute === currentMinute) shouldRun = false;
        }
      }

      if (shouldRun) {
        log.info("executing cron job", { id: job.id, desc: job.description });
        try {
          await this.executor(job.chatId, job.creatorUserId, job.prompt, job.description);

          this.db.prepare(
            "UPDATE cron_jobs SET run_count = run_count + 1, last_run_at = ? WHERE id = ?",
          ).run(nowStr, job.id);

          // Complete one-time jobs
          if (job.runAt) {
            this.db.prepare("UPDATE cron_jobs SET status = 'completed' WHERE id = ?").run(job.id);
          }

          // Check if max_times reached after this run
          if (job.maxTimes && job.runCount + 1 >= job.maxTimes) {
            this.db.prepare("UPDATE cron_jobs SET status = 'completed' WHERE id = ?").run(job.id);
          }
        } catch (err) {
          log.error("cron job execution failed", { id: job.id, error: String(err) });
        }
      }
    }
  }
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
  },
): number {
  // Validate: runAt must be in the future（对齐 cc-connect AddJob）
  if (opts.runAt) {
    const runAtTime = new Date(opts.runAt.replace(" ", "T"));
    if (runAtTime.getTime() <= Date.now()) {
      throw new Error("run_at must be in the future");
    }
  }

  const result = db.prepare(`
    INSERT INTO cron_jobs (chat_id, creator_user_id, cron_expr, run_at, prompt, description, max_times, until_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.chatId,
    opts.creatorUserId,
    opts.cronExpr ?? null,
    opts.runAt ?? null,
    opts.prompt,
    opts.description ?? "",
    opts.maxTimes ?? null,
    opts.untilTime ?? null,
  );
  return Number(result.lastInsertRowid);
}

/** List active cron jobs for a chat */
export function listCronJobs(
  db: Database.Database,
  chatId?: string,
): Array<CronJob & { createdAt: string }> {
  let sql = "SELECT * FROM cron_jobs WHERE status = 'active'";
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
  const row = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(id) as RawCronRow | undefined;
  return row ? { ...toJob(row), createdAt: row.created_at } : undefined;
}

/**
 * Simple cron expression matcher.
 * Supports: minute hour day month weekday
 * Each field: number, *, or comma-separated values
 */
function matchesCron(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return false;

  const fields = [
    date.getMinutes(),  // minute
    date.getHours(),    // hour
    date.getDate(),     // day of month
    date.getMonth() + 1, // month (1-12)
    date.getDay(),      // day of week (0=Sunday)
  ];

  for (let i = 0; i < 5; i++) {
    if (!matchesCronField(parts[i]!, fields[i]!)) return false;
  }
  return true;
}

function matchesCronField(field: string, value: number): boolean {
  if (field === "*") return true;

  // Handle */n step values
  if (field.startsWith("*/")) {
    const step = Number(field.slice(2));
    return !Number.isNaN(step) && step > 0 && value % step === 0;
  }

  // Handle comma-separated values and ranges
  for (const part of field.split(",")) {
    if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      if (value >= start! && value <= end!) return true;
    } else {
      if (Number(part) === value) return true;
    }
  }
  return false;
}

/** Format a Date as "YYYY-MM-DD HH:MM:SS" in system local time (consistent with matchesCron) */
function formatLocalDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Normalize datetime string: replace 'T' separator with space for consistent comparison */
function normalizeDatetime(s: string): string {
  return s.replace("T", " ");
}
