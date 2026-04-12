/**
 * CLI: sessions list/search/get — query session history.
 */

import type Database from "better-sqlite3";
import { utcToLocalDateTime } from "../tz.js";

interface SessionRow {
  id: string;
  chat_id: string;
  user_id: string | null;
  source: string;
  status: string;
  summary: string | null;
  topics: string | null;
  started_at: string;
  ended_at: string | null;
  start_msg_id: number | null;
  end_msg_id: number | null;
  message_count: number | null;
}

const SESSION_COLUMNS = "id, chat_id, user_id, source, status, summary, topics, started_at, ended_at, start_msg_id, end_msg_id, message_count";

export function handleSession(
  db: Database.Database,
  args: string[],
  chatId: string | undefined,
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const sub = args[0];

  if (sub === "list") {
    sessionList(db, args.slice(1), chatId, parseArgs);
  } else if (sub === "search") {
    sessionSearch(db, args.slice(1), chatId, parseArgs);
  } else if (sub === "get") {
    sessionGet(db, args.slice(1), parseArgs);
  } else {
    console.log("Usage: niubot sessions <list|search|get>");
  }
}

function sessionList(
  db: Database.Database,
  args: string[],
  currentChatId: string | undefined,
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { flags } = parseArgs(args);
  const chatId = flags["chat-id"] ?? currentChatId;
  if (!chatId) {
    console.error("Error: NIUBOT_CHAT_ID not set and --chat-id not provided");
    process.exit(1);
  }

  const limit = Number(flags["n"] ?? "10");
  const since = flags["since"];
  const before = flags["before"];
  const offset = flags["offset"];

  const conditions = ["chat_id = ?", "summary IS NOT NULL"];
  const params: (string | number)[] = [chatId];

  if (since) {
    conditions.push("ended_at >= ?");
    params.push(since);
  }
  if (before) {
    conditions.push("ended_at < ?");
    params.push(before);
  }
  if (offset) {
    // offset 是 session ID，找到其 ended_at 作为分页游标
    const offsetRow = db.prepare("SELECT ended_at FROM sessions WHERE id = ?").get(offset) as { ended_at: string | null } | undefined;
    if (offsetRow?.ended_at) {
      conditions.push("ended_at < ?");
      params.push(offsetRow.ended_at);
    }
  }

  params.push(Math.abs(limit));

  const rows = db.prepare(`
    SELECT ${SESSION_COLUMNS}
    FROM sessions
    WHERE ${conditions.join(" AND ")}
    ORDER BY ended_at DESC
    LIMIT ?
  `).all(...params) as SessionRow[];

  if (rows.length === 0) {
    console.log("(无归档 session)");
    return;
  }

  for (const row of rows) {
    printSessionBrief(row);
    console.log("---");
  }
}

function sessionSearch(
  db: Database.Database,
  args: string[],
  currentChatId: string | undefined,
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { positional, flags } = parseArgs(args);
  const query = positional[0];
  if (!query) {
    console.error("Usage: niubot sessions search <query> [--since <date>] [--before <date>] [-n <count>] [--offset <id>]");
    process.exit(1);
  }

  const chatId = flags["chat-id"] ?? currentChatId;
  if (!chatId) {
    console.error("Error: NIUBOT_CHAT_ID not set and --chat-id not provided");
    process.exit(1);
  }

  const limit = Number(flags["n"] ?? "5");
  const since = flags["since"];
  const before = flags["before"];
  const offset = flags["offset"];

  const conditions = ["chat_id = ?", "summary IS NOT NULL"];
  const params: (string | number)[] = [chatId];

  // LIKE 搜索 summary 和 topics 字段
  const likePattern = `%${query}%`;
  conditions.push("(summary LIKE ? OR topics LIKE ?)");
  params.push(likePattern, likePattern);

  if (since) {
    conditions.push("ended_at >= ?");
    params.push(since);
  }
  if (before) {
    conditions.push("ended_at < ?");
    params.push(before);
  }
  if (offset) {
    const offsetRow = db.prepare("SELECT ended_at FROM sessions WHERE id = ?").get(offset) as { ended_at: string | null } | undefined;
    if (offsetRow?.ended_at) {
      conditions.push("ended_at < ?");
      params.push(offsetRow.ended_at);
    }
  }

  params.push(Math.abs(limit));

  const rows = db.prepare(`
    SELECT ${SESSION_COLUMNS}
    FROM sessions
    WHERE ${conditions.join(" AND ")}
    ORDER BY ended_at DESC
    LIMIT ?
  `).all(...params) as SessionRow[];

  if (rows.length === 0) {
    console.log("(无匹配 session)");
    return;
  }

  for (const row of rows) {
    printSessionBrief(row);
    console.log("---");
  }
}

function sessionGet(
  db: Database.Database,
  args: string[],
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { positional } = parseArgs(args);
  const idArg = positional[0];
  if (!idArg) {
    console.error("Usage: niubot sessions get <id>");
    process.exit(1);
  }

  const row = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
    .get(idArg) as SessionRow | undefined;

  if (!row) {
    console.error(`Session not found: ${idArg}`);
    process.exit(1);
  }

  printSessionFull(row);
}

function printMeta(row: SessionRow): void {
  const sid = row.id;
  const startTime = row.started_at ? utcToLocalDateTime(row.started_at) : "?";
  const endTime = row.ended_at ? utcToLocalDateTime(row.ended_at) : "ongoing";
  const msgRange = row.start_msg_id != null && row.end_msg_id != null
    ? `, #${row.start_msg_id}~#${row.end_msg_id}`
    : "";
  const msgCount = row.message_count ? `, ${row.message_count}条` : "";
  console.log(`[${sid}] ${startTime} ~ ${endTime}${msgCount}${msgRange}`);
}

interface TopicDetail {
  title: string;
  summary?: string;
  decisions?: string[];
  open_items?: string[];
}

/** list/search 用：summary + tags + 未完成项 */
function printSessionBrief(row: SessionRow): void {
  printMeta(row);

  if (!row.summary) {
    console.log("  (无摘要)");
    return;
  }

  try {
    const parsed = JSON.parse(row.summary) as {
      summary?: string;
      details?: string;
      open?: string;
      tags?: string[];
      topics?: (string | TopicDetail)[];
    };

    if (parsed.summary) {
      console.log(`  ${parsed.summary}`);
    }
    if (parsed.tags?.length) {
      console.log(`  标签：${parsed.tags.join("、")}`);
    }
    // 新格式（平铺）：显示 open
    if (parsed.open) {
      console.log(`  未完成：${parsed.open}`);
    }
    // 旧格式（topics）：显示话题标题
    if (!parsed.details && parsed.topics?.length) {
      const titles = parsed.topics.map((t) => typeof t === "string" ? t : t.title);
      console.log(`  话题：${titles.join("、")}`);
    }
  } catch {
    console.log(`  ${row.summary}`);
  }
}

/** get 用：展开全部细节 */
function printSessionFull(row: SessionRow): void {
  printMeta(row);

  if (!row.summary) {
    console.log("  (无摘要)");
    return;
  }

  try {
    const parsed = JSON.parse(row.summary) as {
      summary?: string;
      details?: string;
      open?: string;
      tags?: string[];
      topics?: (string | TopicDetail)[];
      decisions?: string[];
      open_items?: string[];
    };

    if (parsed.summary) {
      console.log(`  ${parsed.summary}`);
    }
    if (parsed.tags?.length) {
      console.log(`  标签：${parsed.tags.join("、")}`);
    }

    // 新格式（平铺）
    if (parsed.details) {
      console.log("");
      console.log(`  ${parsed.details}`);
    }
    if (parsed.open) {
      console.log(`  未完成：${parsed.open}`);
    }

    // 旧格式（topics）
    if (!parsed.details && parsed.topics?.length) {
      console.log("");
      for (const t of parsed.topics) {
        if (typeof t === "string") {
          console.log(`  [${t}]`);
        } else {
          console.log(`  [${t.title}]`);
          if (t.summary) console.log(`    ${t.summary}`);
          if (t.decisions?.length) {
            for (const d of t.decisions) console.log(`    决策：${d}`);
          }
          if (t.open_items?.length) {
            for (const o of t.open_items) console.log(`    遗留：${o}`);
          }
        }
      }
    }
    if (!parsed.details && parsed.decisions?.length) {
      console.log("");
      for (const d of parsed.decisions) console.log(`  决策：${d}`);
    }
    if (!parsed.details && parsed.open_items?.length) {
      for (const o of parsed.open_items) console.log(`  遗留：${o}`);
    }
  } catch {
    console.log(`  ${row.summary}`);
  }
}
