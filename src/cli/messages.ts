/**
 * CLI: messages list/search — query past conversation messages.
 */

import type Database from "better-sqlite3";
import { assertChatAccess } from "../core/access.js";
import { getGroupChatSyncTarget } from "../core/group-history.js";
import {
  getMessageContextRows,
  getMessageForAccess,
  listMessages,
  searchMessages,
  type MessageRow,
} from "../messages/store.js";
import { formatLocalDateTimeWithTZ, TZ, utcToLocalDateTime } from "../tz.js";
import {
  chatIsIsolatedTopic,
  historyThreadLabel,
  resolveHistoryThreadScope,
  type ResolvedHistoryThreadScope,
} from "./history-scope.js";

interface MessageListItem {
  row: MessageRow;
  prefix?: string;
}

export type MessagesGroupSync = (db: Database.Database, chatId: string, threadId?: string) => Promise<void>;

interface MessageFormatOptions {
  includeTimezone?: boolean;
  threadScope?: ResolvedHistoryThreadScope;
}

export async function handleMessages(
  db: Database.Database,
  args: string[],
  chatId: string | undefined,
  chatType: "p2p" | "group",
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
  syncGroupChat?: MessagesGroupSync,
): Promise<void> {
  const sub = args[0];

  if (sub === "list") {
    await messagesList(db, args.slice(1), chatId, chatType, parseArgs, syncGroupChat);
  } else if (sub === "search") {
    await messagesSearch(db, args.slice(1), chatId, chatType, parseArgs, syncGroupChat);
  } else if (sub === "get") {
    messagesGet(db, args.slice(1), chatId, chatType, parseArgs);
  } else if (sub === "--help" || sub === "help") {
    printHelp();
  } else {
    console.log("Usage: nbt messages <list|search|get>");
    console.log("       nbt messages --help");
  }
}

async function messagesList(
  db: Database.Database,
  args: string[],
  currentChatId: string | undefined,
  chatType: "p2p" | "group",
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
  syncGroupChat?: MessagesGroupSync,
): Promise<void> {
  const { flags } = parseArgs(args);
  const targetChatId = flags["chat-id"] ?? currentChatId;
  const threadScope = resolveHistoryThreadScope(
    flags,
    currentChatId,
    targetChatId,
    chatType === "group" ? process.env["NIUBOT_THREAD_ID"] : undefined,
    chatIsIsolatedTopic(db, targetChatId),
  );
  if (!targetChatId) {
    console.error("Error: NIUBOT_CHAT_ID not set and --chat-id not provided");
    process.exit(1);
  }
  const limit = Number(flags["limit"] ?? flags["n"] ?? "20");
  const offset = flags["offset"] ? Number(flags["offset"]) : undefined;

  try {
    assertChatAccess({ currentChatId, chatType, targetChatId });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
  await syncGroupMessagesIfNeeded(db, targetChatId, syncGroupChat, threadScope.threadId);

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
      threadId: threadScope.threadId,
      allThreads: threadScope.allThreads,
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  if (rows.length === 0) {
    console.log("No messages found.");
    return;
  }

  printMessagesForList(rows.map((row) => ({ row })), { threadScope });
}

async function messagesSearch(
  db: Database.Database,
  args: string[],
  currentChatId: string | undefined,
  chatType: "p2p" | "group",
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
  syncGroupChat?: MessagesGroupSync,
): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const query = positional[0];
  if (!query) {
    console.error("Usage: nbt messages search <query>");
    process.exit(1);
  }

  const allChats = flags["all-chats"] === "true" || flags["all"] === "true";
  if (allChats && (flags["all-threads"] === "true" || flags["thread-id"] !== undefined)) {
    throw new Error("--all-chats cannot be combined with --thread-id or --all-threads");
  }
  const targetChatId = flags["chat-id"] ?? currentChatId;
  const threadScope = allChats
    ? { allThreads: true }
    : resolveHistoryThreadScope(
      flags,
      currentChatId,
      targetChatId,
      chatType === "group" ? process.env["NIUBOT_THREAD_ID"] : undefined,
      chatIsIsolatedTopic(db, targetChatId),
    );
  const contextCount = Number(flags["context"] ?? flags["C"] ?? "0");
  const limit = Number(flags["limit"] ?? flags["n"] ?? "10");

  if (!allChats && !targetChatId) {
    console.error("Error: NIUBOT_CHAT_ID not set. Use --all-chats to search all chats.");
    process.exit(1);
  }
  if (!allChats && targetChatId) {
    try {
      assertChatAccess({ currentChatId, chatType, targetChatId });
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
    await syncGroupMessagesIfNeeded(db, targetChatId, syncGroupChat, threadScope.threadId);
  }
  let rows: MessageRow[];
  try {
    rows = searchMessages(db, {
      currentChatId,
      chatType,
      query,
      searchAll: allChats,
      targetChatId,
      targetChatType: flags["chat-type"] as "p2p" | "group" | undefined,
      limit,
      since: flags["since"],
      before: flags["before"],
      role: flags["role"],
      userId: flags["user-id"],
      threadId: threadScope.threadId,
      allThreads: threadScope.allThreads,
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
    printMessagesForList(rows.map((row) => ({ row })), { threadScope });
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
      { includeTimezone: false, threadScope },
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

  const threadLabel = row.thread_id ? ` [${historyThreadLabel(row.thread_id)}]` : "";
  console.log(`[#${row.id}] [${ts}]${threadLabel} ${senderLabel} (${roleLabel}):`);
  console.log(row.content_text ?? "");
}

function printMessagesForList(items: MessageListItem[], options: MessageFormatOptions = {}): void {
  for (const line of formatMessagesForList(items, options)) console.log(line);
}

export function formatMessagesForList(
  input: MessageRow[] | MessageListItem[],
  options: MessageFormatOptions = {},
): string[] {
  const includeTimezone = options.includeTimezone ?? true;
  const items = normalizeMessageListItems(input);
  const lines: string[] = [];
  let currentDate: string | null = null;
  let currentThreadKey: string | null | undefined;

  if (includeTimezone) {
    lines.push(`Timezone: ${TZ}`);
  }
  if (options.threadScope?.threadId && !options.threadScope.allThreads) {
    lines.push(`当前话题：${options.threadScope.threadId}`, "");
  }

  for (const item of items) {
    const localTs = utcToLocalDateTime(item.row.created_at);
    const [date = "", time = ""] = localTs.split(" ");
    const showThread = options.threadScope?.allThreads === true;
    const threadKey = showThread ? (item.row.thread_id ?? "") : null;
    if (date !== currentDate || showThread && threadKey !== currentThreadKey) {
      if (currentDate !== null) lines.push("");
      lines.push(showThread
        ? `${date} · ${historyThreadLabel(item.row.thread_id)}`
        : date);
      currentDate = date;
      currentThreadKey = threadKey;
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

async function syncGroupMessagesIfNeeded(
  db: Database.Database,
  chatId: string,
  syncGroupChat?: MessagesGroupSync,
  threadId?: string,
): Promise<void> {
  if (!syncGroupChat || !getGroupChatSyncTarget(db, chatId)) return;
  try {
    await syncGroupChat(db, chatId, threadId);
  } catch (err) {
    // 本地库仍可查；sync 失败不挡住 list/search。
    console.error(`Warning: group history sync failed: ${(err as Error).message}`);
  }
}

function printHelp(): void {
  console.log(`查询聊天消息。这里看的是本地保存的原始消息记录（群聊会先同步飞书）。

命令:
  list    列出最近消息（默认 -n 20）
          选项: -n <数量> | --offset <id> | --since/--before <时间>
                   --role user|assistant | --user-id <id> | --content-type <t>
                   --thread-id <id> | --all-threads

  search <关键词>  按关键词搜索消息（默认 -n 10）
          选项: -n <数量> | --all-chats（仅私聊：跨所有聊天）| --chat-type p2p|group
                   -C <数量>（匹配前后上下文行数）| --since/--before <时间>
                   --role user|assistant | --user-id <id>
                   --thread-id <id> | --all-threads

  get <id>  查看单条消息全文

话题群默认只看当前话题；--all-threads 查看整个群（仍是本群）。在话题中，
thread-id 默认来自 NIUBOT_THREAD_ID，也可以显式指定。
--all-chats 仅私聊可用，跨所有聊天搜索；群聊禁用，避免把其他会话内容
暴露到群里。不能与 --all-threads / --thread-id 一起用。

日期/本地时间按 ${TZ}；带 Z 或时区偏移的 ISO 时间也接受。`);
}
