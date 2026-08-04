/** Unified model-facing scheduler tool for chat-scoped Loop and independent Cron jobs. */

import type Database from "better-sqlite3";
import { listCronJobsForAccess } from "../core/cron.js";
import {
  formatLoopInterval,
  listLoopJobs,
  parseLoopDuration,
} from "../core/loop.js";
import type { ScheduleAgentCommand, ScheduleAgentCommandResult } from "../core/schedule-command.js";
import { localApiRequest } from "../local-api/client.js";
import { dateTimeInTimeZone, formatLocalDateTimeWithTZ, labelLocalTime, TZ } from "../tz.js";
import { resolveSendEndpoint } from "./send.js";

type ParseArgs = (args: string[]) => { positional: string[]; flags: Record<string, string> };
export type ScheduleCommandExecutor = (
  chatId: string,
  command: ScheduleAgentCommand,
) => Promise<ScheduleAgentCommandResult>;

async function executeViaPipeline(chatId: string, command: ScheduleAgentCommand): Promise<ScheduleAgentCommandResult> {
  let response;
  try {
    response = await localApiRequest(resolveSendEndpoint(), "/schedule", {
      method: "POST",
      body: {
        chat_id: chatId,
        command,
        schedule_token: process.env.NIUBOT_SCHEDULE_TOKEN ?? undefined,
      },
      timeoutMs: 30_000,
    });
  } catch (error) {
    throw new Error(`无法连接 NiuBot Pipeline: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.statusCode >= 400) {
    let detail = response.body;
    try {
      detail = (JSON.parse(response.body) as { error?: string }).error ?? detail;
    } catch { /* 保留原始响应 */ }
    throw new Error(`Pipeline 拒绝调度操作 (${response.statusCode}): ${detail}`);
  }
  const result = JSON.parse(response.body) as ScheduleAgentCommandResult;
  if (!result || typeof result.output !== "string") throw new Error("Pipeline 返回了无效的调度响应");
  return result;
}

export async function handleSchedule(
  db: Database.Database | undefined,
  args: string[],
  chatId: string | undefined,
  chatType: "p2p" | "group",
  userId: string | undefined,
  parseArgs: ParseArgs,
  execute: ScheduleCommandExecutor = executeViaPipeline,
): Promise<void> {
  const sub = args[0]?.toLowerCase();
  switch (sub) {
    case "create":
    case "add":
      await createSchedule(args.slice(1), chatId, parseArgs, execute);
      return;
    case "list":
    case "ls":
      if (!db) fail("Error: database is required to list schedules");
      listSchedules(db, args.slice(1), chatId, chatType, parseArgs);
      return;
    case "cancel":
    case "stop":
    case "delete":
    case "del":
    case "rm":
      await cancelSchedule(args.slice(1), chatId, parseArgs, execute);
      return;
    case "help":
    case "--help":
      printHelp();
      return;
    default:
      printHelp();
  }
}

async function createSchedule(
  args: string[],
  chatId: string | undefined,
  parseArgs: ParseArgs,
  execute: ScheduleCommandExecutor,
): Promise<void> {
  const { flags } = parseArgs(args);
  if (!chatId) fail("Error: NIUBOT_CHAT_ID not set");
  const mode = flags["mode"]?.toLowerCase();
  const prompt = flags["prompt"]?.trim();
  if (!prompt) fail("Error: --prompt is required");
  const maxTimes = optionalPositiveInteger(flags["times"], "--times");

  if (mode === "loop") {
    const every = flags["every"];
    const intervalSeconds = every ? parseLoopDuration(every) : undefined;
    if (intervalSeconds === undefined) fail("Error: Loop requires --every, for example 5m");
    const duration = flags["duration"];
    const durationSeconds = duration ? parseLoopDuration(duration) : undefined;
    if (duration && durationSeconds === undefined) fail("Error: --duration must look like 30m, 2h, or 1d");
    const result = await execute(chatId, {
      type: "create.loop",
      intervalSeconds,
      prompt,
      maxTimes,
      durationSeconds,
    });
    console.log(result.output);
    return;
  }

  if (mode === "cron") {
    const scheduleInputs = [flags["cron"], flags["at"], flags["after"]].filter(Boolean);
    if (scheduleInputs.length !== 1) fail("Error: Cron requires exactly one of --cron, --at, or --after");
    const after = flags["after"];
    const afterSeconds = after ? parseLoopDuration(after) : undefined;
    if (after && afterSeconds === undefined) fail("Error: --after must look like 30m, 2h, or 1d");
    const runAt = afterSeconds === undefined
      ? flags["at"]
      : dateTimeInTimeZone(new Date(Date.now() + afterSeconds * 1_000), TZ);
    const result = await execute(chatId, {
      type: "create.cron",
      cronExpr: flags["cron"],
      runAt,
      prompt,
      description: flags["description"] ?? flags["desc"],
      maxTimes,
      untilTime: flags["until"],
      timeZone: TZ,
    });
    console.log(result.output);
    return;
  }

  fail("Error: --mode must be loop or cron");
}

function listSchedules(
  db: Database.Database,
  args: string[],
  chatId: string | undefined,
  chatType: "p2p" | "group",
  parseArgs: ParseArgs,
): void {
  const { flags } = parseArgs(args);
  if (!chatId) fail("Error: NIUBOT_CHAT_ID not set");
  const mode = flags["mode"]?.toLowerCase();
  if (mode && mode !== "loop" && mode !== "cron") fail("Error: --mode must be loop or cron");
  let count = 0;
  if (!mode || mode === "loop") {
    for (const job of listLoopJobs(db, chatId)) {
      console.log(`loop:${job.id} [${job.status}] every ${formatLoopInterval(job.intervalSeconds)} (${job.runCount}${job.maxTimes ? `/${job.maxTimes}` : " runs"})`);
      console.log(`  Task: ${truncate(job.prompt, 100)}`);
      count++;
    }
  }
  if (!mode || mode === "cron") {
    for (const job of listCronJobsForAccess(db, { currentChatId: chatId, targetChatId: chatId, chatType })) {
      const schedule = job.cronExpr ? labelLocalTime(job.cronExpr, job.timezone) : formatLocalDateTimeWithTZ(job.runAt!, job.timezone);
      console.log(`cron:${job.id} [${schedule}] (${job.runCount}${job.maxTimes ? `/${job.maxTimes}` : " runs"})`);
      console.log(`  Task: ${truncate(job.prompt, 100)}`);
      count++;
    }
  }
  if (count === 0) console.log("No active schedules.");
}

async function cancelSchedule(
  args: string[],
  chatId: string | undefined,
  parseArgs: ParseArgs,
  execute: ScheduleCommandExecutor,
): Promise<void> {
  const { positional } = parseArgs(args);
  const match = /^(loop|cron):(\d+)$/.exec(positional[0] ?? "");
  if (!match) fail("Error: schedule ID must look like loop:1 or cron:1");
  if (!chatId) fail("Error: NIUBOT_CHAT_ID not set");
  const result = await execute(chatId, { type: "cancel", scheduleId: positional[0]! });
  console.log(result.output);
}

function optionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`Error: ${name} must be a positive integer`);
  return parsed;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function printHelp(): void {
  console.log(`Manage conversation loops and independent cron schedules.

Commands:
  create --mode loop --every 5m --prompt "..." [--times 4] [--duration 2h]
  create --mode cron --cron "0 9 * * *" --prompt "..." [--times 5] [--until "2026-08-10 18:00"]
  create --mode cron --at "2026-08-05 09:00" --prompt "..."
  create --mode cron --after 30m --prompt "..."
  list [--mode loop|cron]
  cancel <loop:id|cron:id>

Loop reuses the current conversation for its chat. Cron runs in an independent session.
Local calendar times use NIUBOT_TZ (${TZ}).`);
}
