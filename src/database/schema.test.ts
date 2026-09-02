import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  ensureUser,
  ensureChat,
  storeMessage,
  getMessageByPlatformId,
  getChatMetadata,
  updateChatMetadata,
  updateMessagePlatformId,
  setUserIsBot,
  getUserIsBot,
  getUserIdentityByPlatformId,
  listChatBots,
  reconcileBotIdentity,
  getBotRuntimeState,
  setBotRuntimeState,
  clearBotRuntimeModels,
  getBotBackendModelState,
  setBotBackendModelState,
  getScopeRuntimeConfig,
  setScopeRuntimeConfig,
  ensureScopeRuntimeConfig,
  deleteScopeRuntimeConfig,
  findP2pChatIdForUser,
  loadPersistedBotRuntimeState,
  getRecentRuntimeEvents,
  markUnfinishedRuntimeRunsFailedByRestart,
  recordRuntimeEvent,
  claimDailyBotPermissionWarning,
  LATEST_SCHEMA_VERSION,
} from "./schema.js";
import { closeTestDatabases, openRawTestDatabase, openTestDatabase } from "../../test-utils/database.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeTestDatabases();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Bot permission warning schema", () => {
  test("allows one warning per Bot and permission on each date", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-permission-warning-test-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "niubot.db"));

    expect(claimDailyBotPermissionWarning(db, "feishu:bot-1", "scope", "2026-09-01")).toBe(true);
    expect(claimDailyBotPermissionWarning(db, "feishu:bot-1", "scope", "2026-09-01")).toBe(false);
    expect(claimDailyBotPermissionWarning(db, "feishu:bot-1", "scope", "2026-09-02")).toBe(true);
    expect(claimDailyBotPermissionWarning(db, "feishu:bot-2", "scope", "2026-09-01")).toBe(true);
  });
});

describe("loop schema", () => {
  test("creates the chat-scoped Loop table and due index", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-loop-test-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "niubot.db"));

    const columns = db.prepare("PRAGMA table_info(loop_jobs)").all() as Array<{ name: string }>;
    const indexes = db.prepare("PRAGMA index_list(loop_jobs)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "chat_id", "creator_user_id", "session_id", "interval_seconds", "prompt",
      "status", "next_run_at", "run_started_at", "consecutive_failures",
    ]));
    expect(indexes.map((index) => index.name)).toContain("idx_loop_jobs_due");
  });

  test("migrates session-scoped rows without losing jobs and makes session_id optional for new code", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-loop-migration-test-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "niubot.db");
    const legacy = openTestDatabase(dbPath);
    legacy.prepare(`
      INSERT INTO loop_jobs (
        chat_id, creator_user_id, session_id, interval_seconds, prompt,
        until_time, next_run_at
      ) VALUES ('c1', 'u1', 'legacy-session', 300, 'keep me',
        '2026-08-05 12:00:00', '2026-08-04 12:00:00')
    `).run();
    legacy.pragma("user_version = 21");
    legacy.close();

    const migrated = openTestDatabase(dbPath);
    expect(migrated.prepare("SELECT id, chat_id, prompt FROM loop_jobs WHERE id = 1").get()).toEqual({
      id: 1,
      chat_id: "c1",
      prompt: "keep me",
    });
    expect(() => migrated.prepare(`
      INSERT INTO loop_jobs (
        chat_id, creator_user_id, interval_seconds, prompt, until_time, next_run_at
      ) VALUES ('c1', 'u1', 300, 'new row', '2026-08-05 12:00:00', '2026-08-04 12:00:00')
    `).run()).not.toThrow();
    expect(migrated.prepare("SELECT session_id FROM loop_jobs WHERE id = 2").pluck().get()).toBe("");
    migrated.close();

    const reopened = openTestDatabase(dbPath);
    expect(reopened.prepare("SELECT COUNT(*) FROM loop_jobs").pluck().get()).toBe(2);
    expect((reopened.prepare("PRAGMA index_list(loop_jobs)").all() as Array<{ name: string }>)
      .map((index) => index.name)).not.toContain("idx_loop_jobs_session");
  });
});

describe("messages platform_msg_id unique index", () => {
  test("new databases have a unique index on platform message ids", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-msg-unique-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "niubot.db"));
    const indexes = db.prepare("PRAGMA index_list(messages)").all() as Array<{ name: string; unique: number }>;
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "idx_messages_platform_msg_id", unique: 1 }),
    ]));
  });

  test("storeMessage reuses the existing row for the same platform message id", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-msg-dedupe-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "niubot.db"));
    const userId = ensureUser(db, "feishu", "ou-zen", "Zen");
    const chatId = ensureChat(db, "feishu", "oc-group", "group", "bots");
    const first = storeMessage(db, {
      chatId,
      senderId: userId,
      role: "user",
      contentText: "first",
      platform: "feishu",
      platformMsgId: "om-dup",
    });
    const second = storeMessage(db, {
      chatId,
      senderId: userId,
      role: "user",
      contentText: "second",
      platform: "feishu",
      platformMsgId: "om-dup",
    });
    expect(second).toBe(first);
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE platform_msg_id = 'om-dup'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT content_text FROM messages WHERE id = ?").get(first)).toEqual({ content_text: "first" });
  });

  test("updateMessagePlatformId does not steal an id already owned by another row", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-msg-platform-id-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "niubot.db"));
    const userId = ensureUser(db, "feishu", "ou-zen", "Zen");
    const chatId = ensureChat(db, "feishu", "oc-group", "group", "bots");
    const first = storeMessage(db, {
      chatId,
      senderId: userId,
      role: "assistant",
      contentText: "first",
      platform: "feishu",
      platformMsgId: "om-sent",
    });
    const second = storeMessage(db, {
      chatId,
      senderId: userId,
      role: "assistant",
      contentText: "second",
      platform: "feishu",
    });
    updateMessagePlatformId(db, second, "om-sent");
    expect(db.prepare("SELECT platform_msg_id FROM messages WHERE id = ?").get(first))
      .toEqual({ platform_msg_id: "om-sent" });
    expect(db.prepare("SELECT platform_msg_id FROM messages WHERE id = ?").get(second))
      .toEqual({ platform_msg_id: null });
  });

  test("migrates duplicate platform messages down to one row", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-msg-migrate-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "niubot.db");
    const legacy = openTestDatabase(dbPath);
    const userId = ensureUser(legacy, "feishu", "ou-zen", "Zen");
    const chatId = ensureChat(legacy, "feishu", "oc-group", "group", "bots");
    legacy.exec("DROP INDEX IF EXISTS idx_messages_platform_msg_id");
    legacy.prepare(`
      INSERT INTO messages (id, chat_id, sender_id, role, content_text, content_type, platform, platform_msg_id)
      VALUES (21, ?, ?, 'user', 'keep', 'text', 'feishu', 'om-dup')
    `).run(chatId, userId);
    legacy.prepare(`
      INSERT INTO messages (id, chat_id, sender_id, role, content_text, content_type, platform, platform_msg_id)
      VALUES (22, ?, ?, 'user', 'drop', 'text', 'feishu', 'om-dup')
    `).run(chatId, userId);
    legacy.prepare("INSERT INTO messages_fts (rowid, content_text) VALUES (21, 'keep')").run();
    legacy.prepare("INSERT INTO messages_fts (rowid, content_text) VALUES (22, 'drop')").run();
    legacy.prepare(
      "UPDATE niubot_component_schema_versions SET version = 30 WHERE component = 'core'",
    ).run();
    legacy.pragma("user_version = 30");
    legacy.close();

    const migrated = openTestDatabase(dbPath);
    const rows = migrated.prepare(
      "SELECT id, content_text FROM messages WHERE platform_msg_id = 'om-dup' ORDER BY id",
    ).all();
    expect(rows).toEqual([{ id: 21, content_text: "keep" }]);
    const indexes = migrated.prepare("PRAGMA index_list(messages)").all() as Array<{ name: string; unique: number }>;
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "idx_messages_platform_msg_id", unique: 1 }),
    ]));
  });
});

describe("topic schema v32", () => {
  test("adds topic columns, thread message fields, and thread history cursors", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-topic-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "niubot.db"));

    const chatColumns = db.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>;
    const messageColumns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    const runtimeColumns = db.prepare("PRAGMA table_info(runtime_events)").all() as Array<{ name: string }>;

    expect(chatColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "chat_mode", "group_message_type", "chat_mode_fetched_at",
    ]));
    expect(messageColumns.map((column) => column.name)).toContain("thread_id");
    expect(sessionColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "thread_id", "root_platform_msg_id", "last_inbound_platform_msg_id",
    ]));
    expect(runtimeColumns.map((column) => column.name)).toContain("thread_id");
    expect((db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_history_cursors'",
    ).get() as { name: string } | undefined)?.name).toBe("thread_history_cursors");

    const userId = ensureUser(db, "feishu", "ou-zen", "Zen");
    const chatId = ensureChat(db, "feishu", "oc-topic", "group", "Topic group");
    updateChatMetadata(db, chatId, {
      chatMode: "topic",
      groupMessageType: "thread",
      fetchedAt: 123456,
    });
    expect(getChatMetadata(db, chatId)).toEqual({
      chatMode: "topic",
      groupMessageType: "thread",
      fetchedAt: 123456,
    });

    const msgId = storeMessage(db, {
      chatId,
      senderId: userId,
      role: "user",
      contentText: "thread hello",
      platform: "feishu",
      platformMsgId: "om-thread",
      threadId: "omt_aaa",
    });
    expect(getMessageByPlatformId(db, "feishu", "om-thread")).toMatchObject({
      id: msgId,
      threadId: "omt_aaa",
    });

    recordRuntimeEvent(db, {
      botId: "NiuBot",
      chatId,
      threadId: "omt_aaa",
      runId: "run-thread",
      messageIds: [msgId],
      stage: "queued",
      event: "started",
    });
    expect(getRecentRuntimeEvents(db, {
      chatId,
      threadId: "omt_aaa",
      limit: 10,
    })[0]).toMatchObject({
      threadId: "omt_aaa",
      runId: "run-thread",
    });
  });

  test("migrates a v31 database with duplicate active sessions and archives extras before adding unique indexes", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-topic-migrate-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "niubot.db");
    const legacy = openTestDatabase(dbPath);
    const userId = ensureUser(legacy, "feishu", "ou-zen", "Zen");
    const chatId = ensureChat(legacy, "feishu", "oc-group", "group", "Group");
    legacy.exec(`
      DROP TABLE thread_history_cursors;
      DROP INDEX IF EXISTS idx_sessions_active_thread;
      DROP INDEX IF EXISTS idx_sessions_active_chat;
      DROP INDEX IF EXISTS idx_messages_chat_thread_time;
      DROP INDEX IF EXISTS idx_sessions_chat_thread;
      ALTER TABLE messages DROP COLUMN thread_id;
      ALTER TABLE sessions DROP COLUMN thread_id;
      ALTER TABLE sessions DROP COLUMN root_platform_msg_id;
      ALTER TABLE sessions DROP COLUMN last_inbound_platform_msg_id;
      ALTER TABLE chats DROP COLUMN chat_mode;
      ALTER TABLE chats DROP COLUMN group_message_type;
      ALTER TABLE chats DROP COLUMN chat_mode_fetched_at;
      ALTER TABLE loop_jobs DROP COLUMN thread_id;
      ALTER TABLE cron_jobs DROP COLUMN thread_id;
      ALTER TABLE runtime_events DROP COLUMN thread_id;
    `);
    legacy.exec(`
      INSERT INTO sessions (id, chat_id, user_id, source, status, started_at, last_active_at)
      VALUES ('s-old', '${chatId}', '${userId}', 'user', 'active', datetime('now'), datetime('now', '-1 hour'));
      INSERT INTO sessions (id, chat_id, user_id, source, status, started_at, last_active_at)
      VALUES ('s-new', '${chatId}', '${userId}', 'user', 'active', datetime('now'), datetime('now'));
    `);
    legacy.prepare(
      "UPDATE niubot_component_schema_versions SET version = 31 WHERE component = 'core'",
    ).run();
    legacy.pragma("user_version = 31");
    legacy.close();

    const migrated = openTestDatabase(dbPath);
    expect(migrated.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(migrated.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE chat_id = ? AND status = 'active' AND source = 'user'",
    ).get(chatId)).toEqual({ count: 1 });
    const sessionIndexes = migrated.prepare("PRAGMA index_list(sessions)").all() as Array<{ name: string }>;
    expect(sessionIndexes.map((index) => index.name)).toContain("idx_sessions_active_thread");
    expect(sessionIndexes.map((index) => index.name)).toContain("idx_sessions_active_chat");
    expect((migrated.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>)
      .map((column) => column.name)).toEqual(expect.arrayContaining(["chat_mode", "group_message_type"]));
    migrated.close();
  });
});

describe("core migration waterline", () => {
  test("reopening an upgraded database does not rewrite the core migration marker", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-waterline-test-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "niubot.db");
    const first = openTestDatabase(dbPath);
    first.exec(`
      CREATE TABLE core_marker_writes (count INTEGER NOT NULL);
      INSERT INTO core_marker_writes VALUES (0);
      CREATE TRIGGER audit_core_marker_update
      AFTER UPDATE ON niubot_component_schema_versions
      WHEN NEW.component = 'core'
      BEGIN
        UPDATE core_marker_writes SET count = count + 1;
      END;
    `);
    first.close();

    const reopened = openTestDatabase(dbPath);
    expect(reopened.prepare("SELECT count FROM core_marker_writes").get()).toEqual({ count: 0 });
    expect(reopened.prepare(
      "SELECT version FROM niubot_component_schema_versions WHERE component = 'core'",
    ).get()).toEqual({ version: LATEST_SCHEMA_VERSION });
  });
});

describe("bot runtime state", () => {
  test("persists backend and model for a bot", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "niubot.db"));

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
    const db = openTestDatabase(path.join(dir, "niubot.db"));

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
    const db = openTestDatabase(path.join(dir, "niubot.db"));
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
    const db = openTestDatabase(path.join(dir, "niubot.db"));

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
    const db = openTestDatabase(dbPath);

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

  test("persists agent config per scope", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-scope-config-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "niubot.db"));
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(34);

    setScopeRuntimeConfig(db, "NiuBot", "c5#t1", {
      backendType: "grok",
      model: "grok-model",
      effort: "high",
    });
    expect(getScopeRuntimeConfig(db, "NiuBot", "c5#t1")).toEqual({
      backendType: "grok",
      model: "grok-model",
      effort: "high",
    });

    setScopeRuntimeConfig(db, "NiuBot", "c5#t1", {
      backendType: "grok",
    });
    expect(getScopeRuntimeConfig(db, "NiuBot", "c5#t1")).toEqual({
      backendType: "grok",
    });

    deleteScopeRuntimeConfig(db, "NiuBot", "c5#t1");
    expect(getScopeRuntimeConfig(db, "NiuBot", "c5#t1")).toBeUndefined();
  });

  test("materializes a scope config without overwriting an existing one", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-scope-materialize-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "niubot.db"));

    const first = ensureScopeRuntimeConfig(db, "NiuBot", "c5#t1", {
      backendType: "grok",
      model: "grok-model",
      effort: "high",
    });
    expect(first).toEqual({
      backendType: "grok",
      model: "grok-model",
      effort: "high",
    });

    const second = ensureScopeRuntimeConfig(db, "NiuBot", "c5#t1", {
      backendType: "codex",
      model: "codex-model",
      effort: "low",
    });
    expect(second).toEqual(first);
    expect(getScopeRuntimeConfig(db, "NiuBot", "c5#t1")).toEqual(first);
  });

  test("drops leftover scope override tables and the source column", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-drop-legacy-scope-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "niubot.db");
    const db = openTestDatabase(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS scope_runtime_models (
        bot_name TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        backend_type TEXT NOT NULL,
        PRIMARY KEY (bot_name, scope_key, backend_type)
      );
      CREATE TABLE IF NOT EXISTS scope_runtime_backends (
        bot_name TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        backend_type TEXT NOT NULL,
        PRIMARY KEY (bot_name, scope_key)
      );
    `);
    db.exec("DROP TABLE scope_runtime_configs");
    db.exec(`
      CREATE TABLE scope_runtime_configs (
        bot_name TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        backend_type TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        source TEXT NOT NULL DEFAULT 'inherited',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (bot_name, scope_key)
      );
    `);
    db.prepare(`
      INSERT INTO scope_runtime_configs (bot_name, scope_key, backend_type, model, source)
      VALUES ('NiuBot', 'c1', 'grok', 'p2p-model', 'explicit'),
             ('NiuBot', 'c5#t1', 'grok', NULL, 'inherited')
    `).run();
    db.prepare("DELETE FROM niubot_component_schema_versions WHERE component = 'core'").run();
    db.pragma("user_version = 37");
    db.close();

    const migrated = openTestDatabase(dbPath);
    expect(migrated.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE name = 'scope_runtime_models'").get()).toBeUndefined();
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE name = 'scope_runtime_backends'").get()).toBeUndefined();
    expect((migrated.prepare("PRAGMA table_info(scope_runtime_configs)").all() as Array<{ name: string }>)
      .some((column) => column.name === "source")).toBe(false);
    expect(getScopeRuntimeConfig(migrated, "NiuBot", "c1")).toEqual({
      backendType: "grok",
      model: "p2p-model",
    });
    expect(getScopeRuntimeConfig(migrated, "NiuBot", "c5#t1")).toBeUndefined();
  });

  test("finds a user's p2p chat for default runtime fallback", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-p2p-chat-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "niubot.db"));
    db.prepare("INSERT INTO users (id, name, platform, platform_id) VALUES ('u2', 'Zen', 'feishu', 'ou-zen')").run();
    db.prepare("INSERT INTO users (id, name, platform, platform_id) VALUES ('u3', 'Other', 'feishu', 'ou-other')").run();
    db.prepare("INSERT INTO chats (id, type, platform, platform_id, user_id) VALUES ('c1', 'p2p', 'feishu', 'oc-p2p', 'ou-zen')").run();
    db.prepare("INSERT INTO chats (id, type, platform, platform_id) VALUES ('c5', 'group', 'feishu', 'oc-group')").run();

    expect(findP2pChatIdForUser(db, "u2")).toBe("c1");
    expect(findP2pChatIdForUser(db, "u3")).toBeUndefined();
  });
});

describe("runtime events schema", () => {
  test("creates runtime_events for a new database", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "niubot.db"));

    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_events'",
    ).get() as { name: string } | undefined;

    expect(row?.name).toBe("runtime_events");
  });

  test("migrates an old database to include runtime_events", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "niubot.db");
    const db = openTestDatabase(dbPath);
    db.prepare("DROP TABLE runtime_events").run();
    db.pragma("user_version = 14");
    db.prepare("DELETE FROM niubot_component_schema_versions WHERE component = 'core'").run();
    db.close();

    const migrated = openTestDatabase(dbPath);
    const row = migrated.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_events'",
    ).get() as { name: string } | undefined;

    expect(row?.name).toBe("runtime_events");
  });

  test("queries recent events by chat and run", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "niubot.db"));

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
    const db = openTestDatabase(path.join(dir, "niubot.db"));

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
    const db = openTestDatabase(dbPath);
    db.pragma("user_version = 15");
    db.exec("ALTER TABLE cron_jobs DROP COLUMN timezone");
    db.prepare("DELETE FROM niubot_component_schema_versions WHERE component = 'core'").run();
    db.close();

    const migrated = openTestDatabase(dbPath);
    const columns = migrated.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("timezone");
    // LATEST（26）是破坏性迁移（DROP COLUMN）：升级后 user_version 推进到最新，旧二进制被拒绝启动
    expect(migrated.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  });
});

describe("public upgrade rollback compatibility", () => {
  test.each([10, 11, 12, 13, 14, 15, 16])(
    "supports schema %i upgrade, exact-version rollback, and re-upgrade",
    (legacyVersion) => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
      tempDirs.push(dir);
      const dbPath = path.join(dir, "niubot.db");
      const fixture = openTestDatabase(dbPath);
      downgradeToPublicSchemaFixture(fixture, legacyVersion);
      fixture.prepare(`
        INSERT INTO cron_jobs (
          chat_id, creator_user_id, cron_expr, run_at, prompt,
          description, max_times, until_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("c1", "u1", "0 * * * *", null, "before-upgrade", "", null, null);
      fixture.pragma(`user_version = ${legacyVersion}`);
      fixture.close();

      const upgraded = openTestDatabase(dbPath);
      // LATEST（26）为破坏性迁移：升级后 user_version 推进到最新（旧二进制拒绝启动，而非崩溃）
      expect(upgraded.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
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

      // 26 为破坏性迁移，user_version 已推进到 LATEST：旧二进制会被拒绝启动（而非崩溃）。
      // 这里模拟「旧代码忽略新版本号继续操作」的 SQL 兼容性（表结构仍允许旧 SQL）。
      const rolledBack = openRawTestDatabase(dbPath);
      expect(rolledBack.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
      expect(() => rolledBack.prepare(`
        INSERT INTO cron_jobs (
          chat_id, creator_user_id, cron_expr, run_at, prompt,
          description, max_times, until_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("c1", "u1", "30 * * * *", null, "during-rollback", "", null, null)).not.toThrow();
      rolledBack.close();

      const reupgraded = openTestDatabase(dbPath);
      expect(reupgraded.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
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
    const fixture = openTestDatabase(dbPath);
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

    const resumed = openTestDatabase(dbPath);
    // LATEST（26）为破坏性迁移：升级后 user_version 推进到最新
    expect(resumed.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
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
    const legacy = openRawTestDatabase(dbPath);
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

    const migrated = openTestDatabase(dbPath);
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
    expect(migrated.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(migrated.prepare(
      "SELECT version FROM niubot_component_schema_versions WHERE component = 'transport'",
    ).pluck().get()).toBe(2);
  });

  test("rejects incomplete transport tables instead of trusting inferred state", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "niubot.db");
    const database = openTestDatabase(dbPath);
    database.exec(`
      DELETE FROM niubot_component_schema_versions WHERE component = 'transport';
      DROP TABLE transport_outbox;
    `);
    database.close();

    expect(() => openTestDatabase(dbPath)).toThrow(/Transport schema is incomplete/);
  });

  test("rejects component metadata that disagrees with transport tables", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "niubot.db");
    const database = openTestDatabase(dbPath);
    database.prepare(
      "UPDATE niubot_component_schema_versions SET version = 1 WHERE component = 'transport'",
    ).run();
    database.close();

    expect(() => openTestDatabase(dbPath)).toThrow(/does not match its tables/);
  });

  test("rejects transport tables with incomplete claim columns", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "niubot.db");
    const database = openTestDatabase(dbPath);
    database.exec(`
      ALTER TABLE transport_inbox DROP COLUMN claimed_at;
      DELETE FROM niubot_component_schema_versions WHERE component = 'transport';
    `);
    database.close();

    expect(() => openTestDatabase(dbPath)).toThrow(/claim schema is incomplete/);
  });
});

describe("bot identity helpers", () => {
  test("setUserIsBot and listChatBots include self and speakers", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-bot-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "niubot.db"));
    const selfId = ensureUser(db, "feishu", "ou-self", "NiuBot");
    const cowId = ensureUser(db, "feishu", "ou-cow", "CowBot");
    const humanId = ensureUser(db, "feishu", "ou-zen", "Zen");
    setUserIsBot(db, selfId);
    setUserIsBot(db, cowId);
    const chatId = ensureChat(db, "feishu", "oc-group", "group");
    storeMessage(db, {
      chatId,
      senderId: cowId,
      role: "user",
      contentText: "hi",
      platform: "feishu",
    });
    storeMessage(db, {
      chatId,
      senderId: humanId,
      role: "user",
      contentText: "hey",
      platform: "feishu",
    });

    expect(getUserIsBot(db, selfId)).toBe(true);
    expect(getUserIsBot(db, cowId)).toBe(true);
    expect(getUserIsBot(db, humanId)).toBe(false);
    expect(listChatBots(db, chatId, selfId).map((row) => row.id).sort()).toEqual([cowId, selfId].sort());
  });

  test("getUserIdentityByPlatformId reports missing, human, and bot rows", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-identity-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "niubot.db"));
    const humanId = ensureUser(db, "feishu", "ou-zen", "Zen");
    const cowId = ensureUser(db, "feishu", "ou-cow", "CowBot");
    setUserIsBot(db, cowId);

    expect(getUserIdentityByPlatformId(db, "feishu", "ou-missing")).toBeUndefined();
    expect(getUserIdentityByPlatformId(db, "feishu", "ou-zen")).toEqual({ id: humanId, isBot: false });
    expect(getUserIdentityByPlatformId(db, "feishu", "ou-cow")).toEqual({ id: cowId, isBot: true });
  });

  test("merges a legacy placeholder into the real Bot and migrates every local user reference", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-bot-reconcile-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "niubot.db"));
    const legacyId = ensureUser(db, "feishu", "_bot_NiuBot_", "Old Bot", "manual");
    const realId = ensureUser(db, "feishu", "ou-real-bot", "NiuBot", "bot_info");
    const appAliasId = ensureUser(db, "feishu", "cli_NiuBot_app", "App Alias", "bot_sender");
    db.prepare("UPDATE users SET is_bot = 1, is_admin = 'owner' WHERE id = ?").run(legacyId);
    db.prepare("UPDATE users SET is_bot = 1, is_admin = 'admin' WHERE id = ?").run(realId);
    setUserIsBot(db, appAliasId);
    const chatId = ensureChat(db, "feishu", "oc-group", "group", "Bots");

    storeMessage(db, {
      chatId,
      senderId: legacyId,
      role: "user",
      contentText: "from old identity",
      platform: "feishu",
    });
    db.prepare(`
      INSERT INTO sessions (id, chat_id, user_id, status)
      VALUES ('session-old-bot', ?, ?, 'archived')
    `).run(chatId, legacyId);
    db.prepare(`
      INSERT INTO user_memory (user_id, summary)
      VALUES (?, 'old bot memory')
    `).run(legacyId);
    db.prepare(`
      INSERT INTO cron_jobs (chat_id, creator_user_id, prompt)
      VALUES (?, ?, 'old cron')
    `).run(chatId, legacyId);
    db.prepare(`
      INSERT INTO loop_jobs (
        chat_id, creator_user_id, interval_seconds, prompt, until_time, next_run_at
      ) VALUES (?, ?, 300, 'old loop', '2026-08-30 12:00:00', '2026-08-29 12:00:00')
    `).run(chatId, legacyId);
    db.prepare(`
      INSERT INTO worker_works (id, bot_id, owner_user_id, source_chat_id, request)
      VALUES ('old-work', 'NiuBot', ?, ?, 'old work')
    `).run(legacyId, chatId);
    db.prepare(`
      INSERT INTO team_config_versions (version, bot_id, config_yaml, config_hash, applied_by)
      VALUES ('old-version', 'NiuBot', '{}', 'hash', ?)
    `).run(legacyId);
    db.prepare(`
      INSERT INTO team_config_drafts (id, bot_id, config_yaml, created_by)
      VALUES ('old-draft', 'NiuBot', '{}', ?)
    `).run(legacyId);

    const first = reconcileBotIdentity(db, "feishu", "ou-real-bot", ["_bot_NiuBot_", "cli_NiuBot_app"]);

    expect(first).toEqual({
      canonicalUserId: realId,
      promoted: false,
      mergedUserIds: [legacyId, appAliasId],
      migratedReferenceCount: 8,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE platform = 'feishu'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT name, name_source, is_bot, is_admin FROM users WHERE id = ?").get(realId)).toEqual({
      name: "Old Bot",
      name_source: "manual",
      is_bot: 1,
      is_admin: "owner",
    });
    expect(db.prepare("SELECT sender_id FROM messages").pluck().all()).toEqual([realId]);
    expect(db.prepare("SELECT user_id FROM sessions").pluck().all()).toEqual([realId]);
    expect(db.prepare("SELECT user_id FROM user_memory").pluck().all()).toEqual([realId]);
    expect(db.prepare("SELECT creator_user_id FROM cron_jobs").pluck().all()).toEqual([realId]);
    expect(db.prepare("SELECT creator_user_id FROM loop_jobs").pluck().all()).toEqual([realId]);
    expect(db.prepare("SELECT owner_user_id FROM worker_works").pluck().all()).toEqual([realId]);
    expect(db.prepare("SELECT applied_by FROM team_config_versions").pluck().all()).toEqual([realId]);
    expect(db.prepare("SELECT created_by FROM team_config_drafts").pluck().all()).toEqual([realId]);
    expect(listChatBots(db, chatId, realId)).toEqual([{ id: realId, name: "Old Bot" }]);

    expect(reconcileBotIdentity(db, "feishu", "ou-real-bot", ["_bot_NiuBot_", "cli_NiuBot_app"])).toEqual({
      canonicalUserId: realId,
      promoted: false,
      mergedUserIds: [],
      migratedReferenceCount: 0,
    });
  });

  test("promotes the only legacy placeholder when the real row does not exist yet", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-bot-promote-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "niubot.db"));
    const legacyId = ensureUser(db, "feishu", "_bot-NiuBot_", "NiuBot", "bot_info");
    setUserIsBot(db, legacyId);

    expect(reconcileBotIdentity(db, "feishu", "ou-real-bot", ["_bot-NiuBot_"])).toMatchObject({
      canonicalUserId: legacyId,
      promoted: true,
      mergedUserIds: [],
      migratedReferenceCount: 0,
    });
    expect(db.prepare("SELECT platform_id FROM users WHERE id = ?").pluck().get(legacyId)).toBe("ou-real-bot");
    expect(reconcileBotIdentity(db, "feishu", "ou-real-bot", ["_bot-NiuBot_"])).toMatchObject({
      canonicalUserId: legacyId,
      promoted: false,
      mergedUserIds: [],
    });
  });
});
