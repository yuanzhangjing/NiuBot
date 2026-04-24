import type Database from "better-sqlite3";

export interface ContactAccessContext {
  chatType: "p2p" | "group";
}

export interface UserContact {
  id: string;
  name: string | null;
  name_source: string | null;
  platform: string;
  platform_id: string;
  is_bot: number;
  created_at: string;
}

export interface ChatContact {
  id: string;
  type: string;
  name: string | null;
  platform: string;
  platform_id: string;
  user_id: string | null;
  created_at: string;
}

export function assertContactsAccess(ctx: ContactAccessContext): void {
  if (ctx.chatType === "group") {
    throw new Error("contacts are only available in private chat");
  }
}

export function listUsers(db: Database.Database, filters: { name?: string; platform?: string }): UserContact[] {
  let sql = "SELECT id, name, name_source, platform, platform_id, is_bot, created_at FROM users";
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.name) {
    conditions.push("name LIKE ?");
    params.push(`%${filters.name}%`);
  }
  if (filters.platform) {
    conditions.push("platform = ?");
    params.push(filters.platform);
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)";

  return db.prepare(sql).all(...params) as UserContact[];
}

export function listChats(db: Database.Database, filters: { type?: string; name?: string; userId?: string }): ChatContact[] {
  let sql = "SELECT id, type, name, platform, platform_id, user_id, created_at FROM chats";
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.type) {
    conditions.push("type = ?");
    params.push(filters.type);
  }
  if (filters.name) {
    conditions.push("name LIKE ?");
    params.push(`%${filters.name}%`);
  }
  if (filters.userId) {
    conditions.push("user_id = (SELECT platform_id FROM users WHERE id = ?)");
    params.push(filters.userId.toLowerCase());
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)";

  return db.prepare(sql).all(...params) as ChatContact[];
}

export function resolveUserId(db: Database.Database, input: string): string | null {
  const lower = input.toLowerCase();
  if (/^u\d+$/.test(lower)) {
    const row = db.prepare("SELECT id FROM users WHERE id = ?").get(lower) as { id: string } | undefined;
    return row?.id ?? null;
  }
  const row = db.prepare("SELECT id FROM users WHERE platform_id = ?").get(input) as { id: string } | undefined;
  return row?.id ?? null;
}

export function resolveChatId(db: Database.Database, input: string): string | null {
  const lower = input.toLowerCase();
  if (/^c\d+$/.test(lower)) {
    const row = db.prepare("SELECT id FROM chats WHERE id = ?").get(lower) as { id: string } | undefined;
    return row?.id ?? null;
  }
  const row = db.prepare("SELECT id FROM chats WHERE platform_id = ?").get(input) as { id: string } | undefined;
  return row?.id ?? null;
}

export function getUser(db: Database.Database, id: string): UserContact | undefined {
  return db.prepare(
    "SELECT id, name, name_source, platform, platform_id, is_bot, created_at FROM users WHERE id = ?",
  ).get(id) as UserContact | undefined;
}

export function getChat(db: Database.Database, id: string): ChatContact | undefined {
  return db.prepare(
    "SELECT id, type, name, platform, platform_id, user_id, created_at FROM chats WHERE id = ?",
  ).get(id) as ChatContact | undefined;
}

export function setUserManualName(db: Database.Database, userId: string, name: string): void {
  const result = db.prepare("UPDATE users SET name = ?, name_source = 'manual' WHERE id = ?").run(name, userId);
  if (result.changes === 0) {
    throw new Error(`User "${userId}" not found`);
  }
}

export function countUserMemories(db: Database.Database, userId: string): number {
  const row = db.prepare("SELECT COUNT(*) as n FROM user_memory WHERE user_id = ?").get(userId) as { n: number };
  return row.n;
}

export function countChatMessages(db: Database.Database, chatId: string): number {
  const row = db.prepare("SELECT COUNT(*) as n FROM messages WHERE chat_id = ?").get(chatId) as { n: number };
  return row.n;
}

export function countChatSessions(db: Database.Database, chatId: string): number {
  const row = db.prepare("SELECT COUNT(*) as n FROM sessions WHERE chat_id = ?").get(chatId) as { n: number };
  return row.n;
}
