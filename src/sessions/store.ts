import type Database from "better-sqlite3";

export function hasEndedUserSession(db: Database.Database, chatId: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM sessions
    WHERE chat_id = ? AND ended_at IS NOT NULL AND source = 'user'
    LIMIT 1
  `).get(chatId);
  return !!row;
}
