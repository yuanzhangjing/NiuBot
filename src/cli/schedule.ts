/** Unified model-facing scheduler tool for chat-scoped Loop and independent Cron jobs. */

import type Database from "better-sqlite3";
import { describeCronExpr, describeCronSchedule, listCronJobsForAccess } from "../core/cron.js";
import {
  formatLoopInterval,
  listLoopJobs,
  parseLoopDuration,
} from "../core/loop.js";
import { normalizeScheduleMode, type CreateScheduleCommand, type ScheduleAgentCommand, type ScheduleAgentCommandResult, type ScheduleMode, type ScheduleTrigger } from "../core/schedule-command.js";
import { localApiRequest } from "../local-api/client.js";
import { formatLocalDateTimeWithTZ, TZ } from "../tz.js";
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
  const mode = parseScheduleMode(flags["mode"]);
  const prompt = flags["prompt"]?.trim();
  if (!prompt) fail("Error: --prompt is required");
  const maxTimes = optionalPositiveInteger(flags["times"], "--times");

  // 触发参数与 mode 正交、两模式全可用：--every / --at / --after / --cron 四选一
  const triggers = ["every", "at", "after", "cron"].filter((t) => flags[t] !== undefined);
  if (triggers.length !== 1) {
    fail("Error: 需要且只能指定一个触发参数：--every / --at / --after / --cron");
  }
  const trigger = triggers[0]! as ScheduleTrigger;

  const command: CreateScheduleCommand = {
    type: "create.schedule",
    mode,
    trigger,
    prompt,
    maxTimes,
    timeZone: TZ,
  };
  switch (trigger) {
    case "every": {
      const intervalSeconds = flags["every"] ? parseLoopDuration(flags["every"]!) : undefined;
      if (intervalSeconds === undefined) fail("Error: --every must look like 5m, 2h, or 1d");
      command.intervalSeconds = intervalSeconds;
      break;
    }
    case "at":
      command.at = flags["at"];
      break;
    case "after": {
      const afterSeconds = flags["after"] ? parseLoopDuration(flags["after"]!) : undefined;
      if (afterSeconds === undefined) fail("Error: --after must look like 30m, 2h, or 1d");
      command.afterSeconds = afterSeconds;
      break;
    }
    case "cron":
      command.cronExpr = flags["cron"];
      break;
  }
  // 截止参数两模式通用：--until 绝对截止，--duration 相对时长（二者都给了时以 --until 为准）
  if (flags["until"]) command.untilTime = flags["until"];
  const duration = flags["duration"];
  if (duration) {
    const durationSeconds = parseLoopDuration(duration);
    if (durationSeconds === undefined) fail("Error: --duration must look like 30m, 2h, or 1d");
    command.durationSeconds = durationSeconds;
  }
  command.description = flags["description"] ?? flags["desc"];

  const result = await execute(chatId, command);
  console.log(result.output);
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
  const mode = flags["mode"] ? parseScheduleMode(flags["mode"]) : undefined;
  let count = 0;
  if (!mode || mode === "main") {
    for (const job of listLoopJobs(db, chatId)) {
      const schedule = job.cronExpr
        ? describeCronExpr(job.cronExpr, job.timezone)
        : `every ${formatLoopInterval(job.intervalSeconds)}`;
      console.log(`loop:${job.id} [${job.status}] ${schedule} (${job.runCount}${job.maxTimes ? `/${job.maxTimes}` : " runs"})`);
      console.log(`  Task: ${truncate(job.prompt, 100)}`);
      count++;
    }
  }
  if (!mode || mode === "isolated") {
    for (const job of listCronJobsForAccess(db, { currentChatId: chatId, targetChatId: chatId, chatType })) {
      const schedule = job.cronExpr ? describeCronSchedule(job.cronExpr, null, job.timezone) : formatLocalDateTimeWithTZ(job.runAt!);
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

function parseScheduleMode(value: string | undefined): ScheduleMode {
  try {
    return normalizeScheduleMode(value?.toLowerCase());
  } catch {
    fail("Error: --mode must be current_session (当前对话) or new_session (新开会话)");
  }
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
  console.log(`Manage Loop schedules.

会话模式（决定上下文）：
  --mode current_session   在当前对话上下文执行（延续当前话题；兼容名 main，旧名 loop）
  --mode new_session       新开独立会话执行（独立提醒/定时任务；兼容名 isolated，旧名 cron）

触发参数（四选一，两模式通用）：
  --every 5m    循环执行（isolated 模式转为表达式，最小 1 分钟）
  --at "2026-08-05 09:00"   指定本地时间执行一次
  --after 30m   延迟多久后执行一次
  --cron "0 9 * * *"   日历表达式定时（分钟粒度匹配）

通用选项：
  --times <n>          最多执行 n 次
  --until "2026-08-10 18:00"   绝对截止时间
  --duration 2h        相对运行时长（--until 优先级更高）
  --description "..."  任务描述（isolated 模式用于独立会话）

示例：
  create --mode current_session --every 5m --prompt "..." [--times 4] [--until "18:00"]
  create --mode current_session --cron "0 9 * * 1" --prompt "..." [--until "2026-09-01 09:00"]
  create --mode current_session --at "2026-08-05 18:00" --prompt "..."
  create --mode new_session --cron "0 9 * * *" --prompt "..." [--times 5] [--until "2026-08-10 18:00"]
  create --mode new_session --after 30m --prompt "..."
  list [--mode current_session|new_session]
  cancel <loop:id|cron:id>

时长使用 5m、2h、1d。本地钟点按引擎展示时区（${TZ}）。`);
}
