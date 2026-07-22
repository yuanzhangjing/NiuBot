import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import {
  initDatabase as openDatabase,
  getBotRuntimeState,
  setBotRuntimeState,
  clearBotRuntimeModels,
  getBotBackendModelState,
  setBotBackendModelState,
  loadPersistedBotRuntimeState,
  getRecentRuntimeEvents,
  markUnfinishedRuntimeRunsFailedByRestart,
  recordRuntimeEvent,
} from "./schema.js";

const tempDirs: string[] = [];
const openDatabases = new Set<Database.Database>();

function initDatabase(filePath: string): Database.Database {
  const db = openDatabase(filePath);
  openDatabases.add(db);
  return db;
}

afterEach(() => {
  for (const db of openDatabases) {
    if (db.open) db.close();
  }
  openDatabases.clear();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("bot runtime state", () => {
  test("persists backend and model for a bot", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const db = initDatabase(path.join(dir, "niubot.db"));

    setBotRuntimeState(db, "NiuBot", {
      backendType: "codex",
      model: "gpt-5.5",
    });

    expect(getBotRuntimeState(db, "NiuBot")).toEqual({
      backendType: "codex",
      model: "gpt-5.5",
    });
  });

  test("can clear runtime models without clearing backend", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const db = initDatabase(path.join(dir, "niubot.db"));

    setBotRuntimeState(db, "NiuBot", {
      backendType: "codex",
      model: "gpt-5.5",
    });
    clearBotRuntimeModels(db, "NiuBot");

    expect(getBotRuntimeState(db, "NiuBot")).toEqual({
      backendType: "codex",
      model: undefined,
    });
  });

  test("does not erase legacy lite model columns when updating the main model", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const db = initDatabase(path.join(dir, "niubot.db"));
    setBotRuntimeState(db, "NiuBot", { backendType: "codex", model: "old" });
    setBotBackendModelState(db, "NiuBot", "codex", { model: "old" });
    db.prepare("UPDATE bot_runtime_state SET lite_model = 'legacy-lite' WHERE bot_name = 'NiuBot'").run();
    db.prepare("UPDATE bot_backend_model_state SET lite_model = 'legacy-lite' WHERE bot_name = 'NiuBot' AND backend_type = 'codex'").run();

    setBotRuntimeState(db, "NiuBot", { backendType: "codex", model: "new" });
    setBotBackendModelState(db, "NiuBot", "codex", { model: "new" });

    expect((db.prepare("SELECT lite_model FROM bot_runtime_state WHERE bot_name = 'NiuBot'").get() as { lite_model: string }).lite_model).toBe("legacy-lite");
    expect((db.prepare("SELECT lite_model FROM bot_backend_model_state WHERE bot_name = 'NiuBot' AND backend_type = 'codex'").get() as { lite_model: string }).lite_model).toBe("legacy-lite");
  });

  test("persists model cache separately for each backend", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const db = initDatabase(path.join(dir, "niubot.db"));

    setBotBackendModelState(db, "NiuBot", "claude", {
      model: "claude-opus-4-6",
    });
    setBotBackendModelState(db, "NiuBot", "codex", {
      model: "gpt-5.5",
    });

    expect(getBotBackendModelState(db, "NiuBot", "claude")).toEqual({
      model: "claude-opus-4-6",
    });
    expect(getBotBackendModelState(db, "NiuBot", "codex")).toEqual({
      model: "gpt-5.5",
    });
  });

  test("loads current backend with its own persisted model cache", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "niubot.db");
    const db = initDatabase(dbPath);

    setBotRuntimeState(db, "NiuBot", {
      backendType: "codex",
      model: "legacy-model",
    });
    setBotBackendModelState(db, "NiuBot", "codex", {
      model: "gpt-5.5",
    });

    expect(loadPersistedBotRuntimeState(dbPath, "NiuBot")).toEqual({
      backendType: "codex",
      model: "gpt-5.5",
    });
  });
});

describe("runtime events schema", () => {
  test("creates runtime_events for a new database", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const db = initDatabase(path.join(dir, "niubot.db"));

    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_events'",
    ).get() as { name: string } | undefined;

    expect(row?.name).toBe("runtime_events");
  });

  test("migrates an old database to include runtime_events", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "niubot.db");
    const db = initDatabase(dbPath);
    db.prepare("DROP TABLE runtime_events").run();
    db.pragma("user_version = 14");
    db.close();

    const migrated = initDatabase(dbPath);
    const row = migrated.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_events'",
    ).get() as { name: string } | undefined;

    expect(row?.name).toBe("runtime_events");
  });

  test("queries recent events by chat and run", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const db = initDatabase(path.join(dir, "niubot.db"));

    recordRuntimeEvent(db, {
      botId: "NiuBot",
      chatId: "c1",
      runId: "run-1",
      messageIds: [1, 2],
      stage: "agent_running",
      event: "started",
    });
    recordRuntimeEvent(db, {
      botId: "NiuBot",
      chatId: "c1",
      runId: "run-1",
      messageIds: [1, 2],
      stage: "done",
      event: "done",
      elapsedMs: 42,
    });
    recordRuntimeEvent(db, {
      botId: "NiuBot",
      chatId: "c2",
      runId: "run-2",
      messageIds: [3],
      stage: "failed",
      event: "failed",
      error: "boom",
    });

    const byChat = getRecentRuntimeEvents(db, { chatId: "c1", limit: 10 });
    expect(byChat.map((event) => event.event)).toEqual(["done", "started"]);
    expect(byChat[0]).toMatchObject({
      botId: "NiuBot",
      chatId: "c1",
      runId: "run-1",
      messageIds: [1, 2],
      stage: "done",
      elapsedMs: 42,
    });

    const byRun = getRecentRuntimeEvents(db, { runId: "run-2", limit: 10 });
    expect(byRun).toHaveLength(1);
    expect(byRun[0]).toMatchObject({
      chatId: "c2",
      event: "failed",
      error: "boom",
    });
  });

  test("marks unfinished runtime runs failed by restart", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const db = initDatabase(path.join(dir, "niubot.db"));

    recordRuntimeEvent(db, {
      botId: "NiuBot",
      chatId: "c1",
      runId: "run-active",
      messageIds: [1],
      stage: "agent_running",
      event: "stage_changed",
    });
    recordRuntimeEvent(db, {
      botId: "NiuBot",
      chatId: "c1",
      runId: "run-done",
      messageIds: [2],
      stage: "done",
      event: "done",
    });

    const marked = markUnfinishedRuntimeRunsFailedByRestart(db, "NiuBot");

    expect(marked).toBe(1);
    const events = getRecentRuntimeEvents(db, { chatId: "c1", limit: 10 });
    expect(events[0]).toMatchObject({
      runId: "run-active",
      stage: "failed",
      event: "failed_by_restart",
      messageIds: [1],
    });
    expect(events.filter((event) => event.runId === "run-done").map((event) => event.event)).toEqual(["done"]);
  });
});

describe("cron timezone schema", () => {
  test("adds a timezone column to legacy cron jobs", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "niubot.db");
    const db = initDatabase(dbPath);
    db.pragma("user_version = 15");
    db.exec("ALTER TABLE cron_jobs DROP COLUMN timezone");
    db.close();

    const migrated = initDatabase(dbPath);
    const columns = migrated.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("timezone");
    expect(migrated.pragma("user_version", { simple: true })).toBe(15);
  });
});

describe("public upgrade rollback compatibility", () => {
  test.each([10, 11, 12, 13, 14, 15, 16])(
    "supports schema %i upgrade, exact-version rollback, and re-upgrade",
    (legacyVersion) => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
      tempDirs.push(dir);
      const dbPath = path.join(dir, "niubot.db");
      const fixture = initDatabase(dbPath);
      downgradeToPublicSchemaFixture(fixture, legacyVersion);
      fixture.prepare(`
        INSERT INTO cron_jobs (
          chat_id, creator_user_id, cron_expr, run_at, prompt,
          description, max_times, until_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("c1", "u1", "0 * * * *", null, "before-upgrade", "", null, null);
      fixture.pragma(`user_version = ${legacyVersion}`);
      fixture.close();

      const upgraded = initDatabase(dbPath);
      expect(upgraded.pragma("user_version", { simple: true })).toBe(legacyVersion);
      expect(upgraded.prepare(
        "SELECT version FROM niubot_component_schema_versions WHERE component = 'transport'",
      ).pluck().get()).toBe(2);
      expect((upgraded.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>)
        .some((column) => column.name === "timezone")).toBe(true);
      expect((upgraded.prepare("PRAGMA table_info(bot_runtime_state)").all() as Array<{ name: string }>)
        .map((column) => column.name)).toEqual(expect.arrayContaining(["model", "lite_model"]));
      upgraded.prepare(`
        INSERT INTO transport_inbox (
          bot_id, platform, platform_msg_id, payload_json, status
        ) VALUES ('NiuBot', 'feishu', 'compat-pending', '{}', 'pending')
      `).run();
      upgraded.close();

      // 模拟回滚到升级前的同一公开版本：旧代码看到原 user_version，
      // 忽略新增表和 nullable 列，并继续使用原有 SQL。
      const rolledBack = new Database(dbPath);
      expect(rolledBack.pragma("user_version", { simple: true })).toBe(legacyVersion);
      expect(() => rolledBack.prepare(`
        INSERT INTO cron_jobs (
          chat_id, creator_user_id, cron_expr, run_at, prompt,
          description, max_times, until_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("c1", "u1", "30 * * * *", null, "during-rollback", "", null, null)).not.toThrow();
      rolledBack.close();

      const reupgraded = initDatabase(dbPath);
      expect(reupgraded.pragma("user_version", { simple: true })).toBe(legacyVersion);
      expect(reupgraded.prepare(
        "SELECT prompt FROM cron_jobs ORDER BY id",
      ).pluck().all()).toEqual(["before-upgrade", "during-rollback"]);
      expect(reupgraded.prepare(
        "SELECT status FROM transport_inbox WHERE platform_msg_id = 'compat-pending'",
      ).pluck().get()).toBe("pending");
      expect(reupgraded.prepare(
        "SELECT version FROM niubot_component_schema_versions WHERE component = 'transport'",
      ).pluck().get()).toBe(2);
      reupgraded.close();
    },
    20_000,
  );

  test("resumes an interrupted additive migration without duplicate-column failure", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "niubot.db");
    const fixture = initDatabase(dbPath);
    downgradeToPublicSchemaFixture(fixture, 10);
    fixture.exec(`
      CREATE TABLE model_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        backend TEXT NOT NULL,
        model_name TEXT NOT NULL,
        last_used_at TEXT DEFAULT (datetime('now')),
        UNIQUE(backend, model_name)
      );
      ALTER TABLE bot_runtime_state ADD COLUMN model TEXT;
      PRAGMA user_version = 10;
    `);
    fixture.close();

    const resumed = initDatabase(dbPath);
    expect(resumed.pragma("user_version", { simple: true })).toBe(10);
    expect((resumed.prepare("PRAGMA table_info(bot_runtime_state)").all() as Array<{ name: string }>)
      .map((column) => column.name)).toEqual(expect.arrayContaining(["model", "lite_model"]));
    expect(resumed.prepare(
      "SELECT version FROM niubot_component_schema_versions WHERE component = 'transport'",
    ).pluck().get()).toBe(2);
  });
});

function downgradeToPublicSchemaFixture(db: Database.Database, version: number): void {
  db.exec(`
    DROP TABLE niubot_component_schema_versions;
    DROP TABLE transport_inbox;
    DROP TABLE transport_outbox;
  `);
  if (version < 16) db.exec("ALTER TABLE cron_jobs DROP COLUMN timezone");
  if (version < 15) db.exec("DROP TABLE runtime_events");
  if (version < 14) db.exec("DROP TABLE update_notifications");
  if (version < 13) db.exec("DROP TABLE bot_backend_model_state");
  if (version < 12) {
    db.exec("ALTER TABLE bot_runtime_state DROP COLUMN lite_model");
    db.exec("ALTER TABLE bot_runtime_state DROP COLUMN model");
  }
  if (version < 11) db.exec("DROP TABLE model_history");
}

describe("transport inbox claim schema", () => {
  test("migrates transport component version 1 rows without losing state", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "niubot.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE transport_inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        platform_msg_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'stopped', 'discarded', 'interrupted')),
        message_id INTEGER,
        run_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        received_at TEXT NOT NULL DEFAULT (datetime('now')),
        queued_at TEXT,
        processing_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(bot_id, platform, platform_msg_id)
      );
      CREATE INDEX idx_transport_inbox_recovery ON transport_inbox(bot_id, status, id);
      CREATE INDEX idx_transport_inbox_message ON transport_inbox(bot_id, message_id);
      CREATE INDEX idx_transport_inbox_run ON transport_inbox(bot_id, run_id);
      CREATE TABLE transport_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        bot_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        kind TEXT NOT NULL,
        chat_id TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        platform_msg_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        sending_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE niubot_component_schema_versions (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO niubot_component_schema_versions (component, version)
      VALUES ('transport', 1);
      INSERT INTO transport_inbox (
        bot_id, platform, platform_msg_id, payload_json, status, message_id, attempt_count
      ) VALUES ('NiuBot', 'feishu', 'msg-1', '{}', 'queued', 42, 1);
      PRAGMA user_version = 16;
    `);
    legacy.close();

    const migrated = initDatabase(dbPath);
    const row = migrated.prepare(`
      SELECT status, message_id, attempt_count, claim_token, claimed_at
      FROM transport_inbox WHERE platform_msg_id = 'msg-1'
    `).get() as Record<string, unknown>;

    expect(row).toMatchObject({
      status: "queued",
      message_id: 42,
      attempt_count: 1,
      claim_token: null,
      claimed_at: null,
    });
    expect(migrated.pragma("user_version", { simple: true })).toBe(16);
    expect(migrated.prepare(
      "SELECT version FROM niubot_component_schema_versions WHERE component = 'transport'",
    ).pluck().get()).toBe(2);
  });

  test("rejects incomplete transport tables instead of trusting inferred state", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "niubot.db");
    const database = initDatabase(dbPath);
    database.exec(`
      DELETE FROM niubot_component_schema_versions WHERE component = 'transport';
      DROP TABLE transport_outbox;
    `);
    database.close();

    expect(() => openDatabase(dbPath)).toThrow(/Transport schema is incomplete/);
  });

  test("rejects component metadata that disagrees with transport tables", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "niubot.db");
    const database = initDatabase(dbPath);
    database.prepare(
      "UPDATE niubot_component_schema_versions SET version = 1 WHERE component = 'transport'",
    ).run();
    database.close();

    expect(() => openDatabase(dbPath)).toThrow(/does not match its tables/);
  });

  test("rejects transport tables with incomplete claim columns", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "niubot.db");
    const database = initDatabase(dbPath);
    database.exec(`
      ALTER TABLE transport_inbox DROP COLUMN claimed_at;
      DELETE FROM niubot_component_schema_versions WHERE component = 'transport';
    `);
    database.close();

    expect(() => openDatabase(dbPath)).toThrow(/claim schema is incomplete/);
  });
});
