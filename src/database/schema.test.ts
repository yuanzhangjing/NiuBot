import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  initDatabase,
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("bot runtime state", () => {
  test("persists backend, model, and lite model for a bot", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const db = initDatabase(path.join(dir, "niubot.db"));

    setBotRuntimeState(db, "NiuBot", {
      backendType: "codex",
      model: "gpt-5.5",
      liteModel: "gpt-5.4-mini",
    });

    expect(getBotRuntimeState(db, "NiuBot")).toEqual({
      backendType: "codex",
      model: "gpt-5.5",
      liteModel: "gpt-5.4-mini",
    });
  });

  test("can clear runtime models without clearing backend", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const db = initDatabase(path.join(dir, "niubot.db"));

    setBotRuntimeState(db, "NiuBot", {
      backendType: "codex",
      model: "gpt-5.5",
      liteModel: "gpt-5.4-mini",
    });
    clearBotRuntimeModels(db, "NiuBot");

    expect(getBotRuntimeState(db, "NiuBot")).toEqual({
      backendType: "codex",
      model: undefined,
      liteModel: undefined,
    });
  });

  test("persists model cache separately for each backend", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schema-test-"));
    tempDirs.push(dir);
    const db = initDatabase(path.join(dir, "niubot.db"));

    setBotBackendModelState(db, "NiuBot", "claude", {
      model: "claude-opus-4-6",
      liteModel: "haiku",
    });
    setBotBackendModelState(db, "NiuBot", "codex", {
      model: "gpt-5.5",
      liteModel: "gpt-5.4-mini",
    });

    expect(getBotBackendModelState(db, "NiuBot", "claude")).toEqual({
      model: "claude-opus-4-6",
      liteModel: "haiku",
    });
    expect(getBotBackendModelState(db, "NiuBot", "codex")).toEqual({
      model: "gpt-5.5",
      liteModel: "gpt-5.4-mini",
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
      liteModel: "legacy-lite",
    });
    setBotBackendModelState(db, "NiuBot", "codex", {
      model: "gpt-5.5",
      liteModel: "gpt-5.4-mini",
    });

    expect(loadPersistedBotRuntimeState(dbPath, "NiuBot")).toEqual({
      backendType: "codex",
      model: "gpt-5.5",
      liteModel: "gpt-5.4-mini",
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
