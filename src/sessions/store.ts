import type Database from "better-sqlite3";
import { nativeSessionId } from "../agent/session-id.js";
import { assertChatAccess, type ChatAccessContext } from "../core/access.js";
import { userTimeRangeToUtc } from "../tz.js";

export interface SessionRow {
  id: string;
  chat_id: string;
  user_id: string | null;
  source: string;
  status: string;
  thread_id: string | null;
  backend_type: string | null;
  agent_session_id: string | null;
  started_at: string;
  ended_at: string | null;
  last_active_at: string | null;
  start_msg_id: number | null;
  end_msg_id: number | null;
  message_count: number | null;
  turn_count: number | null;
}

const SESSION_COLUMNS = `
  id, chat_id, user_id, source, status, thread_id, backend_type, agent_session_id,
  started_at, ended_at, last_active_at, start_msg_id, end_msg_id, message_count, turn_count
`;

export type SessionListStatus = "all" | "active" | "archived";

export interface SessionActivityCursor {
  activityAt: string;
  id: string;
}

const SESSION_ACTIVITY_COLUMN = "COALESCE(ended_at, last_active_at, started_at)";

export function listSessions(
  db: Database.Database,
  options: ChatAccessContext & {
    targetChatId: string;
    limit: number;
    threadId?: string;
    allThreads?: boolean;
    status?: SessionListStatus;
    since?: string;
    before?: string;
    after?: SessionActivityCursor;
  },
): SessionRow[] {
  assertChatAccess({
    currentChatId: options.currentChatId,
    chatType: options.chatType,
    targetChatId: options.targetChatId,
  });
  const conditions = ["chat_id = ?"];
  const params: Array<string | number> = [options.targetChatId];
  appendThreadFilter(conditions, params, options);
  if (options.status === "active") {
    conditions.push("status = 'active'");
  } else if (options.status === "archived") {
    conditions.push("status = 'archived'");
  }
  const range = userTimeRangeToUtc({ since: options.since, before: options.before });
  if (range.since) {
    conditions.push(`${SESSION_ACTIVITY_COLUMN} >= ?`);
    params.push(range.since);
  }
  if (range.before) {
    conditions.push(`${SESSION_ACTIVITY_COLUMN} < ?`);
    params.push(range.before);
  }
  if (options.after) {
    conditions.push(`(${SESSION_ACTIVITY_COLUMN} < ? OR (${SESSION_ACTIVITY_COLUMN} = ? AND id < ?))`);
    params.push(options.after.activityAt, options.after.activityAt, options.after.id);
  }
  params.push(Math.max(1, Math.abs(options.limit)));
  return db.prepare(`
    SELECT ${SESSION_COLUMNS}
    FROM sessions
    WHERE ${conditions.join(" AND ")}
    ORDER BY ${SESSION_ACTIVITY_COLUMN} DESC, id DESC
    LIMIT ?
  `).all(...params) as SessionRow[];
}

/** List sessions that may contain events inside a canonical UTC range；默认包含活跃会话。 */
export function listSessionsOverlappingUtcRange(
  db: Database.Database,
  options: ChatAccessContext & {
    targetChatId: string;
    limit: number;
    threadId?: string;
    allThreads?: boolean;
    status?: SessionListStatus;
    sinceUtc?: string;
    beforeUtc?: string;
    through?: SessionActivityCursor;
  },
): SessionRow[] {
  assertChatAccess({
    currentChatId: options.currentChatId,
    chatType: options.chatType,
    targetChatId: options.targetChatId,
  });
  const conditions = ["chat_id = ?"];
  const params: Array<string | number> = [options.targetChatId];
  appendThreadFilter(conditions, params, options);
  if (options.status === "active") {
    conditions.push("status = 'active'");
  } else if (options.status === "archived") {
    conditions.push("status = 'archived'");
  }
  if (options.sinceUtc) {
    conditions.push(`${SESSION_ACTIVITY_COLUMN} >= ?`);
    params.push(options.sinceUtc);
  }
  if (options.beforeUtc) {
    conditions.push("started_at < ?");
    params.push(options.beforeUtc);
  }
  if (options.through) {
    conditions.push(`(${SESSION_ACTIVITY_COLUMN} < ? OR (${SESSION_ACTIVITY_COLUMN} = ? AND id <= ?))`);
    params.push(options.through.activityAt, options.through.activityAt, options.through.id);
  }
  params.push(Math.max(1, Math.abs(options.limit)));
  return db.prepare(`
    SELECT ${SESSION_COLUMNS}
    FROM sessions
    WHERE ${conditions.join(" AND ")}
    ORDER BY ${SESSION_ACTIVITY_COLUMN} DESC, id DESC
    LIMIT ?
  `).all(...params) as SessionRow[];
}

function appendThreadFilter(
  conditions: string[],
  params: Array<string | number>,
  options: { threadId?: string; allThreads?: boolean },
): void {
  if (options.threadId !== undefined) {
    conditions.push("thread_id = ?");
    params.push(options.threadId);
  } else if (!options.allThreads) {
    conditions.push("thread_id IS NULL");
  }
}

/** 对外展示用 backend 原生 id；未绑定或仍是引擎句柄时回退到内部 sessions.id。 */
export function sessionPublicId(row: Pick<SessionRow, "id" | "agent_session_id">): string {
  return nativeSessionId(row.agent_session_id) || row.id;
}

export function getSessionForAccess(
  db: Database.Database,
  id: string,
  context: ChatAccessContext,
): SessionRow | undefined {
  const key = id.trim();
  if (!key) return undefined;
  const rows = db.prepare(`
    SELECT ${SESSION_COLUMNS} FROM sessions
    WHERE id = ? OR agent_session_id = ?
  `).all(key, key) as SessionRow[];
  if (rows.length === 0) return undefined;

  const inChat = context.currentChatId
    ? rows.filter((row) => row.chat_id === context.currentChatId)
    : rows;
  const candidates = inChat.length > 0 ? inChat : rows;
  const row = candidates.find((item) => item.agent_session_id === key)
    ?? candidates.find((item) => item.id === key)
    ?? candidates[0];
  if (!row) return undefined;
  assertChatAccess({
    currentChatId: context.currentChatId,
    chatType: context.chatType,
    targetChatId: row.chat_id,
  });
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
