/**
 * CLI: messages list/search — query past conversation messages.
 */

import type Database from "better-sqlite3";
import { utcToLocalDateTime } from "../tz.js";

interface MessageRow {
  id: number;
  chat_id: string;
  sender_id: string;
  role: string;
  content_text: string | null;
  content_type: string;
  created_at: string;
  sender_name: string | null;
}

export function handleMessages(
  db: Database.Database,
  args: string[],
  chatId: string | undefined,
  chatType: "p2p" | "group",
  userId: string | undefined,
  checkChatAccess: (targetChatId: string) => void,
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const sub = args[0];

  if (sub === "list") {
    messagesList(db, args.slice(1), chatId, chatType, checkChatAccess, parseArgs);
  } else if (sub === "search") {
    messagesSearch(db, args.slice(1), chatId, chatType, checkChatAccess, parseArgs);
  } else if (sub === "get") {
    messagesGet(db, args.slice(1), parseArgs);
  } else {
    console.log("Usage: nb-agent messages <list|search|get>");
  }
}

function messagesList(
  db: Database.Database,
  args: string[],
  currentChatId: string | undefined,
  chatType: "p2p" | "group",
  checkChatAccess: (id: string) => void,
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { flags } = parseArgs(args);
  const targetChatId = flags["chat-id"] ?? currentChatId;
  if (!targetChatId) {
    console.error("Error: NIUBOT_CHAT_ID not set and --chat-id not provided");
    process.exit(1);
  }
  if (flags["chat-id"] && flags["chat-id"] !== currentChatId) {
    checkChatAccess(flags["chat-id"]);
  }

  const limit = Number(flags["limit"] ?? flags["n"] ?? "20");
  const offset = flags["offset"] ? Number(flags["offset"]) : undefined;

  let sql = `
    SELECT m.id, m.chat_id, m.sender_id, m.role, m.content_text, m.content_type, m.created_at,
           u.name as sender_name
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    WHERE m.chat_id = ?
  `;
  const params: unknown[] = [targetChatId];

  if (flags["since"]) {
    sql += " AND m.created_at >= ?";
    params.push(flags["since"]);
  }
  if (flags["before"]) {
    sql += " AND m.created_at < ?";
    params.push(flags["before"]);
  }
  if (flags["role"]) {
    sql += " AND m.role = ?";
    params.push(flags["role"]);
  }
  if (flags["user-id"]) {
    sql += " AND m.sender_id = ?";
    params.push(flags["user-id"].toLowerCase());
  }
  if (flags["content-type"]) {
    sql += " AND m.content_type = ?";
    params.push(flags["content-type"]);
  }

  if (offset !== undefined) {
    if (limit < 0) {
      // Backward pagination: messages before offset
      sql += " AND m.id < ?";
      params.push(offset);
      sql += ` ORDER BY m.id DESC LIMIT ?`;
      params.push(Math.abs(limit));
    } else {
      sql += " AND m.id > ?";
      params.push(offset);
      sql += ` ORDER BY m.id ASC LIMIT ?`;
      params.push(limit);
    }
  } else {
    sql += ` ORDER BY m.id DESC LIMIT ?`;
    params.push(Math.abs(limit));
  }

  const rows = db.prepare(sql).all(...params) as MessageRow[];

  // Reverse if we fetched in DESC order
  if (!offset || limit < 0) rows.reverse();

  if (rows.length === 0) {
    console.log("No messages found.");
    return;
  }

  for (const r of rows) {
    formatMessage(r);
  }
}

function messagesSearch(
  db: Database.Database,
  args: string[],
  currentChatId: string | undefined,
  chatType: "p2p" | "group",
  checkChatAccess: (id: string) => void,
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { positional, flags } = parseArgs(args);
  const query = positional[0];
  if (!query) {
    console.error("Usage: nb-agent messages search <query>");
    process.exit(1);
  }

  const searchAll = flags["all"] === "true";
  const targetChatId = flags["chat-id"] ?? currentChatId;
  const contextCount = Number(flags["context"] ?? flags["C"] ?? "0");
  const limit = Number(flags["limit"] ?? flags["n"] ?? "10");

  if (!searchAll && !targetChatId) {
    console.error("Error: NIUBOT_CHAT_ID not set. Use --all to search all chats.");
    process.exit(1);
  }
  if (flags["chat-id"] && flags["chat-id"] !== currentChatId) {
    checkChatAccess(flags["chat-id"]);
  }

  // FTS5 search
  let sql = `
    SELECT m.id, m.chat_id, m.sender_id, m.role, m.content_text, m.content_type, m.created_at,
           u.name as sender_name
    FROM messages m
    JOIN messages_fts ON messages_fts.rowid = m.id
    LEFT JOIN users u ON m.sender_id = u.id
    WHERE messages_fts MATCH ?
  `;
  const params: unknown[] = [query];

  if (!searchAll && targetChatId) {
    sql += " AND m.chat_id = ?";
    params.push(targetChatId);
  }
  if (searchAll && flags["chat-type"]) {
    sql += " AND m.chat_id IN (SELECT id FROM chats WHERE type = ?)";
    params.push(flags["chat-type"]);
  }
  if (flags["since"]) {
    sql += " AND m.created_at >= ?";
    params.push(flags["since"]);
  }
  if (flags["before"]) {
    sql += " AND m.created_at < ?";
    params.push(flags["before"]);
  }
  if (flags["role"]) {
    sql += " AND m.role = ?";
    params.push(flags["role"]);
  }
  if (flags["user-id"]) {
    sql += " AND m.sender_id = ?";
    params.push(flags["user-id"].toLowerCase());
  }

  sql += " ORDER BY m.id DESC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as MessageRow[];
  rows.reverse();

  if (rows.length === 0) {
    console.log("No messages found.");
    return;
  }

  for (const r of rows) {
    if (contextCount > 0) {
      // Fetch surrounding messages
      const contextRows = db.prepare(`
        SELECT m.id, m.chat_id, m.sender_id, m.role, m.content_text, m.content_type, m.created_at,
               u.name as sender_name
        FROM messages m
        LEFT JOIN users u ON m.sender_id = u.id
        WHERE m.chat_id = ? AND m.id BETWEEN ? AND ?
        ORDER BY m.id
      `).all(r.chat_id, r.id - contextCount, r.id + contextCount) as MessageRow[];

      for (const cr of contextRows) {
        const prefix = cr.id === r.id ? ">>> " : "    ";
        formatMessage(cr, prefix);
      }
      console.log("---");
    } else {
      formatMessage(r);
    }
  }
}

function messagesGet(
  db: Database.Database,
  args: string[],
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { positional } = parseArgs(args);
  const id = positional[0];
  if (!id) {
    console.error("Usage: nb-agent messages get <id>");
    process.exit(1);
  }

  const row = db.prepare(`
    SELECT m.id, m.chat_id, m.sender_id, m.role, m.content_text, m.content_type, m.created_at,
           u.name as sender_name
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    WHERE m.id = ?
  `).get(Number(id)) as MessageRow | undefined;

  if (!row) {
    console.log(`Message #${id} not found.`);
    return;
  }

  const senderLabel = row.sender_name
    ? `${row.sender_id.toUpperCase()}(${row.sender_name})`
    : row.sender_id.toUpperCase();
  const roleLabel = row.role === "assistant" ? "assistant" : "user";
  const ts = utcToLocalDateTime(row.created_at);

  console.log(`[#${row.id}] [${ts}] ${senderLabel} (${roleLabel}):`);
  console.log(row.content_text ?? "");
}

function formatMessage(r: MessageRow, prefix = ""): void {
  const senderLabel = r.sender_name
    ? `${r.sender_id.toUpperCase()}(${r.sender_name})`
    : r.sender_id.toUpperCase();
  const roleLabel = r.role === "assistant" ? "assistant" : "user";
  const ts = utcToLocalDateTime(r.created_at);
  const content = (r.content_text ?? "").replaceAll("\n", " ");
  const text = truncate(content, 200);

  console.log(`${prefix}[#${r.id}] [${ts}] ${senderLabel} (${roleLabel}): ${text}`);
}

/** Rune-safe truncation (对齐 cc-connect: []rune 截断) */
function truncate(text: string, max: number): string {
  const runes = [...text];
  if (runes.length <= max) return text;
  return runes.slice(0, max).join("") + "...";
}
