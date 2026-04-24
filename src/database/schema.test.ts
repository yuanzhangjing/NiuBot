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
