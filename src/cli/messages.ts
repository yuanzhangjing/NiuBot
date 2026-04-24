/**
 * CLI: messages list/search — query past conversation messages.
 */

import type Database from "better-sqlite3";
import {
  getMessageContextRows,
  getMessageForAccess,
  listMessages,
  searchMessages,
  type MessageRow,
} from "../messages/store.js";
import { utcToLocalDateTime } from "../tz.js";

export function handleMessages(
  db: Database.Database,
  args: string[],
  chatId: string | undefined,
  chatType: "p2p" | "group",
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const sub = args[0];

  if (sub === "list") {
    messagesList(db, args.slice(1), chatId, chatType, parseArgs);
  } else if (sub === "search") {
    messagesSearch(db, args.slice(1), chatId, chatType, parseArgs);
  } else if (sub === "get") {
    messagesGet(db, args.slice(1), chatId, chatType, parseArgs);
  } else {
    console.log("Usage: nbt messages <list|search|get>");
  }
}

function messagesList(
  db: Database.Database,
  args: string[],
  currentChatId: string | undefined,
  chatType: "p2p" | "group",
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { flags } = parseArgs(args);
  const targetChatId = flags["chat-id"] ?? currentChatId;
  if (!targetChatId) {
    console.error("Error: NIUBOT_CHAT_ID not set and --chat-id not provided");
    process.exit(1);
  }
  const limit = Number(flags["limit"] ?? flags["n"] ?? "20");
  const offset = flags["offset"] ? Number(flags["offset"]) : undefined;

  let rows: MessageRow[];
  try {
    rows = listMessages(db, {
      currentChatId,
      chatType,
      targetChatId,
      limit,
      offset,
      since: flags["since"],
      before: flags["before"],
      role: flags["role"],
      userId: flags["user-id"],
      contentType: flags["content-type"],
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

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
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { positional, flags } = parseArgs(args);
  const query = positional[0];
  if (!query) {
    console.error("Usage: nbt messages search <query>");
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
  let rows: MessageRow[];
  try {
    rows = searchMessages(db, {
      currentChatId,
      chatType,
      query,
      searchAll,
      targetChatId,
      targetChatType: flags["chat-type"] as "p2p" | "group" | undefined,
      limit,
      since: flags["since"],
      before: flags["before"],
      role: flags["role"],
      userId: flags["user-id"],
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  if (rows.length === 0) {
    console.log("No messages found.");
    return;
  }

  for (const r of rows) {
    if (contextCount > 0) {
      const contextRows = getMessageContextRows(db, r.chat_id, r.id, contextCount);

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
  currentChatId: string | undefined,
  chatType: "p2p" | "group",
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { positional } = parseArgs(args);
  const id = positional[0];
  if (!id) {
    console.error("Usage: nbt messages get <id>");
    process.exit(1);
  }

  let row: MessageRow | undefined;
  try {
    row = getMessageForAccess(db, Number(id), { currentChatId, chatType });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

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
