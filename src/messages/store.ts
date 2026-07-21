import type Database from "better-sqlite3";
import { assertAllChatsAccess, assertChatAccess, type ChatAccessContext } from "../core/access.js";
import { userTimeRangeToUtc } from "../tz.js";

export interface MessageRow {
  id: number;
  chat_id: string;
  sender_id: string;
  role: string;
  content_text: string | null;
  content_type: string;
  created_at: string;
  sender_name: string | null;
}

export interface ContinuationMessageRow {
  sender_id: string | null;
  role: string;
  sender_name: string | null;
  content_text: string;
}

export interface SessionMessageRow {
  id: number;
  role: "user" | "assistant";
  content_text: string;
}

export interface SessionExchange {
  user?: SessionMessageRow;
  response?: SessionMessageRow;
}

export interface SessionEdgeExchanges {
  first: SessionExchange;
  last: SessionExchange;
}

export interface MessageFilter {
  since?: string;
  before?: string;
  role?: string;
  userId?: string;
  contentType?: string;
}

const MESSAGE_COLUMNS = `
  m.id, m.chat_id, m.sender_id, m.role, m.content_text, m.content_type, m.created_at,
  u.name as sender_name
`;

export function listMessages(
  db: Database.Database,
  options: ChatAccessContext & MessageFilter & {
    targetChatId: string;
    limit: number;
    offset?: number;
  },
): MessageRow[] {
  assertChatAccess({ currentChatId: options.currentChatId, chatType: options.chatType, targetChatId: options.targetChatId });

  let sql = `
    SELECT ${MESSAGE_COLUMNS}
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    WHERE m.chat_id = ?
  `;
  const params: unknown[] = [options.targetChatId];
  sql = appendMessageFilters(sql, params, options);

  if (options.offset !== undefined) {
    if (options.limit < 0) {
      sql += " AND m.id < ? ORDER BY m.id DESC LIMIT ?";
      params.push(options.offset, Math.abs(options.limit));
    } else {
      sql += " AND m.id > ? ORDER BY m.id ASC LIMIT ?";
      params.push(options.offset, options.limit);
    }
  } else {
    sql += " ORDER BY m.id DESC LIMIT ?";
    params.push(Math.abs(options.limit));
  }

  const rows = db.prepare(sql).all(...params) as MessageRow[];
  if (options.offset === undefined || options.limit < 0) rows.reverse();
  return rows;
}

export function searchMessages(
  db: Database.Database,
  options: ChatAccessContext & MessageFilter & {
    query: string;
    searchAll?: boolean;
    targetChatId?: string;
    targetChatType?: "p2p" | "group";
    limit: number;
  },
): MessageRow[] {
  if (options.searchAll) {
    assertAllChatsAccess({ chatType: options.chatType });
  } else if (options.targetChatId) {
    assertChatAccess({ currentChatId: options.currentChatId, chatType: options.chatType, targetChatId: options.targetChatId });
  } else {
    throw new Error("targetChatId is required unless searchAll is true");
  }

  let sql = `
    SELECT ${MESSAGE_COLUMNS}
    FROM messages m
    JOIN messages_fts ON messages_fts.rowid = m.id
    LEFT JOIN users u ON m.sender_id = u.id
    WHERE messages_fts MATCH ?
  `;
  const params: unknown[] = [options.query];

  if (!options.searchAll && options.targetChatId) {
    sql += " AND m.chat_id = ?";
    params.push(options.targetChatId);
  }
  if (options.searchAll && options.targetChatType) {
    sql += " AND m.chat_id IN (SELECT id FROM chats WHERE type = ?)";
    params.push(options.targetChatType);
  }
  sql = appendMessageFilters(sql, params, options);
  sql += " ORDER BY m.id DESC LIMIT ?";
  params.push(options.limit);

  const rows = db.prepare(sql).all(...params) as MessageRow[];
  rows.reverse();
  return rows;
}

export function getMessageForAccess(
  db: Database.Database,
  id: number,
  ctx: ChatAccessContext,
): MessageRow | undefined {
  const row = db.prepare(`
    SELECT ${MESSAGE_COLUMNS}
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    WHERE m.id = ?
  `).get(id) as MessageRow | undefined;
  if (row) {
    assertChatAccess({ currentChatId: ctx.currentChatId, chatType: ctx.chatType, targetChatId: row.chat_id });
  }
  return row;
}

export function getMessageContextRows(
  db: Database.Database,
  chatId: string,
  messageId: number,
  contextCount: number,
): MessageRow[] {
  return db.prepare(`
    SELECT ${MESSAGE_COLUMNS}
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    WHERE m.chat_id = ? AND m.id BETWEEN ? AND ?
    ORDER BY m.id
  `).all(chatId, messageId - contextCount, messageId + contextCount) as MessageRow[];
}

export function listContinuationMessages(
  db: Database.Database,
  options: {
    chatId: string;
    beforeMsgId?: number;
    limit: number;
  },
): ContinuationMessageRow[] {
  const cutoff = options.beforeMsgId != null ? "AND m.id < ?" : "";
  const params: (string | number)[] = [options.chatId];
  if (options.beforeMsgId != null) params.push(options.beforeMsgId);
  params.push(options.limit);

  const rows = db.prepare(`
    SELECT m.sender_id, m.role, u.name AS sender_name, m.content_text
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    WHERE m.chat_id = ? AND m.content_text IS NOT NULL ${cutoff}
    ORDER BY m.id DESC
    LIMIT ?
  `).all(...params) as ContinuationMessageRow[];
  rows.reverse();
  return rows;
}

export function listSessionMessages(db: Database.Database, sessionId: string): SessionMessageRow[] {
  return db.prepare(`
    SELECT id, role, content_text
    FROM messages
    WHERE session_key = ? AND role IN ('user', 'assistant') AND content_text IS NOT NULL
    ORDER BY id
  `).all(sessionId) as SessionMessageRow[];
}

/** First and last completed exchanges, without scanning transcript sources. */
export function getSessionEdgeExchanges(db: Database.Database, sessionId: string): SessionEdgeExchanges {
  const firstResponse = getSessionResponse(db, sessionId, "ASC");
  const lastResponse = getSessionResponse(db, sessionId, "DESC");
  if (!firstResponse || !lastResponse) {
    return {
      first: { user: getSessionUser(db, sessionId, "ASC") },
      last: { user: getSessionUser(db, sessionId, "DESC") },
    };
  }
  return {
    first: { user: getUserBeforeResponse(db, sessionId, firstResponse.id), response: firstResponse },
    last: { user: getUserBeforeResponse(db, sessionId, lastResponse.id), response: lastResponse },
  };
}

function getSessionResponse(
  db: Database.Database,
  sessionId: string,
  order: "ASC" | "DESC",
): SessionMessageRow | undefined {
  return db.prepare(`
    SELECT m.id, m.role, m.content_text
    FROM messages m
    WHERE m.session_key = ?
      AND m.role = 'assistant'
      AND m.content_text IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM messages u
        WHERE u.session_key = m.session_key
          AND u.role = 'user'
          AND u.content_text IS NOT NULL
          AND u.id < m.id
      )
    ORDER BY m.id ${order}
    LIMIT 1
  `).get(sessionId) as SessionMessageRow | undefined;
}

function getSessionUser(
  db: Database.Database,
  sessionId: string,
  order: "ASC" | "DESC",
): SessionMessageRow | undefined {
  return db.prepare(`
    SELECT id, role, content_text
    FROM messages
    WHERE session_key = ? AND role = 'user' AND content_text IS NOT NULL
    ORDER BY id ${order}
    LIMIT 1
  `).get(sessionId) as SessionMessageRow | undefined;
}

function getUserBeforeResponse(
  db: Database.Database,
  sessionId: string,
  responseId: number,
): SessionMessageRow | undefined {
  return db.prepare(`
    SELECT id, role, content_text
    FROM messages
    WHERE session_key = ? AND role = 'user' AND content_text IS NOT NULL AND id < ?
    ORDER BY id DESC
    LIMIT 1
  `).get(sessionId, responseId) as SessionMessageRow | undefined;
}

function appendMessageFilters(sql: string, params: unknown[], filters: MessageFilter): string {
  const range = userTimeRangeToUtc({ since: filters.since, before: filters.before });
  if (range.since) {
    sql += " AND m.created_at >= ?";
    params.push(range.since);
  }
  if (range.before) {
    sql += " AND m.created_at < ?";
    params.push(range.before);
  }
  if (filters.role) {
    sql += " AND m.role = ?";
    params.push(filters.role);
  }
  if (filters.userId) {
    sql += " AND m.sender_id = ?";
    params.push(filters.userId.toLowerCase());
  }
  if (filters.contentType) {
    sql += " AND m.content_type = ?";
    params.push(filters.contentType);
  }
  return sql;
}
