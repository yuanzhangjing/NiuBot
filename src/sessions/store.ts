import type Database from "better-sqlite3";
import { assertChatAccess, type ChatAccessContext } from "../core/access.js";
import { userTimeRangeToUtc } from "../tz.js";

export interface SessionRow {
  id: string;
  chat_id: string;
  user_id: string | null;
  source: string;
  status: string;
  backend_type: string | null;
  agent_session_id: string | null;
  started_at: string;
  ended_at: string | null;
  start_msg_id: number | null;
  end_msg_id: number | null;
  message_count: number | null;
}

const SESSION_COLUMNS = `
  id, chat_id, user_id, source, status, backend_type, agent_session_id,
  started_at, ended_at, start_msg_id, end_msg_id, message_count
`;

export function listSessions(
  db: Database.Database,
  options: ChatAccessContext & {
    targetChatId: string;
    limit: number;
    since?: string;
    before?: string;
    after?: { endedAt: string; id: string };
  },
): SessionRow[] {
  assertChatAccess({
    currentChatId: options.currentChatId,
    chatType: options.chatType,
    targetChatId: options.targetChatId,
  });
  const conditions = ["chat_id = ?", "status = 'archived'", "ended_at IS NOT NULL"];
  const params: Array<string | number> = [options.targetChatId];
  const range = userTimeRangeToUtc({ since: options.since, before: options.before });
  if (range.since) {
    conditions.push("ended_at >= ?");
    params.push(range.since);
  }
  if (range.before) {
    conditions.push("ended_at < ?");
    params.push(range.before);
  }
  if (options.after) {
    conditions.push("(ended_at < ? OR (ended_at = ? AND id < ?))");
    params.push(options.after.endedAt, options.after.endedAt, options.after.id);
  }
  params.push(Math.max(1, Math.abs(options.limit)));
  return db.prepare(`
    SELECT ${SESSION_COLUMNS}
    FROM sessions
    WHERE ${conditions.join(" AND ")}
    ORDER BY ended_at DESC, id DESC
    LIMIT ?
  `).all(...params) as SessionRow[];
}

/** List archived sessions that may contain events inside a canonical UTC range. */
export function listSessionsOverlappingUtcRange(
  db: Database.Database,
  options: ChatAccessContext & {
    targetChatId: string;
    limit: number;
    sinceUtc?: string;
    beforeUtc?: string;
    through?: { endedAt: string; id: string };
  },
): SessionRow[] {
  assertChatAccess({
    currentChatId: options.currentChatId,
    chatType: options.chatType,
    targetChatId: options.targetChatId,
  });
  const conditions = ["chat_id = ?", "status = 'archived'", "ended_at IS NOT NULL"];
  const params: Array<string | number> = [options.targetChatId];
  if (options.sinceUtc) {
    conditions.push("ended_at >= ?");
    params.push(options.sinceUtc);
  }
  if (options.beforeUtc) {
    conditions.push("started_at < ?");
    params.push(options.beforeUtc);
  }
  if (options.through) {
    conditions.push("(ended_at < ? OR (ended_at = ? AND id <= ?))");
    params.push(options.through.endedAt, options.through.endedAt, options.through.id);
  }
  params.push(Math.max(1, Math.abs(options.limit)));
  return db.prepare(`
    SELECT ${SESSION_COLUMNS}
    FROM sessions
    WHERE ${conditions.join(" AND ")}
    ORDER BY ended_at DESC, id DESC
    LIMIT ?
  `).all(...params) as SessionRow[];
}

export function getSessionForAccess(
  db: Database.Database,
  id: string,
  context: ChatAccessContext,
): SessionRow | undefined {
  const row = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  if (row) {
    assertChatAccess({ currentChatId: context.currentChatId, chatType: context.chatType, targetChatId: row.chat_id });
  }
  return row;
}

export function hasEndedUserSession(db: Database.Database, chatId: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM sessions
    WHERE chat_id = ? AND ended_at IS NOT NULL AND source = 'user'
    LIMIT 1
  `).get(chatId);
  return !!row;
}
