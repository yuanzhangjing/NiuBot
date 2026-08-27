import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { closeTestDatabases, openTestDatabase } from "../test-utils/database.js";
import { EngineAutoUpdateCoordinator } from "./engine-auto-update.js";
import type { UpgradeSafenessSource } from "./core/auto-update.js";
import { loadConfig, writeAutoUpdateEnabledToConfig } from "./config.js";
import { EngineLifecycleService } from "./engine-lifecycle.js";

const dirs: string[] = [];

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
  const db = openTestDatabase(dbPath);
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
  closeTestDatabases();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("EngineAutoUpdateCoordinator", () => {
  test("owns the daily timer and does not check at Engine startup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T02:00:00Z")); // 10:00 Asia/Shanghai
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T02:00:00Z")); // Monday 10:00 Asia/Shanghai
    const { coordinator, cards } = createFixture(false);
    (coordinator as any).fetchLatestVersion = async () => "1.1.0";
    coordinator.start();

    await coordinator.runDailyCheck();
    await coordinator.runDailyCheck();

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ chatId: "chat-open-id", header: "更新|orange" });
    expect(cards[0]?.content).toContain("1.0.0 → 1.1.0");
    coordinator.stop();
  });

  test("does not check or notify while a legacy stable-version source runtime is marked DEV", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T02:00:00Z"));
    const { coordinator, lifecycle, cards } = createFixture(false);
    const status = lifecycle.getStatus();
    vi.spyOn(lifecycle, "getStatus").mockReturnValue({ ...status, environment: "dev" });
    const fetchLatest = vi.fn(async () => "1.1.0");
    (coordinator as any).fetchLatestVersion = fetchLatest;
    coordinator.start();

    await coordinator.runDailyCheck();

    expect(fetchLatest).not.toHaveBeenCalled();
    expect(cards).toHaveLength(0);
    coordinator.stop();
  });

  test("checks for manual update reminders only on Monday at the daytime timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T02:00:00Z")); // Tuesday 10:00 Asia/Shanghai
    const { coordinator, cards } = createFixture(false);
    let fetches = 0;
    (coordinator as any).fetchLatestVersion = async () => { fetches++; return "1.1.0"; };
    coordinator.start();

    await coordinator.runDailyCheck();
    expect(fetches).toBe(0);
    expect(cards).toHaveLength(0);

    vi.setSystemTime(new Date("2026-08-17T02:00:00Z")); // Monday 10:00 Asia/Shanghai
    await coordinator.runDailyCheck();
    expect(fetches).toBe(1);
    expect(cards).toHaveLength(1);
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
    let fetches = 0;
    (coordinator as any).fetchLatestVersion = async () => { fetches++; return "1.1.0"; };
    let downloads = 0;
    let restarts = 0;
    lifecycle.predownloadUpdate = async () => { downloads++; return true; };
    (coordinator as any).triggerRestart = () => { restarts++; };

    coordinator.start();
    await (coordinator as any).requestAutoUpgradeCheck();

    expect(fetches).toBe(0);
    expect(downloads).toBe(0);
    expect(restarts).toBe(0);
    coordinator.stop();
  });

  test("queries npm only once per successful upgrade window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T18:00:00Z"));
    const { coordinator, lifecycle } = createFixture(true);
    let fetches = 0;
    let latest = "1.0.0";
    (coordinator as any).fetchLatestVersion = async () => { fetches++; return latest; };
    lifecycle.predownloadUpdate = async () => true;
    const restart = vi.fn(() => ({ pid: 123, logFile: "restart.log", sourceDirectory: "runtime" }));
    lifecycle.restart = restart;

    coordinator.start();
    await (coordinator as any).requestAutoUpgradeCheck();
    expect(fetches).toBe(1);
    expect(restart).not.toHaveBeenCalled();

    latest = "1.1.0";
    vi.setSystemTime(new Date("2026-08-07T18:30:00Z"));
    await (coordinator as any).requestAutoUpgradeCheck();

    expect(fetches).toBe(1);
    expect(restart).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-08-08T18:00:00Z"));
    await (coordinator as any).requestAutoUpgradeCheck();

    expect(fetches).toBe(2);
    expect(restart).toHaveBeenCalledOnce();
    coordinator.stop();
  });

  test("aligns the first automatic query to 02:00 in the configured timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T17:59:59Z"));
    const { coordinator } = createFixture(true);
    let fetches = 0;
    (coordinator as any).fetchLatestVersion = async () => { fetches++; return "1.0.0"; };

    coordinator.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetches).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetches).toBe(1);
    coordinator.stop();
  });

  test("does not backfill when the Engine starts inside the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T19:00:00Z"));
    const { coordinator } = createFixture(true);
    let fetches = 0;
    (coordinator as any).fetchLatestVersion = async () => { fetches++; return "1.0.0"; };

    coordinator.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toBe(0);

    await vi.advanceTimersByTimeAsync(23 * 60 * 60_000 - 1);
    expect(fetches).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetches).toBe(1);
    coordinator.stop();
  });

  test("retries a failed npm query inside the same window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T17:59:59Z"));
    const { coordinator } = createFixture(true);
    let fetches = 0;
    (coordinator as any).fetchLatestVersion = async () => {
      fetches++;
      if (fetches === 1) throw new Error("temporary network failure");
      return "1.0.0";
    };

    coordinator.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetches).toBe(1);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(fetches).toBe(2);
    coordinator.stop();
  });

  test("does not retry when the running version cannot be auto-upgraded", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T17:59:59Z"));
    const { coordinator, lifecycle } = createFixture(true);
    const status = lifecycle.getStatus();
    vi.spyOn(lifecycle, "getStatus").mockReturnValue({ ...status, version: "1.0.0-dev" });
    const checks = vi.spyOn(coordinator, "runAutoUpgradeCheck");
    let fetches = 0;
    (coordinator as any).fetchLatestVersion = async () => { fetches++; return "1.1.0"; };

    coordinator.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(checks).toHaveBeenCalledOnce();
    expect(fetches).toBe(0);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(checks).toHaveBeenCalledOnce();
    expect(fetches).toBe(0);
    coordinator.stop();
  });

  test("caches a discovered update while waiting for the Engine to become idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T18:00:00Z"));
    const source = busySource();
    const { coordinator, lifecycle } = createFixture(true, [[source]]);
    let fetches = 0;
    (coordinator as any).fetchLatestVersion = async () => { fetches++; return "1.1.0"; };
    lifecycle.predownloadUpdate = async () => true;

    coordinator.start();
    await (coordinator as any).requestAutoUpgradeCheck();
    await (coordinator as any).requestAutoUpgradeCheck();

    expect(fetches).toBe(1);
    coordinator.stop();
  });

  test("retries only safeness while busy without querying npm again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T17:59:59Z"));
    let busy = true;
    const source: UpgradeSafenessSource = {
      name: "mutable",
      isIdle: () => !busy,
      describeBlockers: () => (busy ? "任务进行中" : ""),
    };
    const { coordinator, lifecycle } = createFixture(true, [[source]]);
    let fetches = 0;
    (coordinator as any).fetchLatestVersion = async () => { fetches++; return "1.1.0"; };
    lifecycle.predownloadUpdate = async () => true;
    const restart = vi.fn(() => ({ pid: 123, logFile: "restart.log", sourceDirectory: "runtime" }));
    lifecycle.restart = restart;

    coordinator.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(fetches).toBe(1);
    expect(restart).not.toHaveBeenCalled();

    busy = false;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(fetches).toBe(1);
    expect(restart).toHaveBeenCalledOnce();
    coordinator.stop();
  });

  test("stops retrying when another path has already activated the cached version", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T17:59:59Z"));
    const { coordinator, lifecycle } = createFixture(true, [[busySource()]]);
    const initialStatus = lifecycle.getStatus();
    const getStatus = vi.spyOn(lifecycle, "getStatus");
    getStatus.mockReturnValue(initialStatus);
    (coordinator as any).fetchLatestVersion = async () => "1.1.0";
    lifecycle.predownloadUpdate = async () => true;
    const checks = vi.spyOn(coordinator, "runAutoUpgradeCheck");

    coordinator.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(checks).toHaveBeenCalledOnce();

    getStatus.mockReturnValue({ ...initialStatus, version: "1.1.0" });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(checks).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(checks).toHaveBeenCalledTimes(2);
    coordinator.stop();
  });

  test("stops busy retries when the remaining window reaches the margin", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T17:59:59Z"));
    const { coordinator, lifecycle } = createFixture(true, [[busySource()]]);
    (coordinator as any).fetchLatestVersion = async () => "1.1.0";
    let downloads = 0;
    lifecycle.predownloadUpdate = async () => { downloads++; return true; };

    coordinator.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2.5 * 60 * 60_000);
    expect(downloads).toBe(6);

    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(downloads).toBe(6);
    coordinator.stop();
  });

  test("treats both sides of a cross-midnight window as one query window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T15:00:00Z"));
    const { coordinator, lifecycle } = createFixture(true, [[busySource()]]);
    lifecycle.getAutoUpdateConfig = () => ({
      enabled: true,
      windowStartHour: 22,
      windowEndHour: 2,
      timezone: "Asia/Shanghai",
      marginMinutes: 10,
      notifyOnResult: true,
    });
    let fetches = 0;
    (coordinator as any).fetchLatestVersion = async () => { fetches++; return "1.1.0"; };
    lifecycle.predownloadUpdate = async () => true;

    coordinator.start();
    await (coordinator as any).requestAutoUpgradeCheck();
    vi.setSystemTime(new Date("2026-08-07T17:00:00Z"));
    await (coordinator as any).requestAutoUpgradeCheck();
    expect(fetches).toBe(1);

    vi.setSystemTime(new Date("2026-08-08T14:00:00Z"));
    await (coordinator as any).requestAutoUpgradeCheck();
    expect(fetches).toBe(2);
    coordinator.stop();
  });

  test("does not automatically upgrade to a prerelease target", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T19:00:00Z"));
    const { coordinator, lifecycle } = createFixture(true);
    let fetches = 0;
    (coordinator as any).fetchLatestVersion = async () => { fetches++; return "1.1.0-beta.1"; };
    let downloads = 0;
    let restarts = 0;
    lifecycle.predownloadUpdate = async () => { downloads++; return true; };
    (coordinator as any).triggerRestart = () => { restarts++; };

    coordinator.start();
    await (coordinator as any).requestAutoUpgradeCheck();
    await (coordinator as any).requestAutoUpgradeCheck();

    expect(fetches).toBe(1);
    expect(downloads).toBe(0);
    expect(restarts).toBe(0);
    coordinator.stop();
  });

  test("waits for the next window when enabled inside the current window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T19:00:00Z"));
    const { coordinator, configPath } = createFixture(false);
    let checks = 0;
    (coordinator as any).runAutoUpgradeCheck = async () => { checks++; };
    coordinator.start();
    expect(checks).toBe(0);

    writeAutoUpdateEnabledToConfig(configPath, true);
    coordinator.configChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(checks).toBe(0);

    await vi.advanceTimersByTimeAsync(23 * 60 * 60_000);
    expect(checks).toBe(1);
    coordinator.stop();
  });

  test("cancels and rebuilds the window timer when the shared setting changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T17:59:00Z"));
    const { coordinator, configPath } = createFixture(true);
    let fetches = 0;
    (coordinator as any).fetchLatestVersion = async () => { fetches++; return "1.0.0"; };
    coordinator.start();

    writeAutoUpdateEnabledToConfig(configPath, false);
    coordinator.configChanged();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetches).toBe(0);

    writeAutoUpdateEnabledToConfig(configPath, true);
    coordinator.configChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetches).toBe(0);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(fetches).toBe(1);
    coordinator.stop();
  });

  test("does not restart if auto-update is disabled during an in-flight download", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T17:59:59Z"));
    const { coordinator, lifecycle, configPath } = createFixture(true);
    (coordinator as any).fetchLatestVersion = async () => "1.1.0";
    let finishDownload!: () => void;
    lifecycle.predownloadUpdate = () => new Promise<boolean>((resolve) => {
      finishDownload = () => resolve(true);
    });
    let restarted = false;
    (coordinator as any).triggerRestart = () => { restarted = true; };
    coordinator.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(finishDownload).toBeTypeOf("function"));

    writeAutoUpdateEnabledToConfig(configPath, false);
    coordinator.configChanged();
    finishDownload();
    await Promise.resolve();
    await Promise.resolve();

    expect(restarted).toBe(false);
    coordinator.stop();
  });

  test("does not let a check from an earlier start generation trigger restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T18:00:00Z"));
    const { coordinator, lifecycle } = createFixture(true);
    let finishFetch!: () => void;
    (coordinator as any).fetchLatestVersion = () => new Promise<string>((resolve) => {
      finishFetch = () => resolve("1.1.0");
    });
    let downloads = 0;
    let restarts = 0;
    lifecycle.predownloadUpdate = async () => { downloads++; return true; };
    (coordinator as any).triggerRestart = () => { restarts++; };

    coordinator.start();
    const staleCheck = (coordinator as any).requestAutoUpgradeCheck();
    await vi.waitFor(() => expect(finishFetch).toBeTypeOf("function"));
    coordinator.stop();
    coordinator.start();
    finishFetch();
    await staleCheck;

    expect(downloads).toBe(0);
    expect(restarts).toBe(0);
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

  test("does not query npm during the daytime check when automatic upgrade is enabled", async () => {
    const { coordinator } = createFixture(true);
    let fetches = 0;
    (coordinator as any).fetchLatestVersion = async () => { fetches++; return "1.1.0"; };
    coordinator.start();

    await coordinator.runDailyCheck();

    expect(fetches).toBe(0);
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
    vi.setSystemTime(new Date("2026-04-25T01:59:00Z")); // 09:59 Asia/Shanghai
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
