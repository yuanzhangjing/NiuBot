import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import { initDatabase } from "./database/schema.js";
import { EngineAutoUpdateCoordinator } from "./engine-auto-update.js";
import type { UpgradeSafenessSource } from "./core/auto-update.js";
import { loadConfig, writeAutoUpdateEnabledToConfig } from "./config.js";
import { EngineLifecycleService } from "./engine-lifecycle.js";

const dirs: string[] = [];
const databases: Database.Database[] = [];

function idleSource(name = "idle"): UpgradeSafenessSource {
  return {
    name,
    isIdle: () => true,
    describeBlockers: () => "",
  };
}

function busySource(name = "busy"): UpgradeSafenessSource {
  return {
    name,
    isIdle: () => false,
    describeBlockers: () => "任务进行中",
  };
}

function createFixture(enabled: boolean, participants: UpgradeSafenessSource[][] = [[idleSource()]]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-engine-auto-update-"));
  dirs.push(dir);
  const dbPath = path.join(dir, "NiuBot", "niubot.db");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = initDatabase(dbPath);
  databases.push(db);
  db.prepare(`
    INSERT INTO users (id, name, platform, platform_id, is_admin)
    VALUES ('u2', 'admin', 'feishu', 'user-open-id', 'owner')
  `).run();
  db.prepare(`
    INSERT INTO chats (id, type, platform, platform_id, user_id)
    VALUES ('c1', 'p2p', 'feishu', 'chat-open-id', 'user-open-id')
  `).run();
  const configPath = path.join(dir, "config.yaml");
  writeFileSync(configPath, [
    "bots:",
    "  - id: NiuBot",
    "    appId: app-id",
    "    appSecret: app-secret",
    `    workingDirectory: ${JSON.stringify(dir)}`,
    `autoUpdate: ${enabled}`,
    "",
  ].join("\n"));
  const cards: Array<{ chatId: string; header: string; content: string }> = [];
  const lifecycle = new EngineLifecycleService({
    version: "1.0.0",
    startedAt: new Date().toISOString(),
    runtimePath: dir,
    niubotHome: dir,
    configPath,
    initialAutoUpdateConfig: enabled ? {
      enabled: true,
      windowStartHour: 2,
      windowEndHour: 5,
      timezone: "Asia/Shanghai",
      marginMinutes: 10,
      notifyOnResult: true,
    } : undefined,
    dependencies: {
      runCommand: async () => ({ stdout: "1.0.0\n", stderr: "" }),
      launchRestartWorker: () => ({ pid: 123, logFile: path.join(dir, "restart.log") }),
    },
  });
  const coordinator = new EngineAutoUpdateCoordinator({
    lifecycle,
    participants: participants.map((sources) => ({
      getUpgradeSafenessSources: () => sources,
    })),
    notificationTarget: {
      id: "NiuBot",
      db,
      dbPath,
      platform: "feishu",
      transport: {
        sendCard: async (chatId, header, content) => {
          cards.push({ chatId, header, content });
          return `pm-${cards.length}`;
        },
      },
    },
  });
  return { coordinator, lifecycle, configPath, db, dbPath, cards, dir };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) {
    if (db.open) db.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("EngineAutoUpdateCoordinator", () => {
  test("owns the daily timer and does not check at Engine startup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 25, 10, 0, 0));
    const { coordinator } = createFixture(false);
    let checks = 0;
    (coordinator as any).runDailyCheck = async () => { checks++; };

    coordinator.start();
    expect(checks).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 - 1);
    expect(checks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(checks).toBe(1);
    coordinator.stop();
  });

  test("sends proactive version notifications only through the configured first Bot", async () => {
    const { coordinator, cards } = createFixture(false);
    (coordinator as any).fetchLatestVersion = async () => "1.1.0";
    coordinator.start();

    await coordinator.runDailyCheck();
    await coordinator.runDailyCheck();

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ chatId: "chat-open-id", header: "Update" });
    expect(cards[0]?.content).toContain("1.0.0 → 1.1.0");
    coordinator.stop();
  });

  test("checks every Bot in the Engine before automatic upgrade", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T19:00:00Z"));
    const { coordinator, lifecycle } = createFixture(true, [[idleSource("bot-1")], [busySource("bot-2")]]);
    (coordinator as any).fetchLatestVersion = async () => "1.1.0";
    lifecycle.predownloadUpdate = async () => true;
    let restarted = false;
    (coordinator as any).triggerRestart = () => { restarted = true; };

    coordinator.start();
    await (coordinator as any).requestAutoUpgradeCheck();

    expect(restarted).toBe(false);
    coordinator.stop();
  });

  test("automatically upgrades once when all Engine participants are idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T19:00:00Z"));
    const { coordinator, lifecycle } = createFixture(true, [[idleSource("bot-1")], [idleSource("bot-2")]]);
    (coordinator as any).fetchLatestVersion = async () => "1.1.0";
    lifecycle.predownloadUpdate = async () => true;
    const restart = vi.fn(() => ({ pid: 123, logFile: "restart.log", sourceDirectory: "runtime" }));
    lifecycle.restart = restart;

    coordinator.start();
    await (coordinator as any).requestAutoUpgradeCheck();

    expect(restart).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledWith({
      botName: "NiuBot",
      autoUpdate: true,
      updateVersion: "1.1.0",
    });
    coordinator.stop();
  });

  test("does not upgrade outside the configured window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T10:00:00Z"));
    const { coordinator, lifecycle } = createFixture(true);
    (coordinator as any).fetchLatestVersion = async () => "1.1.0";
    let downloads = 0;
    let restarts = 0;
    lifecycle.predownloadUpdate = async () => { downloads++; return true; };
    (coordinator as any).triggerRestart = () => { restarts++; };

    coordinator.start();
    await (coordinator as any).requestAutoUpgradeCheck();

    expect(downloads).toBe(0);
    expect(restarts).toBe(0);
    coordinator.stop();
  });

  test("fetches npm latest only once per day for automatic checks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T10:00:00Z"));
    const { coordinator, lifecycle } = createFixture(true);
    let fetches = 0;
    (coordinator as any).fetchLatestVersion = async () => { fetches++; return "1.0.0"; };

    coordinator.start();
    await (coordinator as any).requestAutoUpgradeCheck();
    await (coordinator as any).requestAutoUpgradeCheck();

    expect(fetches).toBe(1);
    coordinator.stop();
  });

  test("does not automatically upgrade to a prerelease target", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T19:00:00Z"));
    const { coordinator, lifecycle } = createFixture(true);
    (coordinator as any).fetchLatestVersion = async () => "1.1.0-beta.1";
    let downloads = 0;
    let restarts = 0;
    lifecycle.predownloadUpdate = async () => { downloads++; return true; };
    (coordinator as any).triggerRestart = () => { restarts++; };

    coordinator.start();
    await (coordinator as any).requestAutoUpgradeCheck();

    expect(downloads).toBe(0);
    expect(restarts).toBe(0);
    coordinator.stop();
  });

  test("reacts immediately when any Bot enables the shared setting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T19:00:00Z"));
    const { coordinator, configPath } = createFixture(false);
    let checks = 0;
    (coordinator as any).runAutoUpgradeCheck = async () => { checks++; };
    coordinator.start();
    expect(checks).toBe(0);

    writeAutoUpdateEnabledToConfig(configPath, true);
    coordinator.configChanged();
    await Promise.resolve();

    expect(checks).toBe(1);
    coordinator.stop();
  });

  test("does not restart if auto-update is disabled during an in-flight download", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T19:00:00Z"));
    const { coordinator, lifecycle, configPath } = createFixture(true);
    (coordinator as any).fetchLatestVersion = async () => "1.1.0";
    let finishDownload!: () => void;
    lifecycle.predownloadUpdate = () => new Promise<boolean>((resolve) => {
      finishDownload = () => resolve(true);
    });
    let restarted = false;
    (coordinator as any).triggerRestart = () => { restarted = true; };
    coordinator.start();
    await vi.waitFor(() => expect(finishDownload).toBeTypeOf("function"));

    writeAutoUpdateEnabledToConfig(configPath, false);
    coordinator.configChanged();
    finishDownload();
    await Promise.resolve();
    await Promise.resolve();

    expect(restarted).toBe(false);
    coordinator.stop();
  });

  test("fails closed when the service config becomes unreadable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T19:00:00Z"));
    const { coordinator, configPath } = createFixture(true);
    let fetches = 0;
    (coordinator as any).fetchLatestVersion = async () => { fetches++; return "1.1.0"; };
    writeFileSync(configPath, "[invalid");

    coordinator.start();
    await coordinator.runAutoUpgradeCheck();

    expect(fetches).toBe(0);
    coordinator.stop();
  });

  test("migrates the legacy first-Bot DB setting once at Engine startup", () => {
    vi.useFakeTimers();
    const { coordinator, configPath, db } = createFixture(true);
    db.prepare("INSERT INTO settings (key, value) VALUES ('auto_update_enabled', '0')").run();

    coordinator.start();

    expect(loadConfig(configPath).autoUpdate).toBeUndefined();
    expect(db.prepare("SELECT value FROM settings WHERE key = 'auto_update_enabled'").get()).toBeUndefined();
    coordinator.stop();
  });

  test("reports a successful automatic upgrade during the daytime check", async () => {
    const { coordinator, dbPath, cards } = createFixture(true);
    const restartDir = path.join(path.dirname(dbPath), "restart");
    mkdirSync(restartDir, { recursive: true });
    writeFileSync(path.join(restartDir, "state.json"), JSON.stringify({
      id: "r1",
      phase: "success",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      autoUpdate: true,
    }));
    (coordinator as any).fetchLatestVersion = async () => "1.0.0";
    coordinator.start();

    await coordinator.runDailyCheck();
    await coordinator.runDailyCheck();

    expect(cards.filter((card) => card.content.includes("已自动升级"))).toHaveLength(1);
    coordinator.stop();
  });

  test("does not report a manual restart as an automatic upgrade", async () => {
    const { coordinator, dbPath, cards } = createFixture(true);
    const restartDir = path.join(path.dirname(dbPath), "restart");
    mkdirSync(restartDir, { recursive: true });
    writeFileSync(path.join(restartDir, "state.json"), JSON.stringify({
      id: "r1",
      phase: "success",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      autoUpdate: false,
    }));
    (coordinator as any).fetchLatestVersion = async () => "1.0.0";
    coordinator.start();

    await coordinator.runDailyCheck();

    expect(cards).toHaveLength(0);
    coordinator.stop();
  });

  test("does not send result cards from the nighttime automatic loop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T19:00:00Z"));
    const { coordinator, lifecycle, dbPath, cards } = createFixture(true, [[busySource()]]);
    const restartDir = path.join(path.dirname(dbPath), "restart");
    mkdirSync(restartDir, { recursive: true });
    writeFileSync(path.join(restartDir, "state.json"), JSON.stringify({
      id: "r1",
      phase: "success",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      autoUpdate: true,
    }));
    (coordinator as any).fetchLatestVersion = async () => "1.1.0";
    lifecycle.predownloadUpdate = async () => true;
    coordinator.start();

    await (coordinator as any).requestAutoUpgradeCheck();

    expect(cards).toHaveLength(0);
    coordinator.stop();
  });

  test("stop prevents a completed daily check from scheduling another timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 25, 9, 59, 0));
    const { coordinator } = createFixture(false);
    let finish!: () => void;
    let checks = 0;
    (coordinator as any).runDailyCheck = () => {
      checks++;
      return new Promise<void>((resolve) => { finish = resolve; });
    };
    coordinator.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checks).toBe(1);

    coordinator.stop();
    finish();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    expect(checks).toBe(1);
  });
});
