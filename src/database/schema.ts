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
      const columns = new Set(
        (db.prepare("PRAGMA table_info(bot_runtime_state)").all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.has("model")) {
        db.exec("ALTER TABLE bot_runtime_state ADD COLUMN model TEXT");
      }
      if (!columns.has("lite_model")) {
        db.exec("ALTER TABLE bot_runtime_state ADD COLUMN lite_model TEXT");
      }
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
  {
    version: 17,
    description: "Add internal worker works, jobs, events and agent continuations",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS worker_works (
          id                  TEXT PRIMARY KEY,
          bot_id              TEXT NOT NULL,
          owner_user_id       TEXT NOT NULL,
          source_chat_id      TEXT NOT NULL,
          visibility          TEXT NOT NULL DEFAULT 'private'
                              CHECK(visibility IN ('private', 'public')),
          request             TEXT NOT NULL,
          status              TEXT NOT NULL DEFAULT 'active'
                              CHECK(status IN ('active', 'completing', 'completed', 'failing', 'failed', 'cancelling', 'cancelled')),
          job_ids_json        TEXT NOT NULL DEFAULT '[]',
          final_conclusion    TEXT,
          interrupted_count   INTEGER NOT NULL DEFAULT 0,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          created_at          TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
          version             INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_worker_works_bot ON worker_works(bot_id, created_at);

        CREATE TABLE IF NOT EXISTS worker_jobs (
          id                    TEXT PRIMARY KEY,
          work_id               TEXT NOT NULL REFERENCES worker_works(id),
          worker_profile_id     TEXT NOT NULL,
          profile_snapshot_json TEXT,
          prompt                TEXT NOT NULL,
          workdir               TEXT NOT NULL,
          backend_session_id    TEXT,
          status                TEXT NOT NULL DEFAULT 'queued'
                                CHECK(status IN ('queued', 'running', 'completed', 'failed', 'interrupted', 'cancelling', 'cancelled')),
          response_text         TEXT,
          exit_code             INTEGER,
          error                 TEXT,
          changed_files_json    TEXT NOT NULL DEFAULT '[]',
          artifacts_json        TEXT NOT NULL DEFAULT '[]',
          started_at            TEXT,
          ended_at              TEXT,
          claim_token           TEXT,
          claimed_at            TEXT,
          workspace_policy      TEXT NOT NULL DEFAULT 'read_only'
                                CHECK(workspace_policy IN ('read_only', 'scratch', 'git_worktree')),
          depends_on_json       TEXT NOT NULL DEFAULT '[]',
          created_at            TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
          version               INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_worker_jobs_work ON worker_jobs(work_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_worker_jobs_status ON worker_jobs(status);

        CREATE TABLE IF NOT EXISTS worker_idempotency_keys (
          idempotency_key  TEXT PRIMARY KEY,
          job_id           TEXT NOT NULL,
          created_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS worker_resource_leases (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          bot_id       TEXT NOT NULL,
          resource_key TEXT NOT NULL UNIQUE,
          job_id       TEXT NOT NULL,
          token        TEXT NOT NULL,
          expires_at   TEXT,
          created_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_worker_leases_job ON worker_resource_leases(job_id);

        CREATE TABLE IF NOT EXISTS team_settings (
          bot_id                TEXT PRIMARY KEY,
          enabled               INTEGER NOT NULL DEFAULT 0,
          active_config_version TEXT,
          updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS team_config_versions (
          version       TEXT PRIMARY KEY,
          bot_id        TEXT NOT NULL,
          config_yaml   TEXT NOT NULL,
          config_hash   TEXT NOT NULL,
          applied_by    TEXT,
          applied_at    TEXT NOT NULL DEFAULT (datetime('now')),
          rollback_of   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_team_config_bot ON team_config_versions(bot_id, applied_at);

        CREATE TABLE IF NOT EXISTS team_config_drafts (
          id           TEXT PRIMARY KEY,
          bot_id       TEXT NOT NULL,
          config_yaml  TEXT NOT NULL,
          status       TEXT NOT NULL DEFAULT 'pending'
                       CHECK(status IN ('pending', 'applied', 'superseded', 'rejected')),
          base_version TEXT,
          created_by   TEXT,
          created_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS worker_events (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          bot_id      TEXT NOT NULL,
          work_id     TEXT NOT NULL,
          job_id      TEXT,
          event       TEXT NOT NULL,
          detail      TEXT,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_worker_events_work ON worker_events(work_id, id);

        CREATE TABLE IF NOT EXISTS agent_continuations (
          id            TEXT PRIMARY KEY,
          bot_id        TEXT NOT NULL,
          chat_id       TEXT NOT NULL,
          dedupe_key    TEXT NOT NULL UNIQUE,
          kind          TEXT NOT NULL DEFAULT 'job_terminal'
                        CHECK(kind IN ('job_terminal')),
          work_id       TEXT NOT NULL,
          job_ids_json  TEXT NOT NULL DEFAULT '[]',
          status        TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending', 'claimed', 'completed', 'failed')),
          agent_turn_id TEXT,
          claim_token   TEXT,
          claimed_at    TEXT,
          completed_at  TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_agent_continuations_chat ON agent_continuations(chat_id, status);
      `);
    },
  },
  {
    version: 18,
    description: "Add attempt_count to agent_continuations (loop protection)",
    up: (db) => {
      const columns = db.prepare("PRAGMA table_info(agent_continuations)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "attempt_count")) {
        db.exec("ALTER TABLE agent_continuations ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0");
      }
    },
  },
  {
    version: 19,
    description: "Track trigger user message on worker works and continuations (reply association)",
    up: (db) => {
      const workColumns = db.prepare("PRAGMA table_info(worker_works)").all() as Array<{ name: string }>;
      if (!workColumns.some((column) => column.name === "trigger_msg_platform_id")) {
        db.exec("ALTER TABLE worker_works ADD COLUMN trigger_msg_platform_id TEXT");
      }
      const continuationColumns = db.prepare("PRAGMA table_info(agent_continuations)").all() as Array<{ name: string }>;
      if (!continuationColumns.some((column) => column.name === "trigger_msg_platform_id")) {
        db.exec("ALTER TABLE agent_continuations ADD COLUMN trigger_msg_platform_id TEXT");
      }
      // 回填既有数据：Work 取本 chat 最近一条真实用户消息（与 CLI 捕获同一启发式）；
      // Continuation 从所属 Work 拷贝。避免升级后旧 Work/Continuation 验收时链路断裂落兜底。
      // messages 表可能不存在（精简/测试库），需先确认再回填。
      const hasMessages = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
        .get();
      if (hasMessages) {
        db.exec(`
          UPDATE worker_works
          SET trigger_msg_platform_id = (
            SELECT platform_msg_id FROM messages
            WHERE chat_id = worker_works.source_chat_id AND role = 'user'
              AND platform_msg_id IS NOT NULL AND platform_msg_id != ''
            ORDER BY id DESC LIMIT 1
          )
          WHERE trigger_msg_platform_id IS NULL;
          UPDATE agent_continuations
          SET trigger_msg_platform_id = (
            SELECT trigger_msg_platform_id FROM worker_works WHERE id = agent_continuations.work_id
          )
          WHERE trigger_msg_platform_id IS NULL;
          CREATE INDEX IF NOT EXISTS idx_messages_chat_role_id ON messages(chat_id, role, id);
        `);
      }
    },
  },
  {
    version: 20,
    description: "Expose Worker backend transcript references for live session inspection",
    up: (db) => {
      const columns = db.prepare("PRAGMA table_info(worker_jobs)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "backend_type")) {
        db.exec("ALTER TABLE worker_jobs ADD COLUMN backend_type TEXT");
      }
      if (!columns.some((column) => column.name === "transcript_sources_json")) {
        db.exec("ALTER TABLE worker_jobs ADD COLUMN transcript_sources_json TEXT NOT NULL DEFAULT '[]'");
      }
    },
  },
  {
    version: 21,
    description: "Add session-scoped Loop jobs",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS loop_jobs (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id              TEXT NOT NULL,
          creator_user_id      TEXT NOT NULL,
          session_id           TEXT NOT NULL,
          interval_seconds     INTEGER NOT NULL CHECK(interval_seconds >= 60),
          prompt               TEXT NOT NULL,
          max_times            INTEGER CHECK(max_times IS NULL OR max_times > 0),
          until_time           TEXT NOT NULL,
          run_count            INTEGER NOT NULL DEFAULT 0,
          status               TEXT NOT NULL DEFAULT 'active'
                               CHECK(status IN ('active', 'queued', 'running', 'paused', 'completed', 'cancelled')),
          next_run_at          TEXT NOT NULL,
          last_run_at          TEXT,
          run_started_at       TEXT,
          last_error           TEXT,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          created_at           TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_loop_jobs_due ON loop_jobs(status, next_run_at);
        CREATE INDEX IF NOT EXISTS idx_loop_jobs_chat ON loop_jobs(chat_id, status, id);
      `);
      const columns = db.prepare("PRAGMA table_info(loop_jobs)").all() as Array<{ name: string; dflt_value: string | null }>;
      const sessionColumn = columns.find((column) => column.name === "session_id");
      if (sessionColumn && sessionColumn.dflt_value !== "''") {
        db.exec("CREATE INDEX IF NOT EXISTS idx_loop_jobs_session ON loop_jobs(session_id, status)");
      }
    },
  },
  {
    version: 22,
    description: "Bind Loop jobs to chats instead of individual sessions",
    up: (db) => {
      const columns = db.prepare("PRAGMA table_info(loop_jobs)").all() as Array<{ name: string; dflt_value: string | null }>;
      const sessionColumn = columns.find((column) => column.name === "session_id");
      if (!sessionColumn) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_loop_jobs_due ON loop_jobs(status, next_run_at);
          CREATE INDEX IF NOT EXISTS idx_loop_jobs_chat ON loop_jobs(chat_id, status, id);
        `);
        return;
      }
      if (sessionColumn.dflt_value === "''") {
        const indexes = new Set((db.prepare(`
          SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'loop_jobs'
        `).all() as Array<{ name: string }>).map((row) => row.name));
        const statements: string[] = [];
        if (indexes.has("idx_loop_jobs_session")) statements.push("DROP INDEX idx_loop_jobs_session");
        if (!indexes.has("idx_loop_jobs_due")) statements.push("CREATE INDEX idx_loop_jobs_due ON loop_jobs(status, next_run_at)");
        if (!indexes.has("idx_loop_jobs_chat")) statements.push("CREATE INDEX idx_loop_jobs_chat ON loop_jobs(chat_id, status, id)");
        if (statements.length > 0) db.exec(statements.join(";\n"));
        return;
      }
      db.exec(`
        DROP INDEX IF EXISTS idx_loop_jobs_due;
        DROP INDEX IF EXISTS idx_loop_jobs_chat;
        DROP INDEX IF EXISTS idx_loop_jobs_session;
        ALTER TABLE loop_jobs RENAME TO loop_jobs_session_scoped;

        CREATE TABLE loop_jobs (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id              TEXT NOT NULL,
          creator_user_id      TEXT NOT NULL,
          session_id           TEXT NOT NULL DEFAULT '',
          interval_seconds     INTEGER NOT NULL CHECK(interval_seconds >= 60),
          prompt               TEXT NOT NULL,
          max_times            INTEGER CHECK(max_times IS NULL OR max_times > 0),
          until_time           TEXT NOT NULL,
          run_count            INTEGER NOT NULL DEFAULT 0,
          status               TEXT NOT NULL DEFAULT 'active'
                               CHECK(status IN ('active', 'queued', 'running', 'paused', 'completed', 'cancelled')),
          next_run_at          TEXT NOT NULL,
          last_run_at          TEXT,
          run_started_at       TEXT,
          last_error           TEXT,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          created_at           TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO loop_jobs (
          id, chat_id, creator_user_id, session_id, interval_seconds, prompt, max_times,
          until_time, run_count, status, next_run_at, last_run_at,
          run_started_at, last_error, consecutive_failures, created_at, updated_at
        )
        SELECT
          id, chat_id, creator_user_id, session_id, interval_seconds, prompt, max_times,
          until_time, run_count, status, next_run_at, last_run_at,
          run_started_at, last_error, consecutive_failures, created_at, updated_at
        FROM loop_jobs_session_scoped;

        DROP TABLE loop_jobs_session_scoped;
        CREATE INDEX idx_loop_jobs_due ON loop_jobs(status, next_run_at);
        CREATE INDEX idx_loop_jobs_chat ON loop_jobs(chat_id, status, id);
      `);
    },
  },
  {
    version: 23,
    description: "Track Cron claims and consecutive failures",
    up: (db) => {
      const table = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cron_jobs'",
      ).get();
      if (!table) return;
      const columns = new Set(
        (db.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.has("claimed_at")) {
        db.exec("ALTER TABLE cron_jobs ADD COLUMN claimed_at TEXT");
      }
      if (!columns.has("last_error")) {
        db.exec("ALTER TABLE cron_jobs ADD COLUMN last_error TEXT");
      }
      if (!columns.has("consecutive_failures")) {
        db.exec("ALTER TABLE cron_jobs ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0");
      }
    },
  },
  {
    version: 24,
    description: "Fence Cron execution claims with unique tokens",
    up: (db) => {
      const tableExists = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cron_jobs'",
      ).get();
      if (!tableExists) return;
      const columns = new Set(
        (db.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.has("claim_token")) {
        db.exec("ALTER TABLE cron_jobs ADD COLUMN claim_token TEXT");
      }
    },
  },
  {
    version: 25,
    description: "Allow calendar expressions (cron) in Loop jobs with timezone",
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(loop_jobs)").all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!columns.has("cron_expr")) db.exec("ALTER TABLE loop_jobs ADD COLUMN cron_expr TEXT");
      if (!columns.has("timezone")) db.exec("ALTER TABLE loop_jobs ADD COLUMN timezone TEXT");
      if (!columns.has("description")) db.exec("ALTER TABLE loop_jobs ADD COLUMN description TEXT");
    },
  },
];

const transportMigrations: Migration[] = [
  {
    version: 1,
    description: "Add persistent transport inbox and outbox",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS transport_inbox (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          bot_id            TEXT NOT NULL,
          platform          TEXT NOT NULL,
          platform_msg_id   TEXT NOT NULL,
          payload_json      TEXT NOT NULL,
          status            TEXT NOT NULL DEFAULT 'pending'
                            CHECK(status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'stopped', 'discarded', 'interrupted')),
          message_id        INTEGER,
          run_id            TEXT,
          attempt_count     INTEGER NOT NULL DEFAULT 0,
          error             TEXT,
          received_at       TEXT NOT NULL DEFAULT (datetime('now')),
          queued_at         TEXT,
          processing_at     TEXT,
          completed_at      TEXT,
          updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(bot_id, platform, platform_msg_id)
        );

        CREATE INDEX IF NOT EXISTS idx_transport_inbox_recovery
          ON transport_inbox(bot_id, status, id);
        CREATE INDEX IF NOT EXISTS idx_transport_inbox_message
          ON transport_inbox(bot_id, message_id);
        CREATE INDEX IF NOT EXISTS idx_transport_inbox_run
          ON transport_inbox(bot_id, run_id);

        CREATE TABLE IF NOT EXISTS transport_outbox (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id        TEXT NOT NULL UNIQUE,
          bot_id            TEXT NOT NULL,
          platform          TEXT NOT NULL,
          kind              TEXT NOT NULL,
          chat_id           TEXT,
          payload_json      TEXT NOT NULL,
          status            TEXT NOT NULL DEFAULT 'pending'
                            CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
          attempt_count     INTEGER NOT NULL DEFAULT 0,
          platform_msg_id   TEXT,
          error             TEXT,
          created_at        TEXT NOT NULL DEFAULT (datetime('now')),
          sending_at        TEXT,
          completed_at      TEXT,
          updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_transport_outbox_recovery
          ON transport_outbox(bot_id, status, id);
        CREATE INDEX IF NOT EXISTS idx_transport_outbox_chat
          ON transport_outbox(bot_id, chat_id, id);
      `);
    },
  },
  {
    version: 2,
    description: "Add atomic claim state to persistent transport inbox",
    up: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_transport_inbox_recovery;
        DROP INDEX IF EXISTS idx_transport_inbox_message;
        DROP INDEX IF EXISTS idx_transport_inbox_run;

        ALTER TABLE transport_inbox RENAME TO transport_inbox_v1;

        CREATE TABLE transport_inbox (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          bot_id            TEXT NOT NULL,
          platform          TEXT NOT NULL,
          platform_msg_id   TEXT NOT NULL,
          payload_json      TEXT NOT NULL,
          status            TEXT NOT NULL DEFAULT 'pending'
                            CHECK(status IN ('pending', 'dispatching', 'queued', 'processing', 'completed', 'failed', 'stopped', 'discarded', 'interrupted')),
          message_id        INTEGER,
          run_id            TEXT,
          claim_token       TEXT,
          attempt_count     INTEGER NOT NULL DEFAULT 0,
          error             TEXT,
          received_at       TEXT NOT NULL DEFAULT (datetime('now')),
          claimed_at        TEXT,
          queued_at         TEXT,
          processing_at     TEXT,
          completed_at      TEXT,
          updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(bot_id, platform, platform_msg_id)
        );

        INSERT INTO transport_inbox (
          id, bot_id, platform, platform_msg_id, payload_json, status,
          message_id, run_id, attempt_count, error, received_at,
          queued_at, processing_at, completed_at, updated_at
        )
        SELECT
          id, bot_id, platform, platform_msg_id, payload_json, status,
          message_id, run_id, attempt_count, error, received_at,
          queued_at, processing_at, completed_at, updated_at
        FROM transport_inbox_v1;

        DROP TABLE transport_inbox_v1;

        CREATE INDEX idx_transport_inbox_recovery
          ON transport_inbox(bot_id, status, id);
        CREATE INDEX idx_transport_inbox_message
          ON transport_inbox(bot_id, message_id);
        CREATE INDEX idx_transport_inbox_run
          ON transport_inbox(bot_id, run_id);
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = migrations[migrations.length - 1]!.version;
// Loop v22 保留了旧 session_id 列作为回滚兼容占位，当前运行时不再读取或写入它。
// 因此这些版本升级后仍可由原版本打开；新建 Loop 在旧代码中不会继续执行。
export const ROLLBACK_COMPATIBLE_SCHEMA_VERSIONS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25] as const;
export const LATEST_TRANSPORT_SCHEMA_VERSION = transportMigrations[transportMigrations.length - 1]!.version;
const CORE_SCHEMA_COMPONENT = "core";

// ── Database initialization ─────────────────────────────────────────

export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  try {
    // busy_timeout 必须先于可能争写锁的 WAL 切换和迁移。多个 CLI/Engine
    // 同时打开同一数据库时，应等待当前初始化完成，而不是立即报锁冲突。
    db.pragma("busy_timeout = 5000");
    const journalMode = db.pragma("journal_mode", { simple: true }) as string;
    if (journalMode.toLowerCase() !== "wal") db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    runMigrations(db);
    runTransportMigrations(db);
    reconcileRollbackCompatibleData(db);

    log.info("database initialized", {
      path: dbPath,
      schemaVersion: getSchemaVersion(db),
      coreMigrationVersion: getComponentSchemaVersion(db, CORE_SCHEMA_COMPONENT),
      transportSchemaVersion: getComponentSchemaVersion(db, "transport"),
    });
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
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

function ensureComponentSchemaTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS niubot_component_schema_versions (
      component  TEXT PRIMARY KEY,
      version    INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function getComponentSchemaVersion(db: Database.Database, component: string): number {
  const row = db.prepare(
    "SELECT version FROM niubot_component_schema_versions WHERE component = ?",
  ).get(component) as { version: number } | undefined;
  return row?.version ?? 0;
}

function setComponentSchemaVersion(db: Database.Database, component: string, version: number): void {
  db.prepare(`
    INSERT INTO niubot_component_schema_versions (component, version, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(component) DO UPDATE SET
      version = excluded.version,
      updated_at = excluded.updated_at
  `).run(component, version);
}

function detectTransportSchemaVersion(db: Database.Database): number {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('transport_inbox', 'transport_outbox')
  `).pluck().all() as string[];
  if (tables.length === 0) return 0;
  if (tables.length !== 2) {
    throw new Error("Transport schema is incomplete; manual recovery is required.");
  }
  const inboxColumns = tableColumns(db, "transport_inbox");
  const outboxColumns = tableColumns(db, "transport_outbox");
  assertRequiredColumns("transport_inbox", inboxColumns, [
    "id", "bot_id", "platform", "platform_msg_id", "payload_json", "status",
    "message_id", "run_id", "attempt_count", "error", "received_at", "queued_at",
    "processing_at", "completed_at", "updated_at",
  ]);
  assertRequiredColumns("transport_outbox", outboxColumns, [
    "id", "request_id", "bot_id", "platform", "kind", "chat_id", "payload_json",
    "status", "attempt_count", "platform_msg_id", "error", "created_at", "sending_at",
    "completed_at", "updated_at",
  ]);
  const hasClaimToken = inboxColumns.has("claim_token");
  const hasClaimedAt = inboxColumns.has("claimed_at");
  if (hasClaimToken !== hasClaimedAt) {
    throw new Error("Transport inbox claim schema is incomplete; manual recovery is required.");
  }
  return hasClaimToken ? 2 : 1;
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(columns.map((column) => column.name));
}

function assertRequiredColumns(table: string, columns: Set<string>, required: string[]): void {
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(
      `Transport schema table ${table} is missing columns: ${missing.join(", ")}; ` +
      "manual recovery is required.",
    );
  }
}

function runMigrations(db: Database.Database): void {
  ensureComponentSchemaTable(db);
  const observedVersion = getSchemaVersion(db);
  const observedCoreVersion = getComponentSchemaVersion(db, CORE_SCHEMA_COMPONENT);
  if (observedVersion > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version (${observedVersion}) is newer than code (${LATEST_SCHEMA_VERSION}). ` +
      "Please upgrade NiuBot to a version that supports this database.",
    );
  }
  // core 水位不是兼容性门槛。未来版本若仍保持旧 user_version，表示其迁移声明可回滚；
  // 当前代码必须像旧程序一样忽略更高的辅助水位。非兼容迁移必须提高 user_version，
  // 并由上面的检查拒绝打开。
  // 常规 CLI 打开已升级数据库时保持纯读，不获取 BEGIN IMMEDIATE 写锁。
  // 首次升级或旧版本回滚后的数据库仍进入事务，并在锁内重新读取水位。
  if (observedVersion > 0 && observedCoreVersion >= LATEST_SCHEMA_VERSION) return;

  const applied = db.transaction(() => {
    ensureComponentSchemaTable(db);
    let currentVersion = getSchemaVersion(db);

    // 已有 DB 但从未设过版本号（user_version 默认 0）
    if (currentVersion === 0) {
      const hasTable = db.prepare(
        "SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='users'",
      ).get() as { n: number };

      if (hasTable.n > 0) {
        currentVersion = 1;
        setSchemaVersion(db, 1);
        log.info("existing database detected, set schema version to 1");
      }
    }

    // user_version 高于代码代表存在非兼容结构，仍按原规则拒绝。
    if (currentVersion > LATEST_SCHEMA_VERSION) {
      throw new Error(
        `Database schema version (${currentVersion}) is newer than code (${LATEST_SCHEMA_VERSION}). ` +
        "Please upgrade NiuBot to a version that supports this database.",
      );
    }

    // core 组件水位只记录本代码实际执行过的兼容迁移。旧程序忽略此表，
    // user_version 继续保留旧值，因此更新失败后仍能回滚程序。
    const trackedVersion = getComponentSchemaVersion(db, CORE_SCHEMA_COMPONENT);
    const effectiveVersion = Math.max(currentVersion, Math.min(trackedVersion, LATEST_SCHEMA_VERSION));
    const preserveLegacyVersion = ROLLBACK_COMPATIBLE_SCHEMA_VERSIONS.includes(
      currentVersion as (typeof ROLLBACK_COMPATIBLE_SCHEMA_VERSIONS)[number],
    );
    const rollbackCompatibleCeiling = ROLLBACK_COMPATIBLE_SCHEMA_VERSIONS.at(-1)!;
    const completed: Array<{ version: number; description: string; rollbackCompatible: boolean }> = [];

    for (const migration of migrations.filter((item) => item.version > effectiveVersion)) {
      migration.up(db);
      const rollbackCompatible = preserveLegacyVersion && migration.version <= rollbackCompatibleCeiling;
      if (!rollbackCompatible) setSchemaVersion(db, migration.version);
      setComponentSchemaVersion(db, CORE_SCHEMA_COMPONENT, migration.version);
      completed.push({ version: migration.version, description: migration.description, rollbackCompatible });
    }
    return completed;
  }).immediate();

  for (const migration of applied) {
    log.info("migration completed", {
      version: migration.version,
      description: migration.description,
      schemaVersion: getSchemaVersion(db),
      rollbackCompatible: migration.rollbackCompatible,
    });
  }
}

/**
 * 兼容版本回滚期间可能产生需要新版本补齐的数据。结构迁移只执行一次，
 * 但数据修复必须按缺口重入；没有候选行时保持只读，避免普通 CLI 争写锁。
 */
function reconcileRollbackCompatibleData(db: Database.Database): void {
  const availableTables = new Set((db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('messages', 'worker_works', 'agent_continuations')
  `).pluck().all()) as string[]);
  if (!["messages", "worker_works", "agent_continuations"].every((table) => availableTables.has(table))) {
    return;
  }
  const workNeedsBackfill = db.prepare(`
    SELECT 1 FROM worker_works w
    WHERE w.trigger_msg_platform_id IS NULL
      AND EXISTS (
        SELECT 1 FROM messages m
        WHERE m.chat_id = w.source_chat_id AND m.role = 'user'
          AND m.platform_msg_id IS NOT NULL AND m.platform_msg_id != ''
      )
    LIMIT 1
  `).get();
  const continuationNeedsBackfill = db.prepare(`
    SELECT 1 FROM agent_continuations c
    JOIN worker_works w ON w.id = c.work_id
    WHERE c.trigger_msg_platform_id IS NULL AND w.trigger_msg_platform_id IS NOT NULL
    LIMIT 1
  `).get();
  if (!workNeedsBackfill && !continuationNeedsBackfill) return;

  db.transaction(() => {
    db.exec(`
      UPDATE worker_works
      SET trigger_msg_platform_id = (
        SELECT platform_msg_id FROM messages
        WHERE chat_id = worker_works.source_chat_id AND role = 'user'
          AND platform_msg_id IS NOT NULL AND platform_msg_id != ''
        ORDER BY id DESC LIMIT 1
      )
      WHERE trigger_msg_platform_id IS NULL
        AND EXISTS (
          SELECT 1 FROM messages
          WHERE chat_id = worker_works.source_chat_id AND role = 'user'
            AND platform_msg_id IS NOT NULL AND platform_msg_id != ''
        );
      UPDATE agent_continuations
      SET trigger_msg_platform_id = (
        SELECT trigger_msg_platform_id FROM worker_works WHERE id = agent_continuations.work_id
      )
      WHERE trigger_msg_platform_id IS NULL
        AND EXISTS (
          SELECT 1 FROM worker_works
          WHERE id = agent_continuations.work_id AND trigger_msg_platform_id IS NOT NULL
        );
    `);
  }).immediate();
}

function runTransportMigrations(db: Database.Database): void {
  ensureComponentSchemaTable(db);
  let currentVersion = getComponentSchemaVersion(db, "transport");
  const detected = detectTransportSchemaVersion(db);
  if (currentVersion === 0) {
    if (detected > 0) {
      setComponentSchemaVersion(db, "transport", detected);
      currentVersion = detected;
    }
  } else if (detected !== currentVersion) {
    throw new Error(
      `Transport schema metadata (${currentVersion}) does not match its tables (${detected}); ` +
      "manual recovery is required.",
    );
  }

  if (currentVersion > LATEST_TRANSPORT_SCHEMA_VERSION) {
    throw new Error(
      `Transport schema version (${currentVersion}) is newer than code (${LATEST_TRANSPORT_SCHEMA_VERSION}). ` +
      "Please upgrade NiuBot to a version that supports this transport schema.",
    );
  }

  for (const migration of transportMigrations.filter((item) => item.version > currentVersion)) {
    log.info("running transport migration", {
      version: migration.version,
      description: migration.description,
    });
    db.transaction(() => {
      migration.up(db);
      setComponentSchemaVersion(db, "transport", migration.version);
    })();
    log.info("transport migration completed", { version: migration.version });
  }

  const finalVersion = detectTransportSchemaVersion(db);
  if (finalVersion !== LATEST_TRANSPORT_SCHEMA_VERSION) {
    throw new Error(
      `Transport schema migration finished at ${finalVersion}, expected ${LATEST_TRANSPORT_SCHEMA_VERSION}.`,
    );
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
