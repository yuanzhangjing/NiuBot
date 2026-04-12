/**
 * CLI: task create/list/update/delete — manage tasks with visibility control.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";

interface TaskEntry {
  name: string;
  description: string;
  path: string;
  owner: string;
  visibility: "public" | "private";
  source_chat?: string;
  created_at: string;
  status?: string;
}

interface TaskIndex {
  tasks: TaskEntry[];
}

function buildTaskReadme(name: string, description: string): string {
  return `# ${name}

${description || "Task description here."}

## In Progress

（无）

## Todo

（无）

## Bug

（无）

## Idea

（无）

## Done

（无）
`;
}

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
      taskList(args.slice(1), workingDirectory, userId, parseArgs);
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
      console.log("Usage: niubot task <create|list|update|delete>");
      break;
  }
}

function getTasksDir(workingDirectory: string): string {
  return path.join(workingDirectory, "tasks");
}

function getIndexPath(workingDirectory: string): string {
  return path.join(getTasksDir(workingDirectory), "index.yaml");
}

function loadIndex(workingDirectory: string): TaskIndex {
  const indexPath = getIndexPath(workingDirectory);
  if (!fs.existsSync(indexPath)) {
    return { tasks: [] };
  }
  const content = fs.readFileSync(indexPath, "utf-8");
  const parsed = yaml.parse(content);
  return { tasks: parsed?.tasks ?? [] };
}

function saveIndex(workingDirectory: string, index: TaskIndex): void {
  const indexPath = getIndexPath(workingDirectory);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, yaml.stringify(index), "utf-8");
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
    console.error("Usage: niubot task create <name> [--desc \"...\"] [--private|--public]");
    process.exit(1);
  }

  const index = loadIndex(workingDirectory);

  // Check duplicate
  if (index.tasks.find((t) => t.name === name && t.status !== "archived")) {
    console.error(`Error: task "${name}" already exists`);
    process.exit(1);
  }

  // Determine visibility
  let visibility: "public" | "private" = chatType === "group" ? "public" : "private";
  if (flags["private"] === "true") visibility = "private";
  if (flags["public"] === "true") visibility = "public";

  const description = flags["desc"] ?? flags["description"] ?? "";
  const taskDir = path.join(getTasksDir(workingDirectory), name);

  // Create directory and README
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "README.md"), buildTaskReadme(name, description), "utf-8");

  // Update index
  const entry: TaskEntry = {
    name,
    description,
    path: `tasks/${name}`,
    owner: userId ?? "unknown",
    visibility,
    source_chat: chatId,
    created_at: new Date().toISOString().slice(0, 10),
  };
  index.tasks.push(entry);
  saveIndex(workingDirectory, index);

  const absPath = path.resolve(taskDir);
  console.log(`name: ${name}`);
  if (description) console.log(`description: ${description}`);
  console.log(`path: ${absPath}`);
  console.log(`owner: ${userId ?? "unknown"}`);
  console.log(`visibility: ${visibility}`);
  console.log(`created_at: "${entry.created_at}"`);
}

function taskList(
  args: string[],
  workingDirectory: string,
  userId: string | undefined,
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { positional, flags } = parseArgs(args);
  const nameFilter = positional[0] ?? flags["name"];

  const index = loadIndex(workingDirectory);
  let tasks = index.tasks.filter((t) => t.status !== "archived");

  // Filter by visibility: show public + own private
  tasks = tasks.filter((t) => {
    if (t.visibility === "public") return true;
    if (userId && t.owner === userId) return true;
    return false;
  });

  // Filter by name
  if (nameFilter) {
    const lower = nameFilter.toLowerCase();
    tasks = tasks.filter((t) => t.name.toLowerCase().includes(lower));
  }

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
    console.error("Usage: niubot task update <name> [--name <new>] [--desc \"...\"] [--private|--public] [--active|--inactive]");
    process.exit(1);
  }

  const index = loadIndex(workingDirectory);
  const task = index.tasks.find((t) => t.name === name && t.status !== "archived");
  if (!task) {
    console.error(`Task "${name}" not found`);
    process.exit(1);
  }

  // Ownership check
  if (userId && task.owner !== userId) {
    console.error("Error: can only update your own tasks");
    process.exit(1);
  }

  // Apply updates
  if (flags["name"]) {
    const newName = flags["name"];
    const oldDir = path.join(getTasksDir(workingDirectory), task.name);
    const newDir = path.join(getTasksDir(workingDirectory), newName);
    if (fs.existsSync(oldDir)) {
      fs.renameSync(oldDir, newDir);
    }
    task.name = newName;
    task.path = `tasks/${newName}`;
  }
  if (flags["desc"] !== undefined || flags["description"] !== undefined) {
    task.description = flags["desc"] ?? flags["description"] ?? "";
  }
  if (flags["private"] === "true") task.visibility = "private";
  if (flags["public"] === "true") task.visibility = "public";
  if (flags["active"] === "true") delete task.status;
  if (flags["inactive"] === "true") task.status = "inactive";

  saveIndex(workingDirectory, index);
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
    console.error("Usage: niubot task delete <name>");
    process.exit(1);
  }

  const index = loadIndex(workingDirectory);
  const task = index.tasks.find((t) => t.name === name && t.status !== "archived");
  if (!task) {
    console.error(`Task "${name}" not found`);
    process.exit(1);
  }

  if (userId && task.owner !== userId) {
    console.error("Error: can only delete your own tasks");
    process.exit(1);
  }

  // Archive: move directory to .archive/
  const srcDir = path.join(getTasksDir(workingDirectory), name);
  const archiveDir = path.join(getTasksDir(workingDirectory), ".archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  const destDir = path.join(archiveDir, name);
  if (fs.existsSync(srcDir)) {
    fs.renameSync(srcDir, destDir);
  }

  // Mark as archived in index
  task.status = "archived";
  saveIndex(workingDirectory, index);

  console.log(`Deleted (archived) task "${name}"`);
}
