/**
 * CLI: session-summary list/get + state-summary — query session summaries and global state.
 */

import type Database from "better-sqlite3";

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
  } else if (sub === "get") {
    sessionGet(db, args.slice(1), parseArgs);
  } else {
    console.log("Usage: niubot session-summary <list|get>");
  }
}

export function handleStateSummary(
  db: Database.Database,
  chatId: string | undefined,
): void {
  if (!chatId) {
    console.error("Error: NIUBOT_CHAT_ID not set");
    process.exit(1);
  }

  const row = db.prepare(
    "SELECT state_summary FROM chats WHERE id = ?",
  ).get(chatId) as { state_summary: string | null } | undefined;

  if (!row?.state_summary) {
    console.log("(无全局摘要)");
    return;
  }

  try {
    const state = JSON.parse(row.state_summary) as {
      summary?: string;
      topics?: Array<{ title: string; status?: string; summary: string }>;
    };

    if (state.summary) {
      console.log(state.summary);
    }
    if (state.topics?.length) {
      console.log("");
      for (const t of state.topics) {
        const status = t.status ? ` [${t.status}]` : "";
        console.log(`- ${t.title}${status}`);
        console.log(`  ${t.summary}`);
      }
    }
  } catch {
    // Fallback: print raw
    console.log(row.state_summary);
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

function sessionGet(
  db: Database.Database,
  args: string[],
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { positional } = parseArgs(args);
  const idArg = positional[0];
  if (!idArg) {
    console.error("Usage: niubot session-summary get <id>");
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
  const startTime = row.started_at?.replace("T", " ") ?? "?";
  const endTime = row.ended_at?.replace("T", " ") ?? "ongoing";
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

/** list 用：summary + 话题标题 */
function printSessionBrief(row: SessionRow): void {
  printMeta(row);

  if (!row.summary) {
    console.log("  (无摘要)");
    return;
  }

  try {
    const parsed = JSON.parse(row.summary) as {
      summary?: string;
      topics?: (string | TopicDetail)[];
    };

    if (parsed.summary) {
      console.log(`  ${parsed.summary}`);
    }
    if (parsed.topics?.length) {
      const titles = parsed.topics.map((t) => typeof t === "string" ? t : t.title);
      console.log(`  话题：${titles.join("、")}`);
    }
  } catch {
    console.log(`  ${row.summary}`);
  }
}

/** get 用：按话题展开全部细节 */
function printSessionFull(row: SessionRow): void {
  printMeta(row);

  if (!row.summary) {
    console.log("  (无摘要)");
    return;
  }

  try {
    const parsed = JSON.parse(row.summary) as {
      summary?: string;
      topics?: (string | TopicDetail)[];
      // 旧格式顶层字段
      decisions?: string[];
      open_items?: string[];
    };

    if (parsed.summary) {
      console.log(`  ${parsed.summary}`);
    }

    if (parsed.topics?.length) {
      console.log("");
      for (const t of parsed.topics) {
        if (typeof t === "string") {
          // 旧格式：纯标签
          console.log(`  [${t}]`);
        } else {
          // 新格式：话题对象
          console.log(`  [${t.title}]`);
          if (t.summary) {
            console.log(`    ${t.summary}`);
          }
          if (t.decisions?.length) {
            for (const d of t.decisions) {
              console.log(`    决策：${d}`);
            }
          }
          if (t.open_items?.length) {
            for (const o of t.open_items) {
              console.log(`    遗留：${o}`);
            }
          }
        }
      }
    }

    // 旧格式兼容：顶层 decisions/open_items
    if (parsed.decisions?.length) {
      console.log("");
      for (const d of parsed.decisions) {
        console.log(`  决策：${d}`);
      }
    }
    if (parsed.open_items?.length) {
      for (const o of parsed.open_items) {
        console.log(`  遗留：${o}`);
      }
    }
  } catch {
    console.log(`  ${row.summary}`);
  }
}
