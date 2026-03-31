import type Database from "better-sqlite3";

const MAX_ENTRIES_PER_USER = 20;

export interface UserMemoryEntry {
  id: number;
  userId: string;
  summary: string;
  detail: string;
  sourceChat: string | null;
  visibility: "private" | "public";
  createdAt: string;
  updatedAt: string;
}

interface RawRow {
  id: number;
  user_id: string;
  summary: string;
  detail: string;
  source_chat: string | null;
  visibility: string;
  created_at: string;
  updated_at: string;
}

function toEntry(r: RawRow): UserMemoryEntry {
  return {
    id: r.id,
    userId: r.user_id,
    summary: r.summary,
    detail: r.detail,
    sourceChat: r.source_chat,
    visibility: r.visibility as "private" | "public",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function addUserMemory(
  db: Database.Database,
  userId: string,
  summary: string,
  detail = "",
  visibility: "private" | "public" = "private",
  sourceChat?: string,
): number {
  const count = db.prepare(
    "SELECT COUNT(*) as n FROM user_memory WHERE user_id = ?",
  ).get(userId) as { n: number };

  if (count.n >= MAX_ENTRIES_PER_USER) {
    throw new Error(`User ${userId} has reached the ${MAX_ENTRIES_PER_USER} memory limit. Update or delete existing entries first.`);
  }

  const result = db.prepare(
    "INSERT INTO user_memory (user_id, summary, detail, visibility, source_chat) VALUES (?, ?, ?, ?, ?)",
  ).run(userId, summary, detail, visibility, sourceChat ?? null);

  return Number(result.lastInsertRowid);
}

export function listUserMemory(
  db: Database.Database,
  userId: string,
  visibilityFilter?: "private" | "public",
): UserMemoryEntry[] {
  let sql = "SELECT * FROM user_memory WHERE user_id = ?";
  const params: unknown[] = [userId];

  if (visibilityFilter) {
    sql += " AND visibility = ?";
    params.push(visibilityFilter);
  }

  sql += " ORDER BY id";

  const rows = db.prepare(sql).all(...params) as RawRow[];
  return rows.map(toEntry);
}

export function getUserMemory(
  db: Database.Database,
  id: number,
): UserMemoryEntry | undefined {
  const row = db.prepare("SELECT * FROM user_memory WHERE id = ?").get(id) as RawRow | undefined;
  return row ? toEntry(row) : undefined;
}

export function updateUserMemory(
  db: Database.Database,
  id: number,
  updates: { summary?: string; detail?: string; visibility?: "private" | "public" },
): boolean {
  const fields: string[] = [];
  const params: unknown[] = [];

  if (updates.summary !== undefined) {
    fields.push("summary = ?");
    params.push(updates.summary);
  }
  if (updates.detail !== undefined) {
    fields.push("detail = ?");
    params.push(updates.detail);
  }
  if (updates.visibility !== undefined) {
    fields.push("visibility = ?");
    params.push(updates.visibility);
  }

  if (fields.length === 0) return false;

  fields.push("updated_at = datetime('now')");
  params.push(id);

  const result = db.prepare(
    `UPDATE user_memory SET ${fields.join(", ")} WHERE id = ?`,
  ).run(...params);

  return result.changes > 0;
}

export function deleteUserMemory(db: Database.Database, id: number): boolean {
  const result = db.prepare("DELETE FROM user_memory WHERE id = ?").run(id);
  return result.changes > 0;
}
