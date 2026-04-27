/**
 * CLI: contacts — manage users and chats directory.
 */

import type Database from "better-sqlite3";
import {
  assertContactsAccess,
  countChatMessages,
  countChatSessions,
  countUserMemories,
  getChat as getChatContact,
  getUser as getUserContact,
  listChats as listChatContacts,
  listUsers as listUserContacts,
  resolveChatId,
  resolveUserId,
  setUserManualName,
} from "../contacts/store.js";
import { formatLocalDateTimeWithTZ } from "../tz.js";

export function formatContactCreatedAt(createdAt: string): string {
  return formatLocalDateTimeWithTZ(createdAt);
}

export function handleContacts(
  db: Database.Database,
  args: string[],
  chatId: string | undefined,
  chatType: "p2p" | "group",
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const sub = args[0];
  try {
    assertContactsAccess({ chatType });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  switch (sub) {
    case "list-users":
      listUsers(db, args.slice(1), parseArgs);
      break;
    case "list-chats":
      listChats(db, args.slice(1), parseArgs);
      break;
    case "get-user":
      getUser(db, args.slice(1), parseArgs);
      break;
    case "get-chat":
      getChat(db, args.slice(1), parseArgs);
      break;
    case "set-name":
      setName(db, args.slice(1), parseArgs);
      break;
    case "--help":
    case "help":
      printHelp();
      break;
    default:
      console.log("Usage: nbt contacts <list-users|list-chats|get-user|get-chat|set-name>");
      console.log("       nbt contacts --help");
      break;
  }
}

function listUsers(
  db: Database.Database,
  args: string[],
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { flags } = parseArgs(args);
  const nameFilter = flags["name"];

  const rows = listUserContacts(db, { name: nameFilter, platform: flags["platform"] });

  if (rows.length === 0) {
    console.log("No users found.");
    return;
  }

  for (const r of rows) {
    const shortId = r.id.toUpperCase();
    const nameStr = r.name ? ` ${r.name}` : "";
    const botStr = r.is_bot ? " [bot]" : "";
    console.log(`  ${shortId}${nameStr}${botStr}  (${r.platform}: ${r.platform_id.slice(0, 12)}...)`);
  }
}

function listChats(
  db: Database.Database,
  args: string[],
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { flags } = parseArgs(args);

  const rows = listChatContacts(db, { type: flags["type"], name: flags["name"], userId: flags["user-id"] });

  if (rows.length === 0) {
    console.log("No chats found.");
    return;
  }

  for (const r of rows) {
    const shortId = r.id.toUpperCase();
    const nameStr = r.name ? ` ${r.name}` : "";
    const typeStr = r.type === "group" ? " [group]" : " [p2p]";
    console.log(`  ${shortId}${nameStr}${typeStr}  (${r.platform}: ${r.platform_id.slice(0, 12)}...)`);
  }
}

function getUser(
  db: Database.Database,
  args: string[],
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { positional } = parseArgs(args);
  const idArg = positional[0];
  if (!idArg) {
    console.error("Usage: nbt contacts get-user <id>");
    process.exit(1);
  }

  const userId = resolveUserId(db, idArg);
  if (!userId) {
    console.error(`User "${idArg}" not found`);
    process.exit(1);
  }

  const row = getUserContact(db, userId);

  if (!row) {
    console.error(`User "${idArg}" not found`);
    process.exit(1);
  }

  console.log(`User ${row.id.toUpperCase()}`);
  console.log(`  Name:        ${row.name ?? "(none)"}`);
  console.log(`  Name source: ${row.name_source ?? "platform"}`);
  console.log(`  Platform:    ${row.platform}`);
  console.log(`  Platform ID: ${row.platform_id}`);
  console.log(`  Is bot:      ${row.is_bot ? "yes" : "no"}`);
  console.log(`  Created:     ${formatContactCreatedAt(row.created_at)}`);

  // Memory count
  console.log(`  Memories:    ${countUserMemories(db, row.id)}`);
}

function getChat(
  db: Database.Database,
  args: string[],
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { positional } = parseArgs(args);
  const idArg = positional[0];
  if (!idArg) {
    console.error("Usage: nbt contacts get-chat <id>");
    process.exit(1);
  }

  const chatId = resolveChatId(db, idArg);
  if (!chatId) {
    console.error(`Chat "${idArg}" not found`);
    process.exit(1);
  }

  const row = getChatContact(db, chatId);

  if (!row) {
    console.error(`Chat "${idArg}" not found`);
    process.exit(1);
  }

  console.log(`Chat ${row.id.toUpperCase()}`);
  console.log(`  Type:        ${row.type}`);
  console.log(`  Name:        ${row.name ?? "(none)"}`);
  console.log(`  Platform:    ${row.platform}`);
  console.log(`  Platform ID: ${row.platform_id}`);
  if (row.user_id) {
    console.log(`  User ID:     ${row.user_id}`);
  }
  console.log(`  Created:     ${formatContactCreatedAt(row.created_at)}`);

  // Message count
  console.log(`  Messages:    ${countChatMessages(db, row.id)}`);
  console.log(`  Sessions:    ${countChatSessions(db, row.id)}`);
}

function setName(
  db: Database.Database,
  args: string[],
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { positional } = parseArgs(args);
  const idArg = positional[0];
  const name = positional[1];
  if (!idArg || !name) {
    console.error("Usage: nbt contacts set-name <user-id> <name>");
    process.exit(1);
  }

  const userId = resolveUserId(db, idArg);
  if (!userId) {
    console.error(`User "${idArg}" not found`);
    process.exit(1);
  }

  setUserManualName(db, userId, name);
  console.log(`Updated name for ${userId.toUpperCase()}: ${name}`);
}

function printHelp(): void {
  console.log(`Manage users and chats directory. Look up contacts, check details, set display names.

Commands:
  list-users  [--name <keyword>] [--platform <name>]
  list-chats  [--type p2p|group] [--user-id <id>] [--name <keyword>]
  get-user    <id>
  get-chat    <id>
  set-name    <user-id> <name>

IDs can be short form (U1, C1) or platform IDs.`);
}
