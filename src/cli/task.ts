/**
 * CLI: task create/list/update/delete — manage tasks with visibility control.
 */

import path from "node:path";
import { archiveTask, createTask, listTasks, updateTask } from "../tasks/store.js";

export function handleTask(
  args: string[],
  workingDirectory: string,
  chatId: string | undefined,
  chatType: "p2p" | "group",
  userId: string | undefined,
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const sub = args[0];

  switch (sub) {
    case "create":
      taskCreate(args.slice(1), workingDirectory, chatId, chatType, userId, parseArgs);
      break;
    case "list":
    case "ls":
      taskList(args.slice(1), workingDirectory, chatType, userId, parseArgs);
      break;
    case "update":
      taskUpdate(args.slice(1), workingDirectory, userId, parseArgs);
      break;
    case "delete":
    case "del":
    case "rm":
      taskDelete(args.slice(1), workingDirectory, userId, parseArgs);
      break;
    default:
      console.log("Usage: nbt task <create|list|update|delete>");
      break;
  }
}

function taskCreate(
  args: string[],
  workingDirectory: string,
  chatId: string | undefined,
  chatType: "p2p" | "group",
  userId: string | undefined,
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { positional, flags } = parseArgs(args);
  const name = positional[0] ?? flags["name"];
  if (!name) {
    console.error("Usage: nbt task create <name> [--desc \"...\"] [--private|--public]");
    process.exit(1);
  }

  // Determine visibility
  let visibility: "public" | "private" = chatType === "group" ? "public" : "private";
  if (flags["private"] === "true") visibility = "private";
  if (flags["public"] === "true") visibility = "public";

  const description = flags["desc"] ?? flags["description"] ?? "";
  let entry;
  try {
    entry = createTask({
      workingDirectory,
      name,
      description,
      visibility,
      owner: userId,
      sourceChat: chatId,
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  const absPath = path.resolve(path.join(workingDirectory, entry.path));
  console.log(`name: ${name}`);
  if (description) console.log(`description: ${description}`);
  console.log(`path: ${absPath}`);
  console.log(`owner: ${entry.owner}`);
  console.log(`visibility: ${visibility}`);
  console.log(`created_at: "${entry.created_at}"`);
}

function taskList(
  args: string[],
  workingDirectory: string,
  chatType: "p2p" | "group",
  userId: string | undefined,
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { positional, flags } = parseArgs(args);
  const nameFilter = positional[0] ?? flags["name"];

  const tasks = listTasks({
    workingDirectory,
    userId,
    chatType,
    nameFilter,
    includeInactive: true,
  });

  if (tasks.length === 0) {
    console.log("No tasks found.");
    return;
  }

  for (const t of tasks) {
    const absPath = path.resolve(path.join(workingDirectory, t.path));
    console.log(`name: ${t.name}`);
    if (t.description) console.log(`description: ${t.description}`);
    console.log(`path: ${absPath}`);
    console.log(`owner: ${t.owner}`);
    console.log(`visibility: ${t.visibility}`);
    console.log(`status: ${t.status ?? "active"}`);
    console.log(`created_at: "${t.created_at}"`);
    console.log("---");
  }
}

function taskUpdate(
  args: string[],
  workingDirectory: string,
  userId: string | undefined,
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { positional, flags } = parseArgs(args);
  const name = positional[0];
  if (!name) {
    console.error("Usage: nbt task update <name> [--name <new>] [--desc \"...\"] [--private|--public] [--active|--inactive]");
    process.exit(1);
  }

  let visibility: "public" | "private" | undefined;
  if (flags["private"] === "true") visibility = "private";
  if (flags["public"] === "true") visibility = "public";
  let status: "active" | "inactive" | undefined;
  if (flags["active"] === "true") status = "active";
  if (flags["inactive"] === "true") status = "inactive";

  let task;
  try {
    task = updateTask({
      workingDirectory,
      name,
      userId,
      newName: flags["name"],
      description: flags["desc"] ?? flags["description"],
      hasDescription: flags["desc"] !== undefined || flags["description"] !== undefined,
      visibility,
      status,
    });
  } catch (err) {
    const message = (err as Error).message;
    console.error(message.startsWith("Task ") ? message : `Error: ${message}`);
    process.exit(1);
  }
  console.log(`Updated task "${task.name}"`);
}

function taskDelete(
  args: string[],
  workingDirectory: string,
  userId: string | undefined,
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { positional } = parseArgs(args);
  const name = positional[0];
  if (!name) {
    console.error("Usage: nbt task delete <name>");
    process.exit(1);
  }

  try {
    archiveTask({ workingDirectory, name, userId });
  } catch (err) {
    const message = (err as Error).message;
    console.error(message.startsWith("Task ") ? message : `Error: ${message}`);
    process.exit(1);
  }

  console.log(`Deleted (archived) task "${name}"`);
}
