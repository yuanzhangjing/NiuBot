import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "./config.js";
import { EngineLifecycleService } from "./engine-lifecycle.js";
import { KeepAwakeController } from "./platform/keep-awake.js";

const directories: string[] = [];

function createDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "niubot-engine-lifecycle-"));
  directories.push(directory);
  return directory;
}

function writeConfig(directory: string, enabled: boolean): string {
  const configPath = path.join(directory, "config.yaml");
  writeFileSync(configPath, [
    "bots:",
    "  - id: NiuBot",
    "    appId: app-id",
    "    appSecret: app-secret",
    `    workingDirectory: ${JSON.stringify(directory)}`,
    `autoUpdate: ${enabled}`,
    "",
  ].join("\n"));
  return configPath;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("EngineLifecycleService", () => {
  test("reports Engine-owned version, environment, runtime and uptime", () => {
    const directory = createDirectory();
    const lifecycle = new EngineLifecycleService({
      version: "1.2.3-dev.1",
      startedAt: "2026-08-10T00:00:00.000Z",
      runtimePath: path.join(directory, "runtime"),
      niubotHome: directory,
      env: { NIUBOT_ENV: "dev" },
      dependencies: { now: () => new Date("2026-08-10T00:02:03.000Z") },
    });

    expect(lifecycle.getStatus()).toEqual({
      version: "1.2.3-dev.1",
      environment: "dev",
      startedAt: "2026-08-10T00:00:00.000Z",
      uptimeMs: 123_000,
      runtimePath: path.join(directory, "runtime"),
    });
  });

  test("checks npm latest through a bounded Engine-level command", async () => {
    const directory = createDirectory();
    const runCommand = vi.fn(async () => ({ stdout: "1.3.0\n", stderr: "" }));
    const lifecycle = new EngineLifecycleService({
      version: "1.2.3",
      startedAt: new Date().toISOString(),
      runtimePath: directory,
      niubotHome: directory,
      dependencies: { runCommand },
    });

    await expect(lifecycle.checkForUpdate()).resolves.toEqual({
      currentVersion: "1.2.3",
      latestVersion: "1.3.0",
      updateAvailable: true,
    });
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand.mock.calls[0]?.[1]).toEqual([
      "view",
      "@yuanzhangjing/niubot@latest",
      "version",
    ]);
    expect(runCommand.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 15_000, cwd: directory });
  });

  test("rejects an invalid registry version", async () => {
    const directory = createDirectory();
    const lifecycle = new EngineLifecycleService({
      version: "1.2.3",
      startedAt: new Date().toISOString(),
      runtimePath: directory,
      niubotHome: directory,
      dependencies: { runCommand: async () => ({ stdout: "latest\n", stderr: "" }) },
    });

    await expect(lifecycle.checkForUpdate()).rejects.toThrow("版本号格式异常");
  });

  test("rejects production update operations for a DEV runtime", async () => {
    const directory = createDirectory();
    const lifecycle = new EngineLifecycleService({
      version: "1.2.3-dev.4",
      startedAt: new Date().toISOString(),
      runtimePath: directory,
      niubotHome: directory,
    });

    await expect(lifecycle.checkForUpdate()).rejects.toThrow("DEV 运行环境");
    await expect(lifecycle.predownloadUpdate("1.3.0")).rejects.toThrow("DEV 运行环境");
    expect(() => lifecycle.restart({ botName: "NiuBot", updateVersion: "1.3.0" })).toThrow("DEV 运行环境");
  });

  test("treats a legacy stable-version source runtime as DEV until its one-time migration", async () => {
    const directory = createDirectory();
    const sourceDirectory = path.join(directory, "source");
    const launchRestartWorker = vi.fn(() => ({ pid: 321, logFile: path.join(directory, "restart.log") }));
    const lifecycle = new EngineLifecycleService({
      version: "1.2.3",
      startedAt: new Date().toISOString(),
      runtimePath: path.join(directory, "runtime"),
      niubotHome: directory,
      restartConfig: { sourceDirectory },
      env: { NIUBOT_LEGACY_SOURCE_MIGRATION: "1" },
      dependencies: { launchRestartWorker },
    });

    expect(lifecycle.getStatus().environment).toBe("dev");
    await expect(lifecycle.checkForUpdate()).rejects.toThrow("DEV 运行环境");
    lifecycle.restart({ botName: "NiuBot" });
    expect(launchRestartWorker).toHaveBeenCalledWith(expect.objectContaining({
      sourceDirectory,
      restartMode: "source",
      environment: "dev",
    }));
  });

  test("owns the shared auto-update config and notifies observers after persistence", () => {
    const directory = createDirectory();
    const configPath = writeConfig(directory, false);
    const changed = vi.fn();
    const lifecycle = new EngineLifecycleService({
      version: "1.2.3-dev.1",
      startedAt: new Date().toISOString(),
      runtimePath: directory,
      niubotHome: directory,
      configPath,
      onAutoUpdateConfigChanged: changed,
    });

    lifecycle.setAutoUpdateEnabled(true);
    expect(loadConfig(configPath).autoUpdate?.enabled).toBe(true);
    expect(lifecycle.getAutoUpdateConfig()?.enabled).toBe(true);
    expect(changed).toHaveBeenCalledOnce();

    writeFileSync(configPath, "[invalid");
    expect(lifecycle.getAutoUpdateConfig()).toBeUndefined();
    expect(readFileSync(configPath, "utf-8")).toBe("[invalid");
  });

  test("refuses config writes when the Engine has no service config", () => {
    const directory = createDirectory();
    const lifecycle = new EngineLifecycleService({
      version: "1.2.3",
      startedAt: new Date().toISOString(),
      runtimePath: directory,
      niubotHome: directory,
    });

    expect(lifecycle.canPersistAutoUpdate()).toBe(false);
    expect(() => lifecycle.setAutoUpdateEnabled(true)).toThrow("当前服务没有配置文件");
  });

  test("persists keep-awake on/off to the service config", async () => {
    const directory = createDirectory();
    const configPath = writeConfig(directory, false);
    const lifecycle = new EngineLifecycleService({
      version: "1.2.3",
      startedAt: new Date().toISOString(),
      runtimePath: directory,
      niubotHome: directory,
      configPath,
    });
    const setEnabled = vi.spyOn(KeepAwakeController.prototype, "setEnabled").mockResolvedValue({
      supported: true,
      enabled: true,
      platform: process.platform as NodeJS.Platform,
      method: "caffeinate",
    });

    await lifecycle.setKeepAwakeEnabled(true);
    expect(loadConfig(configPath).keepAwake).toBe(true);

    setEnabled.mockResolvedValue({
      supported: true,
      enabled: false,
      platform: process.platform as NodeJS.Platform,
      method: "caffeinate",
    });
    await lifecycle.setKeepAwakeEnabled(false);
    expect(loadConfig(configPath).keepAwake).toBe(false);
  });

  test("does not persist keep-awake when persist is disabled (shutdown path)", async () => {
    const directory = createDirectory();
    const configPath = writeConfig(directory, false);
    const lifecycle = new EngineLifecycleService({
      version: "1.2.3",
      startedAt: new Date().toISOString(),
      runtimePath: directory,
      niubotHome: directory,
      configPath,
    });
    vi.spyOn(KeepAwakeController.prototype, "setEnabled").mockResolvedValue({
      supported: true,
      enabled: false,
      platform: process.platform as NodeJS.Platform,
      method: "caffeinate",
    });

    await lifecycle.setKeepAwakeEnabled(false, { persist: false });
    expect(loadConfig(configPath).keepAwake).toBeUndefined();
  });

  test("restores persisted keep-awake on Engine startup and skips when disabled", async () => {
    const directory = createDirectory();
    const configPath = writeConfig(directory, false);
    writeFileSync(configPath, readFileSync(configPath, "utf-8") + "keepAwake: true\n");
    const lifecycle = new EngineLifecycleService({
      version: "1.2.3",
      startedAt: new Date().toISOString(),
      runtimePath: directory,
      niubotHome: directory,
      configPath,
    });
    const setEnabled = vi.spyOn(KeepAwakeController.prototype, "setEnabled").mockResolvedValue({
      supported: true,
      enabled: true,
      platform: process.platform as NodeJS.Platform,
      method: "caffeinate",
    });

    await lifecycle.restoreKeepAwakeFromConfig();
    expect(setEnabled).toHaveBeenCalledWith(true);

    // keepAwake: false → 不恢复
    setEnabled.mockClear();
    writeFileSync(configPath, [
      "bots:",
      "  - id: NiuBot",
      "    appId: app-id",
      "    appSecret: app-secret",
      `    workingDirectory: ${JSON.stringify(directory)}`,
      "keepAwake: false",
      "",
    ].join("\n"));
    await lifecycle.restoreKeepAwakeFromConfig();
    expect(setEnabled).not.toHaveBeenCalled();
  });

  test("selects the restart source at Engine level and forwards the notifying Bot", () => {
    const directory = createDirectory();
    const runtimePath = path.join(directory, "runtime");
    const sourceDirectory = path.join(directory, "source");
    const launchRestartWorker = vi.fn(() => ({ pid: 321, logFile: path.join(directory, "restart.log") }));
    const lifecycle = new EngineLifecycleService({
      version: "1.2.3-dev.1",
      startedAt: new Date().toISOString(),
      runtimePath,
      niubotHome: directory,
      restartConfig: { sourceDirectory },
      env: { NIUBOT_ENV: "dev" },
      dependencies: { launchRestartWorker },
    });

    expect(lifecycle.restart({
      botName: "ConanBot",
      chatId: "c1",
      scopeKey: "c1#omt_aaa",
      threadId: "omt_aaa",
      wakeReplyTo: "om-root",
    }).sourceDirectory).toBe(sourceDirectory);
    expect(() => lifecycle.restart({ botName: "ConanBot", updateVersion: "1.3.0" })).toThrow("DEV 运行环境");
    expect(launchRestartWorker.mock.calls[0]?.[0]).toMatchObject({
      botName: "ConanBot",
      notifyChatId: "c1",
      notifyScopeKey: "c1#omt_aaa",
      notifyThreadId: "omt_aaa",
      wakeReplyTo: "om-root",
      sourceDirectory,
    });
    expect(launchRestartWorker).toHaveBeenCalledOnce();
  });
});
