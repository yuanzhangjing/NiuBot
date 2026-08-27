import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { x as extractTar } from "tar";
import yaml from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeTestDatabases, openRawTestDatabase, openTestDatabase } from "../test-utils/database.js";
import { exportBotBundle, importBotBundle, moveBot, rollbackCompletedMove } from "./bot-transfer.js";
import { writeProcessState } from "./process-state.js";

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function createHome(root: string, botId: string, options: { profile?: boolean; marker?: string } = {}): string {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "config.yaml"), yaml.stringify({
    bots: [{
      id: botId,
      backend: "codex",
      appId: `${botId}-app-id`,
      appSecret: `${botId}-app-secret`,
      workingDirectory: path.join(root, "workspace", botId),
    }],
    queue: { bufferMs: 1234 },
  }), { mode: 0o600 });
  const botDirectory = path.join(root, botId);
  fs.mkdirSync(botDirectory);
  const database = openTestDatabase(path.join(botDirectory, "niubot.db"));
  database.exec("CREATE TABLE transfer_marker (value TEXT NOT NULL)");
  database.prepare("INSERT INTO transfer_marker VALUES (?)").run(options.marker ?? botId);
  database.prepare("INSERT INTO users (id, name, platform, platform_id) VALUES ('u1', 'User', 'feishu', 'user-1')").run();
  database.prepare("INSERT INTO chats (id, type, platform, platform_id, user_id) VALUES ('c1', 'p2p', 'feishu', 'chat-1', 'user-1')").run();
  database.prepare(`
    INSERT INTO sessions (id, chat_id, user_id, status, agent_session_id, backend_type, last_active_at)
    VALUES ('s1', 'c1', 'u1', 'idle', 'device-local-session', 'codex', datetime('now'))
  `).run();
  database.close();
  if (options.profile !== false) {
    fs.writeFileSync(path.join(botDirectory, "bot_profile.md"), `# ${botId} profile\n`, { mode: 0o600 });
  }
  return root;
}

function createEmptyTarget(root: string, existingBotId = "Existing"): string {
  return createHome(root, existingBotId);
}

function readBots(home: string): Array<Record<string, unknown>> {
  return yaml.parse(fs.readFileSync(path.join(home, "config.yaml"), "utf-8")).bots;
}

afterEach(() => {
  vi.restoreAllMocks();
  closeTestDatabases();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Bot transfer bundle", () => {
  it("runs export and move dry-run through the user CLI", () => {
    const root = temporaryRoot("niubot-bot-transfer-cli-");
    const source = createHome(path.join(root, "source"), "Mover");
    const bundle = path.join(root, "Mover.nbot");
    const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
    const tsx = path.join(sourceDirectory, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const cli = path.join(sourceDirectory, "user-cli.ts");
    const env = { ...process.env, NIUBOT_LOG_LEVEL: "error" };

    const exported = execFileSync(process.execPath, [tsx, cli, "bot", "export", "Mover", "--home", source], {
      encoding: "utf-8",
      env,
      cwd: root,
    });
    expect(exported).toContain("exported");
    const secondTarget = createEmptyTarget(path.join(root, "second-target"), "SecondExisting");
    const dryRun = execFileSync(process.execPath, [
      tsx, cli, "bot", "move", "Mover", "--from-home", source, "--to-home", secondTarget,
    ], { encoding: "utf-8", env });
    expect(dryRun).toContain("Dry-run");
    expect(readBots(source).map((bot) => bot.id)).toEqual(["Mover"]);
  });

  it("exports a redacted package and imports it with new credentials", async () => {
    const root = temporaryRoot("niubot-bot-transfer-");
    const source = createHome(path.join(root, "source"), "Mover", { marker: "kept" });
    const target = createEmptyTarget(path.join(root, "target"));
    const bundle = path.join(root, "Mover.nbot");
    const sourceConfig = yaml.parse(fs.readFileSync(path.join(source, "config.yaml"), "utf-8"));
    sourceConfig.bots[0].futureApiToken = "must-not-export";
    fs.writeFileSync(path.join(source, "config.yaml"), yaml.stringify(sourceConfig), { mode: 0o600 });

    await exportBotBundle({
      home: source,
      botId: "Mover",
      outputPath: bundle,
      sourceVersion: "1.2.3",
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(bundle).mode & 0o777).toBe(0o600);
    }

    const unpacked = path.join(root, "unpacked");
    fs.mkdirSync(unpacked);
    await extractTar({ file: bundle, cwd: unpacked });
    const bundledBot = yaml.parse(fs.readFileSync(path.join(unpacked, "bot.yaml"), "utf-8"));
    expect(bundledBot).not.toHaveProperty("appId");
    expect(bundledBot).not.toHaveProperty("appSecret");
    expect(bundledBot).not.toHaveProperty("dbPath");
    expect(bundledBot).not.toHaveProperty("botProfilePath");
    expect(bundledBot).not.toHaveProperty("futureApiToken");
    expect(bundledBot).not.toHaveProperty("workingDirectory");

    await expect(importBotBundle({ home: target, bundlePath: bundle }))
      .rejects.toThrow(/provide both --app-id and --app-secret-file/);
    const result = await importBotBundle({
      home: target,
      bundlePath: bundle,
      appId: "new-app-id",
      appSecret: "new-app-secret",
      workingDirectory: path.join(root, "new-workspace"),
    });

    expect(result.botId).toBe("Mover");
    const imported = readBots(target).find((bot) => bot.id === "Mover")!;
    expect(imported).toMatchObject({
      appId: "new-app-id",
      appSecret: "new-app-secret",
      workingDirectory: path.join(root, "new-workspace"),
    });
    expect(imported).not.toHaveProperty("dbPath");
    const database = openRawTestDatabase(result.databasePath, { readonly: true });
    expect(database.prepare("SELECT value FROM transfer_marker").pluck().get()).toBe("kept");
    expect(database.prepare("SELECT agent_session_id FROM sessions WHERE id = 's1'").pluck().get()).toBeNull();
    database.close();
    expect(fs.readFileSync(result.profilePath, "utf-8")).toBe("# Mover profile\n");
  });

  it("can explicitly include credentials and refuses target collisions", async () => {
    const root = temporaryRoot("niubot-bot-transfer-secret-");
    const source = createHome(path.join(root, "source"), "Mover");
    const target = createEmptyTarget(path.join(root, "target"));
    const bundle = path.join(root, "Mover.nbot");
    await exportBotBundle({
      home: source,
      botId: "Mover",
      outputPath: bundle,
      includeSecrets: true,
      sourceVersion: "1.2.3",
    });

    await importBotBundle({ home: target, bundlePath: bundle });
    expect(readBots(target).find((bot) => bot.id === "Mover")).toMatchObject({
      appId: "Mover-app-id",
      appSecret: "Mover-app-secret",
    });
    expect(readBots(target).find((bot) => bot.id === "Mover")).not.toHaveProperty("workingDirectory");
    await expect(importBotBundle({ home: target, bundlePath: bundle }))
      .rejects.toThrow(/already contains bot/);
  });

  it("rejects a package whose contents no longer match its manifest", async () => {
    const root = temporaryRoot("niubot-bot-transfer-corrupt-");
    const source = createHome(path.join(root, "source"), "Mover");
    const target = createEmptyTarget(path.join(root, "target"));
    const bundle = path.join(root, "Mover.nbot");
    await exportBotBundle({ home: source, botId: "Mover", outputPath: bundle, sourceVersion: "1.2.3" });
    const unpacked = path.join(root, "unpacked");
    fs.mkdirSync(unpacked);
    await extractTar({ file: bundle, cwd: unpacked });
    fs.appendFileSync(path.join(unpacked, "bot_profile.md"), "changed\n");
    const changed = path.join(root, "changed.nbot");
    const { c: createTar } = await import("tar");
    await createTar({ file: changed, gzip: true, cwd: unpacked }, [
      "manifest.json", "bot.yaml", "niubot.db", "bot_profile.md",
    ]);

    await expect(importBotBundle({
      home: target,
      bundlePath: changed,
      appId: "id",
      appSecret: "secret",
    })).rejects.toThrow(/checksum mismatch/);
    expect(readBots(target).map((bot) => bot.id)).toEqual(["Existing"]);
  });

  it("rejects import while the target Engine process is alive", async () => {
    const root = temporaryRoot("niubot-bot-transfer-running-");
    const source = createHome(path.join(root, "source"), "Mover");
    const target = createEmptyTarget(path.join(root, "target"));
    const bundle = path.join(root, "Mover.nbot");
    await exportBotBundle({ home: source, botId: "Mover", outputPath: bundle, sourceVersion: "1.2.3" });
    writeProcessState(target, {
      pid: process.pid,
      instanceId: "test-running",
      startedAt: new Date().toISOString(),
      endpoint: path.join(target, "missing.sock"),
      endpointKind: "unix-socket",
      controlToken: "test",
      version: "1.2.3",
      runtimePath: root,
      nodePath: process.execPath,
    });

    await expect(importBotBundle({
      home: target,
      bundlePath: bundle,
      appId: "id",
      appSecret: "secret",
    })).rejects.toThrow(/Engine is running/);
  });

  it("rejects non-regular archive members", async () => {
    const root = temporaryRoot("niubot-bot-transfer-link-");
    const packageRoot = path.join(root, "package");
    fs.mkdirSync(packageRoot);
    for (const name of ["manifest.json", "bot.yaml", "niubot.db"]) {
      fs.writeFileSync(path.join(packageRoot, name), "invalid\n");
    }
    fs.symlinkSync("bot.yaml", path.join(packageRoot, "bot_profile.md"));
    const archive = path.join(root, "linked.nbot");
    const { c: createTar } = await import("tar");
    await createTar({ file: archive, gzip: true, cwd: packageRoot }, [
      "manifest.json", "bot.yaml", "niubot.db", "bot_profile.md",
    ]);
    const target = createEmptyTarget(path.join(root, "target"));

    await expect(importBotBundle({
      home: target,
      bundlePath: archive,
      appId: "id",
      appSecret: "secret",
    })).rejects.toThrow(/regular file/);
  });

  it("serializes concurrent imports without losing config entries", async () => {
    const root = temporaryRoot("niubot-bot-transfer-concurrent-");
    const sourceA = createHome(path.join(root, "source-a"), "BotA");
    const sourceB = createHome(path.join(root, "source-b"), "BotB");
    const target = createEmptyTarget(path.join(root, "target"));
    const bundleA = path.join(root, "BotA.nbot");
    const bundleB = path.join(root, "BotB.nbot");
    await exportBotBundle({ home: sourceA, botId: "BotA", outputPath: bundleA, includeSecrets: true, sourceVersion: "1" });
    await exportBotBundle({ home: sourceB, botId: "BotB", outputPath: bundleB, includeSecrets: true, sourceVersion: "1" });

    const results = await Promise.allSettled([
      importBotBundle({ home: target, bundlePath: bundleA }),
      importBotBundle({ home: target, bundlePath: bundleB }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const importedIds = readBots(target).map((bot) => String(bot.id));
    expect(importedIds).toHaveLength(2);
    expect(["BotA", "BotB"].filter((id) => importedIds.includes(id))).toHaveLength(1);
    expect(["BotA", "BotB"].filter((id) => fs.existsSync(path.join(target, id)))).toHaveLength(1);
  });

  it("recovers an interrupted import before retrying", async () => {
    const root = temporaryRoot("niubot-bot-transfer-recover-");
    const source = createHome(path.join(root, "source"), "Mover");
    const target = createEmptyTarget(path.join(root, "target"));
    const bundle = path.join(root, "Mover.nbot");
    await exportBotBundle({ home: source, botId: "Mover", outputPath: bundle, includeSecrets: true, sourceVersion: "1" });
    const transaction = path.join(target, ".bot-transfer-transactions", "interrupted");
    fs.mkdirSync(transaction, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(target, "config.yaml"), path.join(transaction, "config.original"));
    fs.mkdirSync(path.join(target, "Mover"));
    fs.writeFileSync(path.join(target, "Mover", "bot_profile.md"), "# incomplete\n");
    const interruptedConfig = yaml.parse(fs.readFileSync(path.join(target, "config.yaml"), "utf-8"));
    interruptedConfig.bots.push({ id: "Mover", backend: "codex", appId: "id", appSecret: "secret" });
    fs.writeFileSync(path.join(target, "config.yaml"), yaml.stringify(interruptedConfig), { mode: 0o600 });
    fs.writeFileSync(path.join(transaction, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      kind: "import",
      phase: "data-published",
      botId: "Mover",
      home: target,
      configPath: path.join(target, "config.yaml"),
      botDirectory: path.join(target, "Mover"),
    }));

    await importBotBundle({ home: target, bundlePath: bundle });
    expect(readBots(target).map((bot) => bot.id)).toEqual(["Existing", "Mover"]);
    expect(fs.existsSync(path.join(target, ".bot-transfer-transactions"))).toBe(false);
  });

  it("rejects reserved Bot IDs and symlinked staging directories", async () => {
    const root = temporaryRoot("niubot-bot-transfer-paths-");
    const reserved = createHome(path.join(root, "reserved"), "CON");
    await expect(exportBotBundle({
      home: reserved,
      botId: "CON",
      outputPath: path.join(root, "CON.nbot"),
      sourceVersion: "1",
    })).rejects.toThrow(/unsafe Bot ID/);

    const source = createHome(path.join(root, "source"), "Mover");
    const target = createEmptyTarget(path.join(root, "target"));
    const bundle = path.join(root, "Mover.nbot");
    await exportBotBundle({ home: source, botId: "Mover", outputPath: bundle, includeSecrets: true, sourceVersion: "1" });
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(target, ".bot-transfer-staging"));
    await expect(importBotBundle({ home: target, bundlePath: bundle })).rejects.toThrow(/real directory/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("imports a legacy database that predates session and Worker resume columns", async () => {
    const root = temporaryRoot("niubot-bot-transfer-legacy-db-");
    const source = path.join(root, "source");
    fs.mkdirSync(path.join(source, "Legacy"), { recursive: true });
    fs.writeFileSync(path.join(source, "config.yaml"), yaml.stringify({
      bots: [{ id: "Legacy", backend: "codex", appId: "id", appSecret: "secret" }],
    }), { mode: 0o600 });
    fs.writeFileSync(path.join(source, "Legacy", "bot_profile.md"), "# Legacy\n", { mode: 0o600 });
    const legacy = openRawTestDatabase(path.join(source, "Legacy", "niubot.db"));
    legacy.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY); PRAGMA user_version = 2;");
    legacy.close();
    const target = createEmptyTarget(path.join(root, "target"));
    const bundle = path.join(root, "Legacy.nbot");
    await exportBotBundle({ home: source, botId: "Legacy", outputPath: bundle, includeSecrets: true, sourceVersion: "0.1" });

    await expect(importBotBundle({ home: target, bundlePath: bundle })).resolves.toMatchObject({ botId: "Legacy" });
  });
});

describe("same-device Bot move", () => {
  it("is dry-run by default and moves one Bot with a source recovery copy", async () => {
    const root = temporaryRoot("niubot-bot-move-");
    const source = createHome(path.join(root, "source"), "Mover", { marker: "move-me" });
    const target = createEmptyTarget(path.join(root, "target"));

    const dryRun = await moveBot({
      sourceHome: source,
      targetHome: target,
      botId: "Mover",
      sourceVersion: "1.2.3",
    });
    expect(dryRun.applied).toBe(false);
    expect(readBots(source).map((bot) => bot.id)).toEqual(["Mover"]);
    expect(readBots(target).map((bot) => bot.id)).toEqual(["Existing"]);

    const moved = await moveBot({
      sourceHome: source,
      targetHome: target,
      botId: "Mover",
      sourceVersion: "1.2.3",
      apply: true,
    });
    expect(moved.applied).toBe(true);
    expect(readBots(source)).toEqual([]);
    expect(readBots(target).map((bot) => bot.id)).toEqual(["Existing", "Mover"]);
    expect(fs.existsSync(path.join(source, "Mover", "niubot.db"))).toBe(false);
    expect(fs.existsSync(path.join(moved.recoveryDirectory!, "niubot.db"))).toBe(true);
    const database = openRawTestDatabase(path.join(target, "Mover", "niubot.db"), { readonly: true });
    expect(database.prepare("SELECT value FROM transfer_marker").pluck().get()).toBe("move-me");
    expect(database.prepare("SELECT agent_session_id FROM sessions WHERE id = 's1'").pluck().get())
      .toBe("device-local-session");
    database.close();
    expect(readBots(target).find((bot) => bot.id === "Mover")?.workingDirectory)
      .toBe(path.join(source, "workspace", "Mover"));
  });

  it("restores both homes when source quarantine fails", async () => {
    const root = temporaryRoot("niubot-bot-move-rollback-");
    const source = createHome(path.join(root, "source"), "Mover");
    const target = createEmptyTarget(path.join(root, "target"));
    const sourceConfigBefore = fs.readFileSync(path.join(source, "config.yaml"), "utf-8");
    const targetConfigBefore = fs.readFileSync(path.join(target, "config.yaml"), "utf-8");
    const originalRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from) === path.join(source, "Mover", "niubot.db") && String(to).includes(".bot-move-trash")) {
        throw new Error("injected quarantine failure");
      }
      return originalRename(from, to);
    });

    await expect(moveBot({
      sourceHome: source,
      targetHome: target,
      botId: "Mover",
      sourceVersion: "1.2.3",
      apply: true,
    })).rejects.toThrow(/injected quarantine failure/);

    expect(fs.readFileSync(path.join(source, "config.yaml"), "utf-8")).toBe(sourceConfigBefore);
    expect(fs.readFileSync(path.join(target, "config.yaml"), "utf-8")).toBe(targetConfigBefore);
    expect(fs.existsSync(path.join(source, "Mover", "niubot.db"))).toBe(true);
    expect(fs.existsSync(path.join(target, "Mover"))).toBe(false);
  });

  it("keeps data written at the target when a completed move is rolled back", async () => {
    const root = temporaryRoot("niubot-bot-move-live-rollback-");
    const source = createHome(path.join(root, "source"), "Mover", { marker: "before-move" });
    const target = createEmptyTarget(path.join(root, "target"));
    const moved = await moveBot({
      sourceHome: source,
      targetHome: target,
      botId: "Mover",
      sourceVersion: "1",
      apply: true,
    });
    const targetDatabase = openRawTestDatabase(path.join(target, "Mover", "niubot.db"));
    targetDatabase.prepare("UPDATE transfer_marker SET value = ?").run("written-after-target-start");
    targetDatabase.close();

    await rollbackCompletedMove(moved);

    const restoredDatabase = openRawTestDatabase(path.join(source, "Mover", "niubot.db"), { readonly: true });
    expect(restoredDatabase.prepare("SELECT value FROM transfer_marker").pluck().get())
      .toBe("written-after-target-start");
    restoredDatabase.close();
    expect(readBots(source).map((bot) => bot.id)).toEqual(["Mover"]);
    expect(readBots(target).map((bot) => bot.id)).toEqual(["Existing"]);
  });

  it("includes an uncheckpointed target WAL when rolling a move back", async () => {
    const root = temporaryRoot("niubot-bot-move-wal-rollback-");
    const source = createHome(path.join(root, "source"), "Mover", { marker: "base" });
    const target = createEmptyTarget(path.join(root, "target"));
    const moved = await moveBot({
      sourceHome: source,
      targetHome: target,
      botId: "Mover",
      sourceVersion: "1",
      apply: true,
    });
    const targetDatabase = path.join(target, "Mover", "niubot.db");
    const script = [
      "const Database = require('better-sqlite3');",
      "const db = new Database(process.argv[1]);",
      "db.pragma('journal_mode = WAL');",
      "db.pragma('wal_autocheckpoint = 0');",
      "db.prepare('UPDATE transfer_marker SET value = ?').run('wal-only');",
      "process.kill(process.pid, 'SIGKILL');",
    ].join("");
    spawnSync(process.execPath, ["-e", script, targetDatabase], { cwd: path.resolve(".") });
    expect(fs.existsSync(`${targetDatabase}-wal`)).toBe(true);

    await rollbackCompletedMove(moved);

    const restored = openRawTestDatabase(path.join(source, "Mover", "niubot.db"), { readonly: true });
    expect(restored.prepare("SELECT value FROM transfer_marker").pluck().get()).toBe("wal-only");
    restored.close();
  });

  it("finishes an interrupted move without restoring duplicate credentials", async () => {
    const root = temporaryRoot("niubot-bot-move-recover-");
    const source = createHome(path.join(root, "source"), "Mover");
    const target = createEmptyTarget(path.join(root, "target"));
    const sourceConfigPath = path.join(source, "config.yaml");
    const targetConfigPath = path.join(target, "config.yaml");
    const sourceConfigBefore = fs.readFileSync(sourceConfigPath);
    const targetConfigBefore = fs.readFileSync(targetConfigPath);
    const bundle = path.join(root, "Mover.nbot");
    await exportBotBundle({ home: source, botId: "Mover", outputPath: bundle, includeSecrets: true, sourceVersion: "1" });
    await importBotBundle({ home: target, bundlePath: bundle });
    fs.writeFileSync(sourceConfigPath, yaml.stringify({ bots: [], queue: { bufferMs: 1234 } }), { mode: 0o600 });
    const transaction = path.join(source, ".bot-move-trash", "interrupted");
    fs.mkdirSync(transaction, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(transaction, "source-config.original"), sourceConfigBefore, { mode: 0o600 });
    fs.writeFileSync(path.join(transaction, "target-config.original"), targetConfigBefore, { mode: 0o600 });
    fs.writeFileSync(path.join(transaction, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      kind: "move",
      phase: "target-imported",
      botId: "Mover",
      sourceHome: source,
      targetHome: target,
      sourceConfigPath,
      targetConfigPath,
    }), { mode: 0o600 });

    await expect(moveBot({
      sourceHome: source,
      targetHome: target,
      botId: "Mover",
      sourceVersion: "1",
    })).rejects.toThrow(/unfinished Bot move/);
    expect(readBots(source)).toEqual([]);
    expect(fs.existsSync(path.join(source, "Mover", "niubot.db"))).toBe(true);

    await expect(moveBot({
      sourceHome: source,
      targetHome: target,
      botId: "Mover",
      sourceVersion: "1",
      apply: true,
    })).rejects.toThrow(/interrupted Bot move was recovered/);
    expect(readBots(source)).toEqual([]);
    expect(readBots(target).map((bot) => bot.id)).toEqual(["Existing", "Mover"]);
    expect(fs.existsSync(path.join(source, "Mover", "niubot.db"))).toBe(false);
    expect(fs.existsSync(path.join(transaction, "Mover", "niubot.db"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(transaction, "manifest.json"), "utf-8")).phase).toBe("complete");
  });

  it("continues rollback after one rollback action also fails", async () => {
    const root = temporaryRoot("niubot-bot-move-rollback-errors-");
    const source = createHome(path.join(root, "source"), "Mover");
    const target = createEmptyTarget(path.join(root, "target"));
    const originalRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from) === path.join(source, "Mover", "niubot.db") && String(to).includes(".bot-move-trash")) {
        throw new Error("injected operation failure");
      }
      if (String(from).includes(".restore") && String(to) === path.join(source, "config.yaml")) {
        throw new Error("injected rollback failure");
      }
      return originalRename(from, to);
    });

    await expect(moveBot({
      sourceHome: source,
      targetHome: target,
      botId: "Mover",
      sourceVersion: "1",
      apply: true,
    })).rejects.toThrow(/rollback was incomplete/);
    expect(readBots(target).map((bot) => bot.id)).toEqual(["Existing"]);
    expect(fs.existsSync(path.join(target, "Mover"))).toBe(false);
    expect(fs.existsSync(path.join(source, ".bot-move-trash"))).toBe(true);

    vi.restoreAllMocks();
    await expect(moveBot({
      sourceHome: source,
      targetHome: target,
      botId: "Mover",
      sourceVersion: "1",
      apply: true,
    })).rejects.toThrow(/interrupted Bot move was recovered/);
    expect(readBots(source).map((bot) => bot.id)).toEqual(["Mover"]);
    expect(readBots(target).map((bot) => bot.id)).toEqual(["Existing"]);
    expect(fs.existsSync(path.join(source, ".bot-move-trash"))).toBe(false);
  });
});
