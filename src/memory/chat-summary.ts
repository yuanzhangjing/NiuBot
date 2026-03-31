import type Database from "better-sqlite3";

export type SummaryLevel = "overview" | "daily" | "weekly";

export interface ChatSummaryEntry {
  id: number;
  chatId: string;
  level: SummaryLevel;
  summary: string;
  detail: string;
  period: string | null;
  startMsgId: number | null;
  endMsgId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface RawRow {
  id: number;
  chat_id: string;
  level: string;
  summary: string;
  detail: string;
  period: string | null;
  start_msg_id: number | null;
  end_msg_id: number | null;
  created_at: string;
  updated_at: string;
}

function toEntry(r: RawRow): ChatSummaryEntry {
  return {
    id: r.id,
    chatId: r.chat_id,
    level: r.level as SummaryLevel,
    summary: r.summary,
    detail: r.detail,
    period: r.period,
    startMsgId: r.start_msg_id,
    endMsgId: r.end_msg_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** 获取 overview（每个 chat 最多一条） */
export function getOverview(
  db: Database.Database,
  chatId: string,
): ChatSummaryEntry | undefined {
  const row = db.prepare(
    "SELECT * FROM chat_summary WHERE chat_id = ? AND level = 'overview'",
  ).get(chatId) as RawRow | undefined;

  return row ? toEntry(row) : undefined;
}

/** 创建或更新 overview。date 为覆盖截止日期（可选） */
export function upsertOverview(
  db: Database.Database,
  chatId: string,
  summary: string,
  detail = "",
  date?: string,
): number {
  const existing = getOverview(db, chatId);

  if (existing) {
    db.prepare(
      "UPDATE chat_summary SET summary = ?, detail = ?, period = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(summary, detail, date ?? existing.period, existing.id);
    return existing.id;
  }

  const result = db.prepare(
    "INSERT INTO chat_summary (chat_id, level, summary, detail, period) VALUES (?, 'overview', ?, ?, ?)",
  ).run(chatId, summary, detail, date ?? null);

  return Number(result.lastInsertRowid);
}

/** 按日期 upsert daily（同一天覆盖） */
export function upsertDaily(
  db: Database.Database,
  chatId: string,
  date: string,
  summary: string,
  detail = "",
  startMsgId?: number,
  endMsgId?: number,
): number {
  const existing = db.prepare(
    "SELECT id FROM chat_summary WHERE chat_id = ? AND level = 'daily' AND period = ?",
  ).get(chatId, date) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE chat_summary
      SET summary = ?, detail = ?, start_msg_id = ?, end_msg_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(summary, detail, startMsgId ?? null, endMsgId ?? null, existing.id);
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO chat_summary (chat_id, level, summary, detail, period, start_msg_id, end_msg_id)
    VALUES (?, 'daily', ?, ?, ?, ?, ?)
  `).run(chatId, summary, detail, date, startMsgId ?? null, endMsgId ?? null);

  return Number(result.lastInsertRowid);
}

/** 按周 upsert weekly（week 为该周一日期） */
export function upsertWeekly(
  db: Database.Database,
  chatId: string,
  weekMonday: string,
  summary: string,
  detail = "",
): number {
  const existing = db.prepare(
    "SELECT id FROM chat_summary WHERE chat_id = ? AND level = 'weekly' AND period = ?",
  ).get(chatId, weekMonday) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      "UPDATE chat_summary SET summary = ?, detail = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(summary, detail, existing.id);
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO chat_summary (chat_id, level, summary, detail, period)
    VALUES (?, 'weekly', ?, ?, ?)
  `).run(chatId, summary, detail, weekMonday);

  return Number(result.lastInsertRowid);
}

export interface ListOptions {
  since?: string;
  before?: string;
  limit?: number;
}

/** 获取 daily 列表（支持 since/before/limit） */
export function listDailies(
  db: Database.Database,
  chatId: string,
  opts: ListOptions = {},
): ChatSummaryEntry[] {
  let sql = "SELECT * FROM chat_summary WHERE chat_id = ? AND level = 'daily'";
  const params: unknown[] = [chatId];

  if (opts.since) {
    sql += " AND period >= ?";
    params.push(opts.since);
  }
  if (opts.before) {
    sql += " AND period < ?";
    params.push(opts.before);
  }

  sql += " ORDER BY period DESC LIMIT ?";
  params.push(opts.limit ?? 7);

  const rows = db.prepare(sql).all(...params) as RawRow[];
  return rows.map(toEntry);
}

/** 获取 weekly 列表（支持 since/before/limit，匹配范围重叠） */
export function listWeeklies(
  db: Database.Database,
  chatId: string,
  opts: ListOptions = {},
): ChatSummaryEntry[] {
  let sql = "SELECT * FROM chat_summary WHERE chat_id = ? AND level = 'weekly'";
  const params: unknown[] = [chatId];

  // weekly period 是周一日期，覆盖周一到周日
  // since: 返回周日 >= since 的条目（period + 6 天 >= since）
  if (opts.since) {
    sql += " AND date(period, '+6 days') >= ?";
    params.push(opts.since);
  }
  // before: 返回周一 < before 的条目
  if (opts.before) {
    sql += " AND period < ?";
    params.push(opts.before);
  }

  sql += " ORDER BY period DESC LIMIT ?";
  params.push(opts.limit ?? 4);

  const rows = db.prepare(sql).all(...params) as RawRow[];
  return rows.map(toEntry);
}

/** 获取单条详情 */
export function getChatSummary(
  db: Database.Database,
  id: number,
): ChatSummaryEntry | undefined {
  const row = db.prepare("SELECT * FROM chat_summary WHERE id = ?").get(id) as RawRow | undefined;
  return row ? toEntry(row) : undefined;
}

/** 删除 */
export function deleteChatSummary(db: Database.Database, id: number): boolean {
  const result = db.prepare("DELETE FROM chat_summary WHERE id = ?").run(id);
  return result.changes > 0;
}

/** 将任意日期转换为该周一日期 */
export function toMonday(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

/** 从周一日期算出周日日期 */
export function toSunday(mondayStr: string): string {
  const d = new Date(mondayStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}
