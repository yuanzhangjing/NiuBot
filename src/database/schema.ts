import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import type { AgentBackendType } from "../config.js";
import { normalizeBackend } from "../config.js";
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
  {
    version: 4,
    description: "Track sessions.backend_type so recover only resumes compatible agent sessions",
    up: (db) => {
      db.exec("ALTER TABLE sessions ADD COLUMN backend_type TEXT");
    },
  },
  {
    version: 5,
    description: "Persist current backend per bot for restart recovery",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS bot_runtime_state (
          bot_name      TEXT PRIMARY KEY,
          backend_type  TEXT NOT NULL,
          updated_at    TEXT DEFAULT (datetime('now'))
        )
      `);
    },
  },
  {
    version: 6,
    description: "Add state_summary to chats for rolling global summary",
    up: (db) => {
      db.exec("ALTER TABLE chats ADD COLUMN state_summary TEXT");
    },
  },
  {
    version: 7,
    description: "Add agent_seen to messages for foreign message injection",
    up: (db) => {
      db.exec("ALTER TABLE messages ADD COLUMN agent_seen INTEGER DEFAULT 0");
      // 历史消息全部标记为已见，只关心新消息
      db.exec("UPDATE messages SET agent_seen = 1");
    },
  },
  {
    version: 8,
    description: "Shorten session key to session id (last segment after _)",
    up: (db) => {
      // sessions.id: "s_1775738291552_5fb0090a" → "5fb0090a"
      db.exec(`
        UPDATE sessions
        SET id = SUBSTR(id, INSTR(SUBSTR(id, 3), '_') + 3)
        WHERE id LIKE 's_%_%'
      `);
      // messages.session_key: same transform
      db.exec(`
        UPDATE messages
        SET session_key = SUBSTR(session_key, INSTR(SUBSTR(session_key, 3), '_') + 3)
        WHERE session_key LIKE 's_%_%'
      `);
    },
  },
  {
    version: 9,
    description: "Add is_admin to users for persistent admin tracking",
    up: (db) => {
      db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0");
    },
  },
  {
    version: 10,
    description: "Change is_admin from INTEGER to TEXT (none/admin/owner)",
    up: (db) => {
      // Convert: 0 → 'none', 1 → 'admin' (will be upgraded to 'owner' by detectAdmins)
      db.exec("UPDATE users SET is_admin = CASE WHEN is_admin = 1 THEN 'admin' ELSE 'none' END");
    },
  },
  {
    version: 11,
    description: "Model history for /model command quick switching",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS model_history (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          backend      TEXT NOT NULL,
          model_name   TEXT NOT NULL,
          last_used_at TEXT DEFAULT (datetime('now')),
          UNIQUE(backend, model_name)
        );
      `);
    },
  },
  {
    version: 12,
    description: "Persist runtime model choices per bot",
    up: (db) => {
      db.exec("ALTER TABLE bot_runtime_state ADD COLUMN model TEXT");
      db.exec("ALTER TABLE bot_runtime_state ADD COLUMN lite_model TEXT");
    },
  },
  {
    version: 13,
    description: "Persist per-backend runtime model cache per bot",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS bot_backend_model_state (
          bot_name      TEXT NOT NULL,
          backend_type  TEXT NOT NULL,
          model         TEXT,
          lite_model    TEXT,
          updated_at    TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (bot_name, backend_type)
        )
      `);
      db.exec(`
        INSERT INTO bot_backend_model_state (bot_name, backend_type, model, lite_model, updated_at)
        SELECT bot_name, backend_type, model, lite_model, updated_at
        FROM bot_runtime_state
        WHERE backend_type IS NOT NULL
        ON CONFLICT(bot_name, backend_type) DO NOTHING
      `);
    },
  },
  {
    version: 14,
    description: "Track update notifications to avoid duplicate version alerts",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS update_notifications (
          bot_name    TEXT NOT NULL,
          version     TEXT NOT NULL,
          notified_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (bot_name, version)
        )
      `);
    },
  },
  {
    version: 15,
    description: "Track runtime events for run lifecycle diagnostics",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_events (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          bot_id           TEXT NOT NULL,
          chat_id          TEXT NOT NULL,
          run_id           TEXT NOT NULL,
          message_ids_json TEXT NOT NULL,
          stage            TEXT NOT NULL,
          event            TEXT NOT NULL,
          error            TEXT,
          elapsed_ms       INTEGER,
          created_at       TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_runtime_events_chat ON runtime_events(chat_id, id);
        CREATE INDEX IF NOT EXISTS idx_runtime_events_run ON runtime_events(run_id, id);
        CREATE INDEX IF NOT EXISTS idx_runtime_events_bot ON runtime_events(bot_id, id);
      `);
    },
  },
  {
    version: 16,
    description: "Bind cron schedules to an IANA timezone",
    up: (db) => {
      const columns = db.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "timezone")) {
        db.exec("ALTER TABLE cron_jobs ADD COLUMN timezone TEXT");
      }
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

export function getBotRuntimeBackend(db: Database.Database, botName: string): AgentBackendType | undefined {
  return getBotRuntimeState(db, botName)?.backendType;
}

export interface BotRuntimeState {
  backendType?: AgentBackendType;
  model?: string;
}

export interface BotBackendModelState {
  model?: string;
}

export type RuntimeEventName =
  | "started"
  | "stage_changed"
  | "timeout"
  | "failed"
  | "stopped"
  | "done"
  | "failed_by_restart";

export interface RuntimeEventInput {
  botId: string;
  chatId: string;
  runId: string;
  messageIds: number[];
  stage: string;
  event: RuntimeEventName;
  error?: string;
  elapsedMs?: number;
}

export interface RuntimeEventRow extends RuntimeEventInput {
  id: number;
  createdAt: string;
}

export interface RuntimeEventQuery {
  botId?: string;
  chatId?: string;
  runId?: string;
  limit?: number;
}

export function getBotRuntimeState(db: Database.Database, botName: string): BotRuntimeState | undefined {
  const row = db.prepare(
    "SELECT backend_type, model FROM bot_runtime_state WHERE bot_name = ?",
  ).get(botName) as { backend_type: string | null; model: string | null } | undefined;

  if (!row) return undefined;
  return {
    backendType: normalizeBackend(row.backend_type ?? undefined),
    model: row.model ?? undefined,
  };
}

export function setBotRuntimeState(
  db: Database.Database,
  botName: string,
  state: BotRuntimeState,
): void {
  const existing = getBotRuntimeState(db, botName);
  const next = {
    backendType: state.backendType ?? existing?.backendType,
    model: "model" in state ? state.model : existing?.model,
  };

  if (!next.backendType) {
    throw new Error("Cannot persist bot runtime state without backendType");
  }

  db.prepare(`
    INSERT INTO bot_runtime_state (bot_name, backend_type, model, lite_model, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(bot_name) DO UPDATE SET
      backend_type = excluded.backend_type,
      model = excluded.model,
      updated_at = excluded.updated_at
  `).run(botName, next.backendType, next.model ?? null, null);
}

export function setBotRuntimeBackend(
  db: Database.Database,
  botName: string,
  backendType: AgentBackendType,
): void {
  setBotRuntimeState(db, botName, { backendType });
}

export function getBotBackendModelState(
  db: Database.Database,
  botName: string,
  backendType: AgentBackendType,
): BotBackendModelState | undefined {
  const row = db.prepare(
    "SELECT model FROM bot_backend_model_state WHERE bot_name = ? AND backend_type = ?",
  ).get(botName, backendType) as { model: string | null } | undefined;

  if (!row) return undefined;
  return {
    model: row.model ?? undefined,
  };
}

export function setBotBackendModelState(
  db: Database.Database,
  botName: string,
  backendType: AgentBackendType,
  state: BotBackendModelState,
): void {
  const existing = getBotBackendModelState(db, botName, backendType);
  const next = {
    model: "model" in state ? state.model : existing?.model,
  };

  db.prepare(`
    INSERT INTO bot_backend_model_state (bot_name, backend_type, model, lite_model, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(bot_name, backend_type) DO UPDATE SET
      model = excluded.model,
      updated_at = excluded.updated_at
  `).run(botName, backendType, next.model ?? null, null);
}

export function clearBotRuntimeModels(db: Database.Database, botName: string): void {
  const existing = getBotRuntimeState(db, botName);
  if (!existing?.backendType) return;
  setBotRuntimeState(db, botName, {
    backendType: existing.backendType,
    model: undefined,
  });
  setBotBackendModelState(db, botName, existing.backendType, {
    model: undefined,
  });
}

export function loadPersistedBotBackend(dbPath: string, botName: string): AgentBackendType | undefined {
  if (!existsSync(dbPath)) return undefined;

  const db = initDatabase(dbPath);
  try {
    return getBotRuntimeBackend(db, botName);
  } finally {
    db.close();
  }
}

export function loadPersistedBotRuntimeState(dbPath: string, botName: string): BotRuntimeState | undefined {
  if (!existsSync(dbPath)) return undefined;

  const db = initDatabase(dbPath);
  try {
    const runtime = getBotRuntimeState(db, botName);
    if (!runtime?.backendType) return runtime;
    const backendModels = getBotBackendModelState(db, botName, runtime.backendType);
    if (!backendModels) return runtime;
    return {
      backendType: runtime.backendType,
      model: backendModels.model,
    };
  } finally {
    db.close();
  }
}

export function recordRuntimeEvent(db: Database.Database, input: RuntimeEventInput): number {
  const result = db.prepare(`
    INSERT INTO runtime_events (
      bot_id, chat_id, run_id, message_ids_json, stage, event, error, elapsed_ms
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.botId,
    input.chatId,
    input.runId,
    JSON.stringify(input.messageIds),
    input.stage,
    input.event,
    input.error ?? null,
    input.elapsedMs ?? null,
  );
  return Number(result.lastInsertRowid);
}

export function getRecentRuntimeEvents(db: Database.Database, query: RuntimeEventQuery = {}): RuntimeEventRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.botId) {
    where.push("bot_id = ?");
    params.push(query.botId);
  }
  if (query.chatId) {
    where.push("chat_id = ?");
    params.push(query.chatId);
  }
  if (query.runId) {
    where.push("run_id = ?");
    params.push(query.runId);
  }

  const limit = Math.max(1, Math.min(query.limit ?? 20, 100));
  const sql = `
    SELECT id, bot_id, chat_id, run_id, message_ids_json, stage, event, error, elapsed_ms, created_at
    FROM runtime_events
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY id DESC
    LIMIT ?
  `;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    bot_id: string;
    chat_id: string;
    run_id: string;
    message_ids_json: string;
    stage: string;
    event: RuntimeEventName;
    error: string | null;
    elapsed_ms: number | null;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    botId: row.bot_id,
    chatId: row.chat_id,
    runId: row.run_id,
    messageIds: parseMessageIds(row.message_ids_json),
    stage: row.stage,
    event: row.event,
    error: row.error ?? undefined,
    elapsedMs: row.elapsed_ms ?? undefined,
    createdAt: row.created_at,
  }));
}

export interface RestartFailedRunInfo {
  botId: string;
  chatId: string;
  runId: string;
  messageIds: number[];
  previousElapsedMs?: number;
}

export function markUnfinishedRuntimeRunsFailedByRestart(
  db: Database.Database,
  botId: string,
  onMarked?: (run: RestartFailedRunInfo) => void,
): number {
  const rows = db.prepare(`
    SELECT e.run_id, e.chat_id, e.message_ids_json, e.elapsed_ms
    FROM runtime_events e
    JOIN (
      SELECT run_id, MAX(id) AS max_id
      FROM runtime_events
      WHERE bot_id = ?
      GROUP BY run_id
    ) latest ON latest.max_id = e.id
    WHERE e.event NOT IN ('done', 'failed', 'stopped', 'failed_by_restart')
  `).all(botId) as Array<{
    run_id: string;
    chat_id: string;
    message_ids_json: string;
    elapsed_ms: number | null;
  }>;

  if (rows.length === 0) return 0;

  const insert = db.prepare(`
    INSERT INTO runtime_events (
      bot_id, chat_id, run_id, message_ids_json, stage, event, error, elapsed_ms
    )
    VALUES (?, ?, ?, ?, 'failed', 'failed_by_restart', ?, ?)
  `);
  const error = "Run did not reach a terminal state before restart";
  const markedRuns = rows.map((row) => ({
    botId,
    chatId: row.chat_id,
    runId: row.run_id,
    messageIds: parseMessageIds(row.message_ids_json),
    previousElapsedMs: row.elapsed_ms ?? undefined,
  }));
  const tx = db.transaction((items: typeof rows) => {
    for (const row of items) {
      insert.run(botId, row.chat_id, row.run_id, row.message_ids_json, error, row.elapsed_ms ?? null);
    }
  });
  tx(rows);
  if (onMarked) {
    for (const run of markedRuns) {
      try {
        onMarked(run);
      } catch {
        // Telemetry callbacks must not affect restart recovery bookkeeping.
      }
    }
  }
  return rows.length;
}

function getSchemaVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

function parseMessageIds(json: string): number[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is number => typeof id === "number");
  } catch {
    return [];
  }
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

/** Format short label from id + name: "U3(张三)" or "U3" */
export function formatShortLabel(id: string, name: string | null | undefined): string {
  const shortId = id.toUpperCase();
  return name ? `${shortId}(${name})` : shortId;
}

/**
 * 统一的 sender 显示名称入口，输出 "U2(Zen)" 格式（不带方括号）。
 * 所有 agent-facing 的消息格式化都应走这个函数，保证一致性。
 */
export function formatSenderLabel(senderId: string | null, senderName: string | null, role: string): string {
  if (senderId) return formatShortLabel(senderId, senderName);
  return role === "assistant" ? "bot" : "user";
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
  return formatShortLabel(row.id, row.name);
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
  return formatShortLabel(row.id, row.name);
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
    sessionId?: string;
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
      msg.sessionId ?? null,
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
): { id: number; contentText: string | null; contentType: string | null; senderId: string } | undefined {
  return db.prepare(
    "SELECT id, content_text AS contentText, content_type AS contentType, sender_id AS senderId FROM messages WHERE platform = ? AND platform_msg_id = ? LIMIT 1",
  ).get(platform, platformMsgId) as { id: number; contentText: string | null; contentType: string | null; senderId: string } | undefined;
}

/** Update content_text for an existing message (e.g., after fetching reply context from API) */
export function updateMessageContent(
  db: Database.Database,
  id: number,
  contentText: string,
): void {
  const tx = db.transaction(() => {
    const existing = db.prepare("SELECT content_text FROM messages WHERE id = ?").get(id) as
      | { content_text: string | null }
      | undefined;
    db.prepare("UPDATE messages SET content_text = ? WHERE id = ?").run(contentText, id);
    if (existing?.content_text) {
      db.prepare(
        "INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES('delete', ?, ?)",
      ).run(id, existing.content_text);
    }
    if (contentText) {
      db.prepare("INSERT INTO messages_fts (rowid, content_text) VALUES (?, ?)").run(id, contentText);
    }
  });
  tx();
}

/** Update platform_msg_id for an existing message (e.g., after bot sends and gets platform ID back) */
export function updateMessagePlatformId(
  db: Database.Database,
  id: number,
  platformMsgId: string,
): void {
  db.prepare("UPDATE messages SET platform_msg_id = ? WHERE id = ?").run(platformMsgId, id);
}

// ── Admin helpers ──────────────────────────────────────────────────

export type AdminRole = "none" | "admin" | "owner";

/** Set a user's admin role (persistent) */
export function setUserAdminRole(db: Database.Database, userId: string, role: AdminRole): void {
  db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(role, userId);
}

/** Get a user's admin role */
export function getUserAdminRole(db: Database.Database, userId: string): AdminRole {
  const row = db.prepare("SELECT is_admin FROM users WHERE id = ?").get(userId) as { is_admin: string } | undefined;
  const val = row?.is_admin;
  if (val === "owner" || val === "admin") return val;
  return "none";
}

/** Get all admin/owner user IDs from DB */
export function getAdminUserIds(db: Database.Database): Array<{ id: string; role: AdminRole }> {
  const rows = db.prepare("SELECT id, is_admin FROM users WHERE is_admin IN ('admin', 'owner')").all() as { id: string; is_admin: string }[];
  return rows.map((r) => ({ id: r.id, role: r.is_admin as AdminRole }));
}

export function hasUpdateNotification(db: Database.Database, botName: string, version: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM update_notifications WHERE bot_name = ? AND version = ?",
  ).get(botName, version);
  return !!row;
}

export function recordUpdateNotification(db: Database.Database, botName: string, version: string): void {
  db.prepare(
    `INSERT INTO update_notifications (bot_name, version, notified_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(bot_name, version) DO UPDATE SET notified_at = excluded.notified_at`,
  ).run(botName, version);
}
