import Database from "better-sqlite3";
import { createLogger } from "../logger.js";

const log = createLogger("database");

export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      name        TEXT,
      name_source TEXT DEFAULT 'platform',
      platform    TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      is_bot      INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(platform, platform_id)
    );

    CREATE TABLE IF NOT EXISTS chats (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      name        TEXT,
      platform    TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(platform, platform_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id               TEXT PRIMARY KEY,
      chat_id          TEXT NOT NULL,
      user_id          TEXT,
      source           TEXT DEFAULT 'user',
      status           TEXT DEFAULT 'active',
      message_count    INTEGER DEFAULT 0,
      turn_count       INTEGER DEFAULT 0,
      cumulative_bytes INTEGER DEFAULT 0,
      start_msg_id     INTEGER,
      end_msg_id       INTEGER,
      started_at       TEXT DEFAULT (datetime('now')),
      last_active_at   TEXT,
      ended_at         TEXT,
      summary          TEXT,
      topics           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(chat_id, last_active_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY,
      chat_id         TEXT NOT NULL,
      sender_id       TEXT NOT NULL,
      session_key     TEXT,
      role            TEXT NOT NULL,
      content_text    TEXT,
      content_type    TEXT DEFAULT 'text',
      reply_to        INTEGER,
      created_at      TEXT DEFAULT (datetime('now')),
      platform        TEXT NOT NULL,
      platform_msg_id TEXT,
      platform_ts     TEXT,
      platform_raw    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_key);
  `);

  // FTS5 单独建，因为 IF NOT EXISTS 对虚拟表不生效
  try {
    db.exec(`
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content_text,
        content='messages',
        content_rowid='id'
      );
    `);
  } catch {
    // 已存在，忽略
  }

  log.info("database initialized", { path: dbPath });
  return db;
}

/** 确保用户存在，返回内部 ID */
export function ensureUser(
  db: Database.Database,
  platform: string,
  platformId: string,
  name?: string,
): string {
  const existing = db.prepare(
    "SELECT id FROM users WHERE platform = ? AND platform_id = ?",
  ).get(platform, platformId) as { id: string } | undefined;

  if (existing) return existing.id;

  const count = db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
  const id = `u${count.c + 1}`;

  db.prepare(
    "INSERT INTO users (id, name, platform, platform_id) VALUES (?, ?, ?, ?)",
  ).run(id, name ?? null, platform, platformId);

  log.info("user created", { id, platform, platformId, name });
  return id;
}

/** 确保会话存在，返回内部 ID */
export function ensureChat(
  db: Database.Database,
  platform: string,
  platformId: string,
  type: "p2p" | "group",
  name?: string,
): string {
  const existing = db.prepare(
    "SELECT id FROM chats WHERE platform = ? AND platform_id = ?",
  ).get(platform, platformId) as { id: string } | undefined;

  if (existing) return existing.id;

  const count = db.prepare("SELECT COUNT(*) as c FROM chats").get() as { c: number };
  const id = `c${count.c + 1}`;

  db.prepare(
    "INSERT INTO chats (id, type, name, platform, platform_id) VALUES (?, ?, ?, ?, ?)",
  ).run(id, type, name ?? null, platform, platformId);

  log.info("chat created", { id, type, platform, platformId });
  return id;
}

/** 存储消息，返回内部消息 ID */
export function storeMessage(
  db: Database.Database,
  msg: {
    chatId: string;
    senderId: string;
    sessionKey?: string;
    role: string;
    contentText?: string;
    contentType?: string;
    replyTo?: number;
    platform: string;
    platformMsgId?: string;
    platformRaw?: string;
  },
): number {
  const result = db.prepare(`
    INSERT INTO messages (chat_id, sender_id, session_key, role, content_text, content_type, reply_to, platform, platform_msg_id, platform_raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.chatId,
    msg.senderId,
    msg.sessionKey ?? null,
    msg.role,
    msg.contentText ?? null,
    msg.contentType ?? "text",
    msg.replyTo ?? null,
    msg.platform,
    msg.platformMsgId ?? null,
    msg.platformRaw ?? null,
  );

  const msgId = Number(result.lastInsertRowid);

  // 更新 FTS 索引
  if (msg.contentText) {
    db.prepare(
      "INSERT INTO messages_fts (rowid, content_text) VALUES (?, ?)",
    ).run(msgId, msg.contentText);
  }

  return msgId;
}
