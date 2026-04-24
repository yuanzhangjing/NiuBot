import type Database from "better-sqlite3";
import { assertChatAccess, type ChatAccessContext } from "../core/access.js";

export interface SessionRow {
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

export const SESSION_COLUMNS = "id, chat_id, user_id, source, status, summary, topics, started_at, ended_at, start_msg_id, end_msg_id, message_count";

export function listSessions(
  db: Database.Database,
  options: ChatAccessContext & {
    targetChatId: string;
    limit: number;
    since?: string;
    before?: string;
    offset?: string;
  },
): SessionRow[] {
  assertChatAccess({ currentChatId: options.currentChatId, chatType: options.chatType, targetChatId: options.targetChatId });
  const { conditions, params } = buildSessionConditions(db, options);
  params.push(Math.abs(options.limit));

  return db.prepare(`
    SELECT ${SESSION_COLUMNS}
    FROM sessions
    WHERE ${conditions.join(" AND ")}
    ORDER BY ended_at DESC
    LIMIT ?
  `).all(...params) as SessionRow[];
}

export function searchSessions(
  db: Database.Database,
  options: ChatAccessContext & {
    targetChatId: string;
    query: string;
    limit: number;
    since?: string;
    before?: string;
    offset?: string;
  },
): SessionRow[] {
  assertChatAccess({ currentChatId: options.currentChatId, chatType: options.chatType, targetChatId: options.targetChatId });
  const { conditions, params } = buildSessionConditions(db, options);
  conditions.push("(summary LIKE ? OR topics LIKE ?)");
  const likePattern = `%${options.query}%`;
  params.push(likePattern, likePattern);
  params.push(Math.abs(options.limit));

  return db.prepare(`
    SELECT ${SESSION_COLUMNS}
    FROM sessions
    WHERE ${conditions.join(" AND ")}
    ORDER BY ended_at DESC
    LIMIT ?
  `).all(...params) as SessionRow[];
}

export function getSessionForAccess(
  db: Database.Database,
  id: string,
  ctx: ChatAccessContext,
): SessionRow | undefined {
  const row = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
    .get(id) as SessionRow | undefined;
  if (row) {
    assertChatAccess({ currentChatId: ctx.currentChatId, chatType: ctx.chatType, targetChatId: row.chat_id });
  }
  return row;
}

export function listRecentUserArchivedSessions(
  db: Database.Database,
  options: {
    chatId: string;
    since: string;
    limit: number;
  },
): SessionRow[] {
  return db.prepare(`
    SELECT ${SESSION_COLUMNS}
    FROM sessions
    WHERE chat_id = ? AND status = 'archived' AND summary IS NOT NULL AND source = 'user'
      AND ended_at >= ?
    ORDER BY ended_at DESC
    LIMIT ?
  `).all(options.chatId, options.since, options.limit) as SessionRow[];
}

export function hasUserArchivedSession(db: Database.Database, chatId: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM sessions
    WHERE chat_id = ? AND status = 'archived' AND source = 'user'
    LIMIT 1
  `).get(chatId);
  return !!row;
}

function buildSessionConditions(
  db: Database.Database,
  options: {
    targetChatId: string;
    since?: string;
    before?: string;
    offset?: string;
  },
): { conditions: string[]; params: (string | number)[] } {
  const conditions = ["chat_id = ?", "summary IS NOT NULL"];
  const params: (string | number)[] = [options.targetChatId];

  if (options.since) {
    conditions.push("ended_at >= ?");
    params.push(options.since);
  }
  if (options.before) {
    conditions.push("ended_at < ?");
    params.push(options.before);
  }
  if (options.offset) {
    const offsetRow = db.prepare("SELECT ended_at FROM sessions WHERE id = ?").get(options.offset) as { ended_at: string | null } | undefined;
    if (offsetRow?.ended_at) {
      conditions.push("ended_at < ?");
      params.push(offsetRow.ended_at);
    }
  }

  return { conditions, params };
}
