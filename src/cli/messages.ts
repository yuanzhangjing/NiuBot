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
import { formatLocalDateTimeWithTZ, TZ, utcToLocalDateTime } from "../tz.js";

interface MessageListItem {
  row: MessageRow;
  prefix?: string;
}

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
  } else if (sub === "--help" || sub === "help") {
    printHelp();
  } else {
    console.log("Usage: nbt messages <list|search|get>");
    console.log("       nbt messages --help");
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

  printMessagesForList(rows.map((row) => ({ row })));
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

  if (contextCount === 0) {
    printMessagesForList(rows.map((row) => ({ row })));
    return;
  }

  console.log(`Timezone: ${TZ}`);
  for (const r of rows) {
    const contextRows = getMessageContextRows(db, r.chat_id, r.id, contextCount);
    const lines = formatMessagesForList(
      contextRows.map((row) => ({
        row,
        prefix: row.id === r.id ? ">>> " : "    ",
      })),
      { includeTimezone: false },
    );

    for (const line of lines) console.log(line);
    console.log("---");
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
  const ts = formatLocalDateTimeWithTZ(row.created_at);

  console.log(`[#${row.id}] [${ts}] ${senderLabel} (${roleLabel}):`);
  console.log(row.content_text ?? "");
}

function printMessagesForList(items: MessageListItem[]): void {
  for (const line of formatMessagesForList(items)) console.log(line);
}

export function formatMessagesForList(
  input: MessageRow[] | MessageListItem[],
  options: { includeTimezone?: boolean } = {},
): string[] {
  const includeTimezone = options.includeTimezone ?? true;
  const items = normalizeMessageListItems(input);
  const lines: string[] = [];
  let currentDate: string | null = null;

  if (includeTimezone) {
    lines.push(`Timezone: ${TZ}`);
  }

  for (const item of items) {
    const localTs = utcToLocalDateTime(item.row.created_at);
    const [date = "", time = ""] = localTs.split(" ");
    if (date !== currentDate) {
      if (currentDate !== null) lines.push("");
      lines.push(date);
      currentDate = date;
    }
    lines.push(formatMessageListLine(item.row, time, item.prefix ?? ""));
  }

  return lines;
}

function normalizeMessageListItems(input: MessageRow[] | MessageListItem[]): MessageListItem[] {
  return input.map((item) => "row" in item ? item : { row: item });
}

function formatMessageListLine(r: MessageRow, time: string, prefix = ""): string {
  const senderLabel = r.sender_name
    ? `${r.sender_id.toUpperCase()}(${r.sender_name})`
    : r.sender_id.toUpperCase();
  const roleLabel = r.role === "assistant" ? "assistant" : "user";
  const content = (r.content_text ?? "").replaceAll("\n", " ");
  const text = truncate(content, 200);

  return `${prefix}[#${r.id}] [${time}] ${senderLabel} (${roleLabel}): ${text}`;
}

/** Rune-safe truncation. */
function truncate(text: string, max: number): string {
  const runes = [...text];
  if (runes.length <= max) return text;
  return runes.slice(0, max).join("") + "...";
}

function printHelp(): void {
  console.log(`Query message history. Raw record of every chat message.

Commands:
  list    List recent messages [default: -n 20]
          Options: -n <count> | --offset <id> | --since/--before <datetime>
                   --role user|assistant | --user-id <id> | --content-type <t>

  search  <query>  Search messages by keyword [default: -n 10]
          Options: -n <count> | --all (all chats) | --chat-type p2p|group
                   -C <count> (context lines around match) | --since/--before <datetime>
                   --role user|assistant | --user-id <id>

  get     <id>     Show full content of a single message

Date/local datetime filters use ${TZ}; ISO datetime with Z/offset is accepted.`);
}
