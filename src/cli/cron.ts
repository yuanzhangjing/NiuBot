/**
 * CLI: cron add/list/del — manage scheduled tasks.
 */

import type Database from "better-sqlite3";
import { describeCronSchedule, listCronJobsForAccess } from "../core/cron.js";
import { formatLocalDateTimeWithTZ, TZ } from "../tz.js";
import { handleSchedule, type ScheduleCommandExecutor } from "./schedule.js";

export function formatCronScheduleForDisplay(job: {
  cronExpr: string | null;
  runAt: string | null;
  timezone?: string;
}): string {
  if (job.cronExpr) return describeCronSchedule(job.cronExpr, null, job.timezone);
  if (job.runAt) return `at ${formatLocalDateTimeWithTZ(job.runAt)}`;
  return "unknown";
}

export async function handleCron(
  db: Database.Database | undefined,
  args: string[],
  chatId: string | undefined,
  chatType: "p2p" | "group",
  userId: string | undefined,
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
  executeSchedule?: ScheduleCommandExecutor,
): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case "add":
      await handleSchedule(
        db,
        ["create", "--mode", "isolated", ...args.slice(1)],
        chatId,
        chatType,
        userId,
        parseArgs,
        executeSchedule,
      );
      break;
    case "list":
    case "ls":
      if (!db) {
        console.error("Error: database is required to list cron jobs");
        process.exit(1);
      }
      cronList(db, args.slice(1), chatId, chatType, parseArgs);
      break;
    case "del":
    case "delete":
    case "rm":
      await cronDel(db, args.slice(1), chatId, chatType, userId, parseArgs, executeSchedule);
      break;
    case "--help":
    case "help":
      printHelp();
      break;
    default:
      console.log("Usage: nbt cron <add|list|del>");
      console.log("       nbt cron --help");
      break;
  }
}

function cronList(
  db: Database.Database,
  args: string[],
  chatId: string | undefined,
  chatType: "p2p" | "group",
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { flags } = parseArgs(args);
  const targetChatId = flags["chat-id"] ?? chatId;

  let jobs;
  try {
    jobs = listCronJobsForAccess(db, { currentChatId: chatId, targetChatId: targetChatId ?? undefined, chatType });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  if (jobs.length === 0) {
    console.log("No active cron jobs.");
    return;
  }

  for (const j of jobs) {
    const schedule = formatCronScheduleForDisplay(j);
    const desc = j.description ? ` — ${j.description}` : "";
    const runsStr = j.maxTimes ? ` (${j.runCount}/${j.maxTimes})` : j.runCount > 0 ? ` (ran ${j.runCount}x)` : "";
    console.log(`  #${j.id}  [${schedule}]${desc}${runsStr}`);
    console.log(`         Prompt: ${truncate(j.prompt, 80)}`);
  }
}

async function cronDel(
  db: Database.Database | undefined,
  args: string[],
  chatId: string | undefined,
  chatType: "p2p" | "group",
  userId: string | undefined,
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
  executeSchedule?: ScheduleCommandExecutor,
): Promise<void> {
  const { positional } = parseArgs(args);
  const id = Number(positional[0]);
  if (!id) {
    console.error("Usage: nbt cron del <id>");
    process.exit(1);
  }

  await handleSchedule(
    db,
    ["cancel", `cron:${id}`],
    chatId,
    chatType,
    userId,
    parseArgs,
    executeSchedule,
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

function printHelp(): void {
  console.log(`Manage scheduled tasks (recurring cron or one-time at).

Commands:
  add   Recurring: nbt cron add --cron "<expr>" --prompt "<task>" --desc "<label>"
                 [--times <n>] [--until "<datetime>"]
        One-time:  nbt cron add --at "<datetime>" --prompt "<task>" --desc "<label>"

  list  List active jobs

  del   <id>  Delete a job

Datetime formats: "2026-03-17T10:52:00", "2026-03-17 10:52", "2026-03-17"
Times without Z/offset and recurring cron expressions use the Engine display timezone (${TZ}).

Example:
  nbt cron add --cron "0 9 * * 1-5" --prompt "Send daily standup summary" --desc "standup"`);
}
