/**
 * CLI: contacts — manage users and chats directory.
 */

import type Database from "better-sqlite3";

export function handleContacts(
  db: Database.Database,
  args: string[],
  chatId: string | undefined,
  chatType: "p2p" | "group",
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const sub = args[0];

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
    default:
      console.log("Usage: nb-agent contacts <list-users|list-chats|get-user|get-chat|set-name>");
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

  let sql = "SELECT id, name, name_source, platform, platform_id, is_bot, created_at FROM users";
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (nameFilter) {
    conditions.push("name LIKE ?");
    params.push(`%${nameFilter}%`);
  }
  if (flags["platform"]) {
    conditions.push("platform = ?");
    params.push(flags["platform"]);
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)";

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    name: string | null;
    name_source: string | null;
    platform: string;
    platform_id: string;
    is_bot: number;
    created_at: string;
  }>;

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

  let sql = "SELECT id, type, name, platform, platform_id, user_id, created_at FROM chats";
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (flags["type"]) {
    conditions.push("type = ?");
    params.push(flags["type"]);
  }
  if (flags["name"]) {
    conditions.push("name LIKE ?");
    params.push(`%${flags["name"]}%`);
  }
  if (flags["user-id"]) {
    // Find chats associated with a user (p2p chats)
    conditions.push("user_id = (SELECT platform_id FROM users WHERE id = ?)");
    params.push(flags["user-id"].toLowerCase());
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)";

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    type: string;
    name: string | null;
    platform: string;
    platform_id: string;
    user_id: string | null;
    created_at: string;
  }>;

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
    console.error("Usage: nb-agent contacts get-user <id>");
    process.exit(1);
  }

  const userId = resolveUserId(db, idArg);
  if (!userId) {
    console.error(`User "${idArg}" not found`);
    process.exit(1);
  }

  const row = db.prepare(
    "SELECT id, name, name_source, platform, platform_id, is_bot, created_at FROM users WHERE id = ?",
  ).get(userId) as {
    id: string;
    name: string | null;
    name_source: string | null;
    platform: string;
    platform_id: string;
    is_bot: number;
    created_at: string;
  } | undefined;

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
  console.log(`  Created:     ${row.created_at}`);

  // Memory count
  const memCount = db.prepare(
    "SELECT COUNT(*) as n FROM user_memory WHERE user_id = ?",
  ).get(row.id) as { n: number };
  console.log(`  Memories:    ${memCount.n}`);
}

function getChat(
  db: Database.Database,
  args: string[],
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { positional } = parseArgs(args);
  const idArg = positional[0];
  if (!idArg) {
    console.error("Usage: nb-agent contacts get-chat <id>");
    process.exit(1);
  }

  const chatId = resolveChatId(db, idArg);
  if (!chatId) {
    console.error(`Chat "${idArg}" not found`);
    process.exit(1);
  }

  const row = db.prepare(
    "SELECT id, type, name, platform, platform_id, user_id, created_at FROM chats WHERE id = ?",
  ).get(chatId) as {
    id: string;
    type: string;
    name: string | null;
    platform: string;
    platform_id: string;
    user_id: string | null;
    created_at: string;
  } | undefined;

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
  console.log(`  Created:     ${row.created_at}`);

  // Message count
  const msgCount = db.prepare(
    "SELECT COUNT(*) as n FROM messages WHERE chat_id = ?",
  ).get(row.id) as { n: number };
  console.log(`  Messages:    ${msgCount.n}`);

  // Session count
  const sessionCount = db.prepare(
    "SELECT COUNT(*) as n FROM sessions WHERE chat_id = ?",
  ).get(row.id) as { n: number };
  console.log(`  Sessions:    ${sessionCount.n}`);
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
    console.error("Usage: nb-agent contacts set-name <user-id> <name>");
    process.exit(1);
  }

  const userId = resolveUserId(db, idArg);
  if (!userId) {
    console.error(`User "${idArg}" not found`);
    process.exit(1);
  }

  db.prepare("UPDATE users SET name = ?, name_source = 'manual' WHERE id = ?").run(name, userId);
  console.log(`Updated name for ${userId.toUpperCase()}: ${name}`);
}

/** Resolve user ID: accepts short ID (U1, u1) or internal ID */
function resolveUserId(db: Database.Database, input: string): string | null {
  // Try as short ID (U1 → u1)
  const lower = input.toLowerCase();
  if (/^u\d+$/.test(lower)) {
    const row = db.prepare("SELECT id FROM users WHERE id = ?").get(lower) as { id: string } | undefined;
    return row?.id ?? null;
  }
  // Try as platform ID
  const row = db.prepare("SELECT id FROM users WHERE platform_id = ?").get(input) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Resolve chat ID: accepts short ID (C1, c1) or internal ID */
function resolveChatId(db: Database.Database, input: string): string | null {
  const lower = input.toLowerCase();
  if (/^c\d+$/.test(lower)) {
    const row = db.prepare("SELECT id FROM chats WHERE id = ?").get(lower) as { id: string } | undefined;
    return row?.id ?? null;
  }
  const row = db.prepare("SELECT id FROM chats WHERE platform_id = ?").get(input) as { id: string } | undefined;
  return row?.id ?? null;
}
