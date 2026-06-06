import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { localToday } from "../tz.js";

export interface TaskEntry {
  name: string;
  description: string;
  path: string;
  owner: string;
  visibility: "public" | "private";
  source_chat?: string;
  created_at: string;
  status?: string;
}

export interface TaskIndex {
  tasks: TaskEntry[];
}

export interface TaskAccessContext {
  userId?: string;
  chatType: "p2p" | "group";
}

export interface ListTasksOptions extends TaskAccessContext {
  workingDirectory: string;
  includeInactive?: boolean;
  includeArchived?: boolean;
  nameFilter?: string;
}

export function buildTaskReadme(name: string, description: string): string {
  return `# ${name}

${description || "Task description here."}

任务 README 是任务的长期索引和状态文件，记录目标、状态、关键入口、重要决策和下一步，不记录聊天流水。

## Related Context

- Repositories: （填写相关仓库路径，例如 \`repos/niubot/\`）
- Key files: （填写关键文件或目录）

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

export function getTasksDir(workingDirectory: string): string {
  return path.join(workingDirectory, "tasks");
}

export function getIndexPath(workingDirectory: string): string {
  return path.join(getTasksDir(workingDirectory), "index.yaml");
}

export function loadTaskIndex(workingDirectory: string): TaskIndex {
  const indexPath = getIndexPath(workingDirectory);
  if (!fs.existsSync(indexPath)) {
    return { tasks: [] };
  }
  const content = fs.readFileSync(indexPath, "utf-8");
  const parsed = yaml.parse(content);
  return { tasks: parsed?.tasks ?? [] };
}

export function saveTaskIndex(workingDirectory: string, index: TaskIndex): void {
  const indexPath = getIndexPath(workingDirectory);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, yaml.stringify(index), "utf-8");
}

export function isTaskVisible(task: TaskEntry, ctx: TaskAccessContext): boolean {
  if (ctx.chatType === "group") {
    return task.visibility === "public";
  }
  if (task.visibility === "public") return true;
  return !!ctx.userId && task.owner === ctx.userId;
}

export function listTasks(options: ListTasksOptions): TaskEntry[] {
  const index = loadTaskIndex(options.workingDirectory);
  let tasks = index.tasks;

  if (!options.includeArchived) {
    tasks = tasks.filter((t) => t.status !== "archived");
  }
  if (!options.includeInactive) {
    tasks = tasks.filter((t) => !t.status || t.status === "active");
  }

  tasks = tasks.filter((t) => isTaskVisible(t, options));

  if (options.nameFilter) {
    const lower = options.nameFilter.toLowerCase();
    tasks = tasks.filter((t) => t.name.toLowerCase().includes(lower));
  }

  return tasks;
}

export function createTask(options: {
  workingDirectory: string;
  name: string;
  description: string;
  visibility: "public" | "private";
  owner?: string;
  sourceChat?: string;
}): TaskEntry {
  if (!options.owner) {
    throw new Error("NIUBOT_USER_ID not set");
  }
  const index = loadTaskIndex(options.workingDirectory);
  if (index.tasks.find((t) => t.name === options.name && t.status !== "archived")) {
    throw new Error(`task "${options.name}" already exists`);
  }

  const taskDir = path.join(getTasksDir(options.workingDirectory), options.name);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "README.md"), buildTaskReadme(options.name, options.description), "utf-8");

  const entry: TaskEntry = {
    name: options.name,
    description: options.description,
    path: `tasks/${options.name}`,
    owner: options.owner,
    visibility: options.visibility,
    source_chat: options.sourceChat,
    created_at: localToday(),
  };
  index.tasks.push(entry);
  saveTaskIndex(options.workingDirectory, index);
  return entry;
}

export function getTaskForOwner(workingDirectory: string, name: string, userId?: string): TaskEntry {
  if (!userId) {
    throw new Error("NIUBOT_USER_ID not set");
  }
  const index = loadTaskIndex(workingDirectory);
  const task = index.tasks.find((t) => t.name === name && t.status !== "archived");
  if (!task) {
    throw new Error(`Task "${name}" not found`);
  }
  if (task.owner !== userId) {
    throw new Error("can only modify your own tasks");
  }
  return task;
}

export function updateTask(options: {
  workingDirectory: string;
  name: string;
  userId?: string;
  newName?: string;
  description?: string;
  hasDescription?: boolean;
  visibility?: "public" | "private";
  status?: "active" | "inactive";
}): TaskEntry {
  if (!options.userId) {
    throw new Error("NIUBOT_USER_ID not set");
  }
  const index = loadTaskIndex(options.workingDirectory);
  const task = index.tasks.find((t) => t.name === options.name && t.status !== "archived");
  if (!task) {
    throw new Error(`Task "${options.name}" not found`);
  }
  if (task.owner !== options.userId) {
    throw new Error("can only modify your own tasks");
  }

  if (options.newName && options.newName !== task.name) {
    if (index.tasks.find((t) => t.name === options.newName && t.status !== "archived" && t !== task)) {
      throw new Error(`task "${options.newName}" already exists`);
    }
    const oldDir = path.join(getTasksDir(options.workingDirectory), task.name);
    const newDir = path.join(getTasksDir(options.workingDirectory), options.newName);
    if (fs.existsSync(newDir)) {
      throw new Error(`task directory already exists: ${options.newName}`);
    }
    if (fs.existsSync(oldDir)) {
      fs.renameSync(oldDir, newDir);
    }
    task.name = options.newName;
    task.path = `tasks/${options.newName}`;
  }
  if (options.hasDescription) {
    task.description = options.description ?? "";
  }
  if (options.visibility) {
    task.visibility = options.visibility;
  }
  if (options.status === "active") {
    delete task.status;
  } else if (options.status === "inactive") {
    task.status = "inactive";
  }

  saveTaskIndex(options.workingDirectory, index);
  return task;
}

export function archiveTask(options: {
  workingDirectory: string;
  name: string;
  userId?: string;
}): void {
  if (!options.userId) {
    throw new Error("NIUBOT_USER_ID not set");
  }
  const index = loadTaskIndex(options.workingDirectory);
  const task = index.tasks.find((t) => t.name === options.name && t.status !== "archived");
  if (!task) {
    throw new Error(`Task "${options.name}" not found`);
  }
  if (task.owner !== options.userId) {
    throw new Error("can only modify your own tasks");
  }

  const srcDir = path.join(getTasksDir(options.workingDirectory), options.name);
  const archiveDir = path.join(getTasksDir(options.workingDirectory), ".archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  const destDir = path.join(archiveDir, options.name);
  if (fs.existsSync(srcDir)) {
    fs.renameSync(srcDir, destDir);
  }

  task.status = "archived";
  saveTaskIndex(options.workingDirectory, index);
}
