import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, setBotRuntimeBackend } from "../database/schema.js";
import { resolveSummarizerBackend } from "./summarize.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("resolveSummarizerBackend", () => {
  it("prefers config over the persisted runtime backend", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-summarize-cli-test-"));
    tempDirs.push(dir);

    const dbPath = path.join(dir, "niubot.db");
    const db = initDatabase(dbPath);
    setBotRuntimeBackend(db, "NiuBot", "codex");
    db.close();

    const config = {
      defaultConfig: {
        backend: "claude" as const,
        liteModel: {
          claude: "haiku",
          codex: "gpt-5.4-mini",
        },
      },
      queue: { bufferMs: 3000, cancelThresholdMs: 10000 },
      bots: [{
        name: "NiuBot",
        appId: "app",
        appSecret: "secret",
        dbPath,
        workingDirectory: dir,
        personaPath: path.join(dir, "persona.md"),
      }],
    };

    expect(resolveSummarizerBackend(config, "NiuBot")).toMatchObject({
      backendType: "claude",
      liteModel: "haiku",
    });
  });

  it("falls back to the bot or global config backend when no runtime state exists", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-summarize-cli-test-"));
    tempDirs.push(dir);

    const dbPath = path.join(dir, "niubot.db");

    const config = {
      defaultConfig: {
        backend: "claude" as const,
        liteModel: {
          claude: "haiku",
          codex: "gpt-5.4-mini",
        },
      },
      queue: { bufferMs: 3000, cancelThresholdMs: 10000 },
      bots: [{
        name: "NiuBot",
        appId: "app",
        appSecret: "secret",
        backend: "codex" as const,
        dbPath,
        workingDirectory: dir,
        personaPath: path.join(dir, "persona.md"),
      }],
    };

    expect(resolveSummarizerBackend(config, "NiuBot")).toMatchObject({
      backendType: "codex",
      liteModel: "gpt-5.4-mini",
    });
  });
});
