#!/usr/bin/env node

/**
 * NiuBot CLI — agent 调用的 memory/summary/messages/contacts/send/cron/task 操作工具。
 * 命令和权限逻辑对齐 cc-connect。
 *
 * 环境变量：
 *   NIUBOT_HOME       — 配置/数据目录（默认 ~/.niubot）
 *   NIUBOT_DB_PATH    — 数据库路径（优先级最高）
 *   NIUBOT_BOT_NAME   — Bot 名称（用于定位 per-bot DB：~/.niubot/<name>/niubot.db）
 *   NIUBOT_USER_ID    — 当前用户 ID
 *   NIUBOT_CHAT_ID    — 当前会话 ID
 *   NIUBOT_CHAT_TYPE  — 当前会话类型（p2p / group）
 *   NIUBOT_WORK_DIR   — 工作目录（用于 task 操作）
 */

import path from "node:path";
import os from "node:os";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import {
  addUserMemory,
  listUserMemory,
  getUserMemory,
  updateUserMemory,
  deleteUserMemory,
} from "./memory/user-memory.js";
import { getUserShortLabel, getChatShortLabel } from "./database/schema.js";
import { buildImportantContext, type SceneInfo } from "./memory/inject.js";
import { loadPersona } from "./persona.js";
import { handleMessages } from "./cli/messages.js";
import { handleContacts } from "./cli/contacts.js";
import { handleSend, handleSendFile, handleRestart } from "./cli/send.js";
import { handleCron } from "./cli/cron.js";
import { handleTask } from "./cli/task.js";
import { handleSession, handleStateSummary } from "./cli/session.js";

// ─── Context ───────────────────────────────────────────────

const NIUBOT_HOME = process.env["NIUBOT_HOME"] ?? path.join(os.homedir(), ".niubot");
// Load global defaults from NIUBOT_HOME/.env
dotenv.config({ path: path.join(NIUBOT_HOME, ".env"), quiet: true });

// 命令行参数解析（全局 flags 优先于环境变量）
const cliArgs = process.argv.slice(2);
const globalFlags = extractGlobalFlags(cliArgs);

const BOT_NAME = process.env["NIUBOT_BOT_NAME"];
const DB_PATH = globalFlags["db-path"]
  ?? process.env["NIUBOT_DB_PATH"]
  ?? (BOT_NAME ? path.join(NIUBOT_HOME, BOT_NAME, "niubot.db") : path.join(NIUBOT_HOME, "niubot.db"));
const USER_ID = globalFlags["user-id"] ?? process.env["NIUBOT_USER_ID"];
const CHAT_ID = globalFlags["chat-id"] ?? process.env["NIUBOT_CHAT_ID"];
const CHAT_TYPE = (globalFlags["chat-type"] ?? process.env["NIUBOT_CHAT_TYPE"] ?? "p2p") as "p2p" | "group";
const WORK_DIR = process.env["NIUBOT_WORK_DIR"] ?? (BOT_NAME ? path.join(NIUBOT_HOME, BOT_NAME, "workspace") : ".");

/** 提取全局 flags 并从 argv 中移除 */
function extractGlobalFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  const globalKeys = new Set(["user-id", "chat-id", "db-path", "chat-type"]);
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (globalKeys.has(key) && i + 1 < args.length && !args[i + 1]!.startsWith("--")) {
        flags[key] = args[i + 1]!;
        args.splice(i, 2);
        continue;
      }
    }
    i++;
  }
  return flags;
}

function requireUserId(): string {
  if (!USER_ID) { console.error("Error: NIUBOT_USER_ID not set"); process.exit(1); }
  return USER_ID;
}

function openDb(): Database.Database {
  try {
    const db = new Database(DB_PATH);
    db.pragma("busy_timeout = 5000");
    return db;
  } catch {
    console.error(`Error: cannot open database at ${DB_PATH}`);
    process.exit(1);
  }
}

// ─── Arg parsing ───────────────────────────────────────────

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) { flags[key] = next; i++; }
      else { flags[key] = "true"; }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = arg.slice(1);
      const next = args[i + 1];
      if (next && !next.startsWith("-")) { flags[key] = next; i++; }
      else { flags[key] = "true"; }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

// ─── Access control helpers ────────────────────────────────

function checkChatAccess(targetChatId: string): void {
  if (!CHAT_ID) return;
  if (targetChatId === CHAT_ID) return;
  if (CHAT_TYPE === "group") {
    console.error("Error: cross-chat query is not allowed in group chat");
    process.exit(1);
  }
}

// ─── Main ──────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = cliArgs;
  const command = args[0];

  switch (command) {
    case "user-memory":
      handleUserMemory(args.slice(1));
      break;
    case "messages":
      handleMessages(openDb(), args.slice(1), CHAT_ID, CHAT_TYPE, USER_ID, checkChatAccess, parseArgs);
      break;
    case "contacts":
      handleContacts(openDb(), args.slice(1), CHAT_ID, CHAT_TYPE, parseArgs);
      break;
    case "send":
      handleSend(args.slice(1), CHAT_ID, parseArgs);
      break;
    case "send-file":
      handleSendFile(args.slice(1), CHAT_ID, parseArgs);
      break;
    case "cron":
      handleCron(openDb(), args.slice(1), CHAT_ID, USER_ID, parseArgs);
      break;
    case "task":
      handleTask(args.slice(1), WORK_DIR, CHAT_ID, CHAT_TYPE, USER_ID, parseArgs);
      break;
    case "session-summary":
      handleSession(openDb(), args.slice(1), CHAT_ID, parseArgs);
      break;
    case "state-summary":
      handleStateSummary(openDb(), CHAT_ID);
      break;
    case "restart":
      handleRestart();
      break;
    case "whoami":
      handleWhoami();
      break;
    default:
      printUsage();
      break;
  }
}

// ─── user-memory ───────────────────────────────────────────

function handleUserMemory(args: string[]): void {
  const sub = args[0];
  const rest = args.slice(1);
  const db = openDb();
  const userId = requireUserId();

  switch (sub) {
    case "add":
      userMemoryAdd(db, userId, rest);
      break;
    case "list":
    case "ls":
      userMemoryList(db, userId, rest);
      break;
    case "get":
      userMemoryGet(db, userId, rest);
      break;
    case "update":
      userMemoryUpdate(db, userId, rest);
      break;
    case "del":
    case "delete":
    case "rm":
      userMemoryDel(db, userId, rest);
      break;
    default:
      console.log("Usage: niubot user-memory <add|list|get|update|del>");
      break;
  }
  db.close();
}

function userMemoryAdd(db: Database.Database, userId: string, args: string[]): void {
  const { flags } = parseArgs(args);
  const summary = flags["summary"] ?? flags["s"];
  if (!summary) {
    console.error("Usage: niubot user-memory add --summary \"...\" [--detail \"...\"] [--visibility private|public]");
    process.exit(1);
  }
  const detail = flags["detail"] ?? flags["d"] ?? "";
  const visibility = (flags["visibility"] ?? flags["v"] ?? "private") as "private" | "public";
  if (visibility !== "private" && visibility !== "public") {
    console.error("Error: visibility must be 'private' or 'public'");
    process.exit(1);
  }
  const sourceChat = CHAT_ID ?? undefined;

  try {
    const id = addUserMemory(db, userId, summary, detail, visibility, sourceChat);
    console.log(`Added memory #${id}`);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

function userMemoryList(db: Database.Database, userId: string, args: string[]): void {
  const { flags } = parseArgs(args);
  const targetUserId = flags["user-id"];

  let memories;
  if (targetUserId && targetUserId !== userId) {
    if (CHAT_TYPE === "p2p") {
      console.error("Error: cannot view other user's memories in private chat");
      process.exit(1);
    }
    memories = listUserMemory(db, targetUserId, "public");
  } else {
    memories = listUserMemory(db, userId);
  }

  if (memories.length === 0) {
    console.log("No memories.");
  } else {
    for (const m of memories) {
      console.log(`  #${m.id}  ${m.summary}`);
    }
  }
}

function userMemoryGet(db: Database.Database, userId: string, args: string[]): void {
  const { positional } = parseArgs(args);
  const id = Number(positional[0]);
  if (!id) { console.error("Usage: niubot user-memory get <id>"); process.exit(1); }

  const m = getUserMemory(db, id);
  if (!m) { console.error(`Memory #${id} not found`); process.exit(1); }

  if (m.userId !== userId) {
    if (CHAT_TYPE === "p2p") {
      console.error("Error: cannot view other user's memories in private chat");
      process.exit(1);
    }
    if (m.visibility !== "public") {
      console.error(`Memory #${id} not found`);
      process.exit(1);
    }
  }

  console.log(`Memory #${m.id}`);
  console.log(`Summary:    ${m.summary}`);
  if (m.detail) console.log(`Detail:     ${m.detail}`);
  console.log(`Visibility: ${m.visibility}`);
  console.log(`Created:    ${m.createdAt}`);
  console.log(`Updated:    ${m.updatedAt}`);
}

function userMemoryUpdate(db: Database.Database, userId: string, args: string[]): void {
  const { positional, flags } = parseArgs(args);
  const id = Number(positional[0]);
  if (!id) {
    console.error("Usage: niubot user-memory update <id> [--summary \"...\"] [--detail \"...\"] [--visibility private|public]");
    process.exit(1);
  }

  const m = getUserMemory(db, id);
  if (!m) { console.error(`Memory #${id} not found`); process.exit(1); }
  if (m.userId !== userId) { console.error("Error: can only update your own memories"); process.exit(1); }

  const updates: { summary?: string; detail?: string; visibility?: "private" | "public" } = {};
  const newSummary = flags["summary"] ?? flags["s"];
  if (newSummary !== undefined) updates.summary = newSummary;
  const newDetail = flags["detail"] ?? flags["d"];
  if (newDetail !== undefined) updates.detail = newDetail;
  const vis = flags["visibility"] ?? flags["v"];
  if (vis) {
    if (vis !== "private" && vis !== "public") {
      console.error("Error: visibility must be 'private' or 'public'");
      process.exit(1);
    }
    updates.visibility = vis as "private" | "public";
  }

  if (Object.keys(updates).length === 0) {
    console.error("Nothing to update. Provide --summary, --detail, or --visibility.");
    process.exit(1);
  }

  updateUserMemory(db, id, updates);
  console.log(`Updated memory #${id}`);
}

function userMemoryDel(db: Database.Database, userId: string, args: string[]): void {
  const { positional } = parseArgs(args);
  const id = Number(positional[0]);
  if (!id) { console.error("Usage: niubot user-memory del <id>"); process.exit(1); }

  const m = getUserMemory(db, id);
  if (!m) { console.error(`Memory #${id} not found`); process.exit(1); }
  if (m.userId !== userId) { console.error("Error: can only delete your own memories"); process.exit(1); }

  deleteUserMemory(db, id);
  console.log(`Deleted memory #${id}`);
}

// ─── whoami ───────────────────────────────────────────────

function handleWhoami(): void {
  const db = openDb();
  const botName = process.env["NIUBOT_BOT_NAME"] ?? "NiuBot";
  const botId = process.env["NIUBOT_BOT_ID"];
  const isAdmin = process.env["NIUBOT_IS_ADMIN"] === "true";

  // 构建 persona 路径并读取内容
  const personaPath = BOT_NAME
    ? path.join(NIUBOT_HOME, BOT_NAME, "persona.md")
    : path.join(NIUBOT_HOME, "persona.md");
  const personaContent = loadPersona(personaPath);

  // 构建 bot label
  let botLabel: string | undefined;
  if (botId) {
    const row = db.prepare(
      "SELECT id FROM users WHERE platform_id = ? OR id = ?",
    ).get(botId, botId) as { id: string } | undefined;
    if (row) {
      botLabel = getUserShortLabel(db, row.id);
    }
  }

  // 构建 chat label
  const chatLabel = CHAT_ID ? getChatShortLabel(db, CHAT_ID) : undefined;

  // 构建 user name
  let userName: string | undefined;
  if (USER_ID) {
    const row = db.prepare("SELECT name FROM users WHERE id = ?").get(USER_ID) as { name: string | null } | undefined;
    userName = row?.name ?? undefined;
  }

  const scene: SceneInfo = {
    botName: botLabel ?? botName,
    botLabel,
    userName,
    userId: USER_ID ?? "unknown",
    chatId: CHAT_ID ?? "unknown",
    chatType: CHAT_TYPE as "p2p" | "group",
    chatLabel,
    isAdmin,
    personaPath: isAdmin ? personaPath : undefined,
    personaContent,
  };

  const output = buildImportantContext(db, scene);
  console.log(output);

  db.close();
}

// ─── Usage ─────────────────────────────────────────────────

function printUsage(): void {
  console.log(`NiuBot CLI

Usage: niubot <command> <subcommand> [options]

Commands:
  user-memory   add|list|get|update|del     Manage user memories
  messages      list|search                 Query message history
  contacts      list-users|list-chats|get-user|get-chat|set-name
  send          <text>                      Send message via IPC
  send-file     <file-path>                 Send file via IPC
  cron          add|list|del                Manage scheduled tasks
  task          create|list|update|delete   Manage task projects
  restart                                   Restart bot (admin, via IPC)
  whoami                                    Show current scene info

Global flags (apply to all commands):
  --user-id <id>     Override NIUBOT_USER_ID
  --chat-id <id>     Override NIUBOT_CHAT_ID
  --chat-type <type> Override NIUBOT_CHAT_TYPE (p2p/group)
  --db-path <path>   Override NIUBOT_DB_PATH`);
}

main().catch((err) => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
