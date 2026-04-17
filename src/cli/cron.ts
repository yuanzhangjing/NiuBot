/**
 * CLI: cron add/list/del — manage scheduled tasks.
 */

import type Database from "better-sqlite3";
import { addCronJob, listCronJobs, deleteCronJob, getCronJob } from "../core/cron.js";

export function handleCron(
  db: Database.Database,
  args: string[],
  chatId: string | undefined,
  userId: string | undefined,
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const sub = args[0];

  switch (sub) {
    case "add":
      cronAdd(db, args.slice(1), chatId, userId, parseArgs);
      break;
    case "list":
    case "ls":
      cronList(db, args.slice(1), chatId, parseArgs);
      break;
    case "del":
    case "delete":
    case "rm":
      cronDel(db, args.slice(1), parseArgs);
      break;
    default:
      console.log("Usage: nb-agent cron <add|list|del>");
      break;
  }
}

function cronAdd(
  db: Database.Database,
  args: string[],
  chatId: string | undefined,
  userId: string | undefined,
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { flags } = parseArgs(args);
  const cronExpr = flags["cron"];
  const runAt = flags["at"];
  const prompt = flags["prompt"];
  const desc = flags["desc"] ?? flags["description"] ?? "";
  const maxTimes = flags["times"] ? Number(flags["times"]) : undefined;
  const untilTime = flags["until"];

  if (!prompt) {
    console.error("Usage: nb-agent cron add --cron <expr> --prompt <task> [--desc <label>]");
    console.error("   or: nb-agent cron add --at <datetime> --prompt <task> [--desc <label>]");
    process.exit(1);
  }
  if (!cronExpr && !runAt) {
    console.error("Error: must provide either --cron or --at");
    process.exit(1);
  }
  if (!chatId) {
    console.error("Error: NIUBOT_CHAT_ID not set");
    process.exit(1);
  }
  if (!userId) {
    console.error("Error: NIUBOT_USER_ID not set");
    process.exit(1);
  }

  const id = addCronJob(db, {
    chatId,
    creatorUserId: userId,
    cronExpr: cronExpr ?? undefined,
    runAt: runAt ?? undefined,
    prompt,
    description: desc,
    maxTimes,
    untilTime: untilTime ?? undefined,
  });

  console.log(`Created cron job #${id}`);
  if (cronExpr) console.log(`  Schedule: ${cronExpr}`);
  if (runAt) console.log(`  Run at: ${runAt}`);
  if (desc) console.log(`  Description: ${desc}`);
  if (maxTimes) console.log(`  Max runs: ${maxTimes}`);
  if (untilTime) console.log(`  Until: ${untilTime}`);
}

function cronList(
  db: Database.Database,
  args: string[],
  chatId: string | undefined,
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { flags } = parseArgs(args);
  const targetChatId = flags["chat-id"] ?? chatId;

  const jobs = listCronJobs(db, targetChatId ?? undefined);

  if (jobs.length === 0) {
    console.log("No active cron jobs.");
    return;
  }

  for (const j of jobs) {
    const schedule = j.cronExpr ?? (j.runAt ? `at ${j.runAt}` : "unknown");
    const desc = j.description ? ` — ${j.description}` : "";
    const runsStr = j.maxTimes ? ` (${j.runCount}/${j.maxTimes})` : j.runCount > 0 ? ` (ran ${j.runCount}x)` : "";
    console.log(`  #${j.id}  [${schedule}]${desc}${runsStr}`);
    console.log(`         Prompt: ${truncate(j.prompt, 80)}`);
  }
}

function cronDel(
  db: Database.Database,
  args: string[],
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { positional } = parseArgs(args);
  const id = Number(positional[0]);
  if (!id) {
    console.error("Usage: nb-agent cron del <id>");
    process.exit(1);
  }

  const job = getCronJob(db, id);
  if (!job) {
    console.error(`Cron job #${id} not found`);
    process.exit(1);
  }

  deleteCronJob(db, id);
  console.log(`Deleted cron job #${id}${job.description ? ` (${job.description})` : ""}`);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}
