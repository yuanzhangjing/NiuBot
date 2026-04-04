import Database from "better-sqlite3";
import { createLogger } from "../logger.js";

const log = createLogger("database");

// ── Schema versioning ───────────────────────────────────────────────

interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

/**
 * 迁移列表。每个条目对应一个 schema 版本。
 * - version 必须连续递增（1, 2, 3, ...）
 * - up() 应该是幂等的（使用 IF NOT EXISTS 等）
 * - 新版本追加到末尾，不修改已有条目
 */
const migrations: Migration[] = [
  {
    version: 1,
    description: "Initial schema: users, chats, sessions, messages, user_memory, chat_summary, FTS",
    up: (db) => {
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

        CREATE TABLE IF NOT EXISTS user_memory (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id     TEXT NOT NULL,
          summary     TEXT NOT NULL,
          detail      TEXT DEFAULT '',
          source_chat TEXT,
          visibility  TEXT DEFAULT 'private',
          created_at  TEXT DEFAULT (datetime('now')),
          updated_at  TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_user_memory_user ON user_memory(user_id);

        CREATE TABLE IF NOT EXISTS chat_summary (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id      TEXT NOT NULL,
          level        TEXT NOT NULL,
          summary      TEXT NOT NULL,
          detail       TEXT DEFAULT '',
          period       TEXT,
          start_msg_id INTEGER,
          end_msg_id   INTEGER,
          created_at   TEXT DEFAULT (datetime('now')),
          updated_at   TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_chat_summary_chat_level ON chat_summary(chat_id, level);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_summary_unique ON chat_summary(chat_id, level, period);
      `);

      // FTS5 虚拟表不支持 IF NOT EXISTS
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
    },
  },
  {
    version: 2,
    description: "M4: busy_timeout, chats.user_id, users name_source priority, cron_jobs table, messages.platform_ts",
    up: (db) => {
      db.pragma("busy_timeout = 5000");

      // chats.user_id: for p2p chats, links to peer's open_id
      db.exec("ALTER TABLE chats ADD COLUMN user_id TEXT");

      // messages.platform_ts: explicit platform-side timestamp
      // (may already exist via platform_raw, but dedicated column for queries)
      try {
        db.exec("ALTER TABLE messages ADD COLUMN platform_ts TEXT");
      } catch {
        // column already exists from v1 schema
      }

      // cron_jobs table for scheduled tasks
      db.exec(`
        CREATE TABLE IF NOT EXISTS cron_jobs (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id         TEXT NOT NULL,
          creator_user_id TEXT NOT NULL,
          cron_expr       TEXT,
          run_at          TEXT,
          prompt          TEXT NOT NULL,
          description     TEXT DEFAULT '',
          max_times       INTEGER,
          until_time      TEXT,
          run_count       INTEGER DEFAULT 0,
          status          TEXT DEFAULT 'active',
          created_at      TEXT DEFAULT (datetime('now')),
          last_run_at     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_cron_jobs_status ON cron_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_cron_jobs_chat ON cron_jobs(chat_id);
      `);
    },
  },
  {
    version: 3,
    description: "M4: sessions.agent_session_id for Claude CLI resume on recover",
    up: (db) => {
      db.exec("ALTER TABLE sessions ADD COLUMN agent_session_id TEXT");
    },
  },
];

const LATEST_VERSION = migrations[migrations.length - 1]!.version;

// ── Database initialization ─────────────────────────────────────────

export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  runMigrations(db);

  log.info("database initialized", { path: dbPath, schemaVersion: getSchemaVersion(db) });
  return db;
}

function getSchemaVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

function setSchemaVersion(db: Database.Database, version: number): void {
  db.pragma(`user_version = ${version}`);
}

function runMigrations(db: Database.Database): void {
  let currentVersion = getSchemaVersion(db);

  // 已有 DB 但从未设过版本号（user_version 默认 0）
  if (currentVersion === 0) {
    const hasTable = db.prepare(
      "SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='users'",
    ).get() as { n: number };

    if (hasTable.n > 0) {
      // 已有表结构，视为 v1
      currentVersion = 1;
      setSchemaVersion(db, 1);
      log.info("existing database detected, set schema version to 1");
    }
  }

  // 版本高于代码：DB 由更新版本创建，拒绝启动防止数据损坏
  if (currentVersion > LATEST_VERSION) {
    throw new Error(
      `Database schema version (${currentVersion}) is newer than code (${LATEST_VERSION}). ` +
      "Please upgrade NiuBot to a version that supports this database.",
    );
  }

  // 跑 pending migrations
  const pending = migrations.filter((m) => m.version > currentVersion);
  if (pending.length === 0) return;

  for (const migration of pending) {
    log.info("running migration", { version: migration.version, description: migration.description });
    db.transaction(() => {
      migration.up(db);
      setSchemaVersion(db, migration.version);
    })();
    log.info("migration completed", { version: migration.version });
  }
}

// ── CRUD helpers ────────────────────────────────────────────────────

/**
 * Name source priority (higher = better, won't overwrite with lower):
 * manual > bot_info > app_info > api > mention > bot_sender > platform
 */
const NAME_SOURCE_PRIORITY: Record<string, number> = {
  platform: 0,
  bot_sender: 1,
  mention: 2,
  api: 3,
  app_info: 4,
  bot_info: 5,
  manual: 6,
};

/** 确保用户存在，返回内部 ID。事务保护防止并发 ID 冲突 */
export function ensureUser(
  db: Database.Database,
  platform: string,
  platformId: string,
  name?: string,
  nameSource?: string,
): string {
  const tx = db.transaction(
    (p: string, pid: string, n: string | null, ns: string | null): string => {
      const existing = db.prepare(
        "SELECT id, name, name_source FROM users WHERE platform = ? AND platform_id = ?",
      ).get(p, pid) as { id: string; name: string | null; name_source: string | null } | undefined;

      if (existing) {
        // Update name if new source has higher priority
        if (n && ns) {
          const currentPriority = NAME_SOURCE_PRIORITY[existing.name_source ?? "platform"] ?? 0;
          const newPriority = NAME_SOURCE_PRIORITY[ns] ?? 0;
          if (newPriority >= currentPriority && n !== existing.name) {
            db.prepare("UPDATE users SET name = ?, name_source = ? WHERE id = ?")
              .run(n, ns, existing.id);
            log.info("user name updated", { id: existing.id, name: n, source: ns });
          }
        }
        return existing.id;
      }

      const max = db.prepare(
        "SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) as n FROM users",
      ).get() as { n: number | null };
      const id = `u${(max.n ?? 0) + 1}`;

      db.prepare(
        "INSERT INTO users (id, name, name_source, platform, platform_id) VALUES (?, ?, ?, ?, ?)",
      ).run(id, n, ns ?? "platform", p, pid);

      log.info("user created", { id, platform: p, platformId: pid, name: n });
      return id;
    },
  );
  return tx(platform, platformId, name ?? null, nameSource ?? null) as string;
}

/** Update user name with source priority check */
export function updateUserName(
  db: Database.Database,
  userId: string,
  name: string,
  nameSource: string,
): void {
  const existing = db.prepare(
    "SELECT name, name_source FROM users WHERE id = ?",
  ).get(userId) as { name: string | null; name_source: string | null } | undefined;
  if (!existing) return;

  const currentPriority = NAME_SOURCE_PRIORITY[existing.name_source ?? "platform"] ?? 0;
  const newPriority = NAME_SOURCE_PRIORITY[nameSource] ?? 0;
  if (newPriority >= currentPriority && name !== existing.name) {
    db.prepare("UPDATE users SET name = ?, name_source = ? WHERE id = ?")
      .run(name, nameSource, userId);
  }
}

/** Get user short label: "U3(张三)" or "U3" */
export function getUserShortLabel(
  db: Database.Database,
  userId: string,
): string {
  const row = db.prepare(
    "SELECT id, name FROM users WHERE id = ?",
  ).get(userId) as { id: string; name: string | null } | undefined;
  if (!row) return userId;
  const shortId = row.id.toUpperCase();
  return row.name ? `${shortId}(${row.name})` : shortId;
}

/** Get user short label by platform ID */
export function getUserShortLabelByPlatformId(
  db: Database.Database,
  platform: string,
  platformId: string,
): string {
  const row = db.prepare(
    "SELECT id, name FROM users WHERE platform = ? AND platform_id = ?",
  ).get(platform, platformId) as { id: string; name: string | null } | undefined;
  if (!row) return platformId;
  const shortId = row.id.toUpperCase();
  return row.name ? `${shortId}(${row.name})` : shortId;
}

/** Get chat short label, e.g. "C1(U1(Zen))" for p2p or "C2(GroupName)" for group */
export function getChatShortLabel(
  db: Database.Database,
  chatId: string,
): string {
  const row = db.prepare(
    "SELECT id, name, type, platform, user_id FROM chats WHERE id = ?",
  ).get(chatId) as { id: string; name: string | null; type: string | null; platform: string; user_id: string | null } | undefined;
  if (!row) return chatId;
  const shortId = row.id.toUpperCase();
  // p2p: show user label; group: show chat name
  if (row.type === "p2p" && row.user_id) {
    const userLabel = getUserShortLabelByPlatformId(db, row.platform, row.user_id);
    return `${shortId}(${userLabel})`;
  }
  return row.name ? `${shortId}(${row.name})` : shortId;
}

/** 确保会话存在，返回内部 ID。事务保护防止并发 ID 冲突 */
export function ensureChat(
  db: Database.Database,
  platform: string,
  platformId: string,
  type: "p2p" | "group",
  name?: string,
  userId?: string,
): string {
  const tx = db.transaction(
    (p: string, pid: string, t: string, n: string | null, uid: string | null): string => {
      const existing = db.prepare(
        "SELECT id, name FROM chats WHERE platform = ? AND platform_id = ?",
      ).get(p, pid) as { id: string; name: string | null } | undefined;

      if (existing) {
        // Update name if provided and currently null
        if (n && !existing.name) {
          db.prepare("UPDATE chats SET name = ? WHERE id = ?").run(n, existing.id);
        }
        // Update user_id for p2p chats if not yet set
        if (uid && t === "p2p") {
          db.prepare("UPDATE chats SET user_id = ? WHERE id = ? AND user_id IS NULL")
            .run(uid, existing.id);
        }
        return existing.id;
      }

      const max = db.prepare(
        "SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) as n FROM chats",
      ).get() as { n: number | null };
      const id = `c${(max.n ?? 0) + 1}`;

      db.prepare(
        "INSERT INTO chats (id, type, name, platform, platform_id, user_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, t, n, p, pid, uid);

      log.info("chat created", { id, type: t, platform: p, platformId: pid });
      return id;
    },
  );
  return tx(platform, platformId, type, name ?? null, userId ?? null) as string;
}

/** Update chat name */
export function updateChatName(
  db: Database.Database,
  chatId: string,
  name: string,
): void {
  db.prepare("UPDATE chats SET name = ? WHERE id = ?").run(name, chatId);
}

/** 存储消息，返回内部消息 ID。消息 + FTS 索引在同一个事务中 */
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
    platformTs?: string;
    platformRaw?: string;
  },
): number {
  const tx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO messages (chat_id, sender_id, session_key, role, content_text, content_type, reply_to, platform, platform_msg_id, platform_ts, platform_raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      msg.platformTs ?? null,
      msg.platformRaw ?? null,
    );

    const msgId = Number(result.lastInsertRowid);

    if (msg.contentText) {
      db.prepare(
        "INSERT INTO messages_fts (rowid, content_text) VALUES (?, ?)",
      ).run(msgId, msg.contentText);
    }

    return msgId;
  });

  return tx();
}

/** Get message content by platform message ID (for reply context) */
export function getMessageByPlatformId(
  db: Database.Database,
  platform: string,
  platformMsgId: string,
): { id: number; contentText: string | null; senderId: string } | undefined {
  return db.prepare(
    "SELECT id, content_text AS contentText, sender_id AS senderId FROM messages WHERE platform = ? AND platform_msg_id = ? LIMIT 1",
  ).get(platform, platformMsgId) as { id: number; contentText: string | null; senderId: string } | undefined;
}

/** Update content_text for an existing message (e.g., after fetching reply context from API) */
export function updateMessageContent(
  db: Database.Database,
  id: number,
  contentText: string,
): void {
  db.prepare("UPDATE messages SET content_text = ? WHERE id = ?").run(contentText, id);
}
