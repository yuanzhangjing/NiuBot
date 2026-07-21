import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import type { NiuBotConfig } from "../config.js";
import {
  initDatabase,
  LATEST_SCHEMA_VERSION,
  ROLLBACK_COMPATIBLE_SCHEMA_VERSIONS,
} from "./schema.js";
import {
  applyPreflightDatabaseManifest,
  assertDatabasesAtCompatibleSchemaVersion,
  cleanupRestartDatabaseSnapshot,
  createRestartDatabaseSnapshot,
  restoreRestartDatabaseSnapshot,
} from "./restart-snapshot.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("restart database snapshot", () => {
  test("keeps transport schema separate from the core schema", () => {
    const root = temporaryDirectory();
    const database = initDatabase(path.join(root, "bridge.db"));

    expect(LATEST_SCHEMA_VERSION).toBe(16);
    expect(database.pragma("user_version", { simple: true })).toBe(16);
    expect(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('transport_inbox', 'transport_outbox')",
    ).all()).toHaveLength(2);
    expect(database.prepare(
      "SELECT version FROM niubot_component_schema_versions WHERE component = 'transport'",
    ).pluck().get()).toBe(2);

    database.close();
  });

  test("backs up a live WAL database and maps preflight to an isolated copy", async () => {
    const root = temporaryDirectory();
    const databasePath = path.join(root, "live", "bot.db");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const live = new Database(databasePath);
    live.pragma("journal_mode = WAL");
    live.exec("CREATE TABLE items (value TEXT); INSERT INTO items VALUES ('before')");

    const snapshot = await createRestartDatabaseSnapshot({
      rootDirectory: path.join(root, "snapshot"),
      databasePaths: [databasePath],
    });
    expect(fs.readdirSync(snapshot.rootDirectory).some((name) => /-(?:wal|shm|journal)$/.test(name)))
      .toBe(false);
    const mapped = applyPreflightDatabaseManifest(config(databasePath), snapshot.manifestPath);
    expect(mapped.bots[0]?.dbPath).not.toBe(databasePath);
    const preflight = new Database(mapped.bots[0]!.dbPath);
    preflight.exec("INSERT INTO items VALUES ('preflight')");
    preflight.close();
    expect(live.prepare("SELECT value FROM items ORDER BY rowid").pluck().all()).toEqual(["before"]);

    live.exec("INSERT INTO items VALUES ('candidate')");
    live.close();
    restoreRestartDatabaseSnapshot(snapshot);
    const restored = new Database(databasePath, { readonly: true });
    expect(restored.prepare("SELECT value FROM items ORDER BY rowid").pluck().all()).toEqual(["before"]);
    restored.close();
    cleanupRestartDatabaseSnapshot(snapshot);
    expect(fs.existsSync(snapshot.rootDirectory)).toBe(false);
  });

  test("deduplicates shared databases and restores an originally missing database", async () => {
    const root = temporaryDirectory();
    const missingPath = path.join(root, "data", "new.db");
    const snapshot = await createRestartDatabaseSnapshot({
      rootDirectory: path.join(root, "snapshot"),
      databasePaths: [missingPath, missingPath],
    });
    expect(snapshot.records).toHaveLength(1);
    const mapped = applyPreflightDatabaseManifest({
      ...config(missingPath),
      bots: [config(missingPath).bots[0]!, { ...config(missingPath).bots[0]!, id: "SecondBot" }],
    }, snapshot.manifestPath);
    expect(mapped.bots[0]?.dbPath).toBe(mapped.bots[1]?.dbPath);
    fs.mkdirSync(path.dirname(missingPath), { recursive: true });
    const created = new Database(missingPath);
    created.exec("CREATE TABLE candidate_data (value TEXT)");
    created.close();
    fs.writeFileSync(`${missingPath}-journal`, "candidate");

    restoreRestartDatabaseSnapshot(snapshot);
    expect(fs.existsSync(missingPath)).toBe(false);
    expect(fs.existsSync(`${missingPath}-journal`)).toBe(false);
  });

  test("rejects an incomplete or escaping preflight mapping", async () => {
    const root = temporaryDirectory();
    const databasePath = path.join(root, "bot.db");
    const snapshot = await createRestartDatabaseSnapshot({
      rootDirectory: path.join(root, "snapshot"),
      databasePaths: [databasePath],
    });
    expect(() => applyPreflightDatabaseManifest(config(path.join(root, "other.db")), snapshot.manifestPath))
      .toThrow(/mapping missing/);

    fs.writeFileSync(snapshot.manifestPath, JSON.stringify({
      schemaVersion: 1,
      mappings: [{ sourcePath: databasePath, preflightPath: path.join(root, "escape.db") }],
    }));
    expect(() => applyPreflightDatabaseManifest(config(databasePath), snapshot.manifestPath))
      .toThrow(/inside the snapshot directory/);
  });

  test("only allows legacy preflight for rollback-compatible core schemas", () => {
    const root = temporaryDirectory();
    const databasePath = path.join(root, "bot.db");
    const database = new Database(databasePath);
    database.pragma(`user_version = ${LATEST_SCHEMA_VERSION}`);
    database.close();

    expect(() => assertDatabasesAtCompatibleSchemaVersion(
      [databasePath],
      ROLLBACK_COMPATIBLE_SCHEMA_VERSIONS,
    )).not.toThrow();

    const legacy = new Database(databasePath);
    legacy.pragma("user_version = 15");
    legacy.close();
    expect(() => assertDatabasesAtCompatibleSchemaVersion(
      [databasePath],
      ROLLBACK_COMPATIBLE_SCHEMA_VERSIONS,
    )).not.toThrow();

    expect(() => assertDatabasesAtCompatibleSchemaVersion([databasePath], [LATEST_SCHEMA_VERSION + 1]))
      .toThrow(/cannot safely upgrade/);
    expect(() => assertDatabasesAtCompatibleSchemaVersion(
      [path.join(root, "missing.db")],
      ROLLBACK_COMPATIBLE_SCHEMA_VERSIONS,
    ))
      .toThrow(/missing database/);
  });

  test("preserves the snapshot directory when restore cannot proceed", async () => {
    const root = temporaryDirectory();
    const databasePath = path.join(root, "bot.db");
    const database = new Database(databasePath);
    database.exec("CREATE TABLE marker (value TEXT)");
    database.close();
    const snapshot = await createRestartDatabaseSnapshot({
      rootDirectory: path.join(root, "snapshot"),
      databasePaths: [databasePath],
    });
    fs.rmSync(snapshot.records[0]!.rollbackPath!);

    expect(() => restoreRestartDatabaseSnapshot(snapshot)).toThrow();
    expect(fs.existsSync(snapshot.rootDirectory)).toBe(true);
  });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-restart-snapshot-"));
  tempDirectories.push(directory);
  return directory;
}

function config(databasePath: string): NiuBotConfig {
  return {
    bots: [{
      id: "TestBot",
      appId: "app",
      appSecret: "secret",
      backend: "codex",
      workingDirectory: path.dirname(databasePath),
      dbPath: databasePath,
    }],
    queue: { bufferMs: 1_500 },
  };
}
