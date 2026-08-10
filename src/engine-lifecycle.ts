import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type { RestartConfig } from "./config.js";
import { loadConfig, writeAutoUpdateEnabledToConfig } from "./config.js";
import type { AutoUpdateConfig } from "./core/auto-update.js";
import { createLogger } from "./logger.js";
import { assertInstallablePackageArchive } from "./package-archive.js";
import { runCommand } from "./platform/command.js";
import { resolveNpmExecutableForNode, withNodeRuntimeOnPath } from "./platform/executable.js";
import { resolveSharedRuntimeRoot } from "./platform/shared-runtime.js";
import { launchRestartWorker, type RestartWorkerLaunch } from "./restart-launcher.js";
import { SharedReleaseStore } from "./shared-release-store.js";
import { resolveUpdateCommandCwd } from "./update-command.js";
import { isNewerPackageVersion, isProductionVersion, runtimeEnvironmentForVersion, type RuntimeEnvironment } from "./version.js";

const UPDATE_PACKAGE_NAME = "@yuanzhangjing/niubot";

export interface EngineStatus {
  version: string;
  environment: string;
  startedAt: string;
  uptimeMs: number;
  runtimePath: string;
}

export interface EngineUpdateStatus {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

export interface EngineRestartRequest {
  botName: string;
  chatId?: string;
  updateVersion?: string;
  autoUpdate?: boolean;
}

export interface EngineRestartResult extends RestartWorkerLaunch {
  sourceDirectory: string;
}

/** Pipeline 只依赖这组 Engine 级能力，不接触 npm、配置文件或 restart worker。 */
export interface EngineLifecycle {
  getStatus(): EngineStatus;
  checkForUpdate(): Promise<EngineUpdateStatus>;
  predownloadUpdate(version: string): Promise<boolean>;
  getAutoUpdateConfig(): AutoUpdateConfig | undefined;
  canPersistAutoUpdate(): boolean;
  setAutoUpdateEnabled(enabled: boolean): void;
  restart(request: EngineRestartRequest): EngineRestartResult;
}

interface EngineLifecycleDependencies {
  runCommand: typeof runCommand;
  launchRestartWorker: typeof launchRestartWorker;
  now: () => Date;
}

export interface EngineLifecycleServiceOptions {
  version: string;
  startedAt: string;
  runtimePath: string;
  niubotHome: string;
  restartConfig?: RestartConfig;
  configPath?: string;
  initialAutoUpdateConfig?: AutoUpdateConfig;
  env?: NodeJS.ProcessEnv;
  onAutoUpdateConfigChanged?: () => void;
  dependencies?: Partial<EngineLifecycleDependencies>;
}

/** 唯一的进程级状态与生命周期动作所有者。 */
export class EngineLifecycleService implements EngineLifecycle {
  private readonly log = createLogger("engine-lifecycle");
  private readonly version: string;
  private readonly environment: RuntimeEnvironment;
  private readonly legacySourceMode: boolean;
  private readonly startedAt: string;
  private readonly startedAtMs: number;
  private readonly runtimePath: string;
  private readonly niubotHome: string;
  private readonly restartConfig?: RestartConfig;
  private readonly configPath?: string;
  private autoUpdateConfig?: AutoUpdateConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly onAutoUpdateConfigChanged?: () => void;
  private readonly dependencies: EngineLifecycleDependencies;

  constructor(options: EngineLifecycleServiceOptions) {
    this.version = options.version;
    this.env = options.env ?? process.env;
    const environment = runtimeEnvironmentForVersion(options.version);
    if (!environment) throw new Error(`Unsupported runtime version: ${options.version}`);
    this.legacySourceMode = environment === "production"
      && (this.env["NIUBOT_LEGACY_SOURCE_MIGRATION"] === "1" || this.env["NIUBOT_ENV"] === "dev")
      && Boolean(options.restartConfig?.sourceDirectory);
    // 迁移期唯一例外：旧 DEV 使用稳定版本号。它在完成一次源码重启前仍必须禁用正式版更新。
    this.environment = this.legacySourceMode ? "dev" : environment;
    this.startedAt = options.startedAt;
    const parsedStartedAt = Date.parse(options.startedAt);
    this.startedAtMs = Number.isFinite(parsedStartedAt) ? parsedStartedAt : Date.now();
    this.runtimePath = options.runtimePath;
    this.niubotHome = options.niubotHome;
    this.restartConfig = options.restartConfig;
    this.configPath = options.configPath;
    this.autoUpdateConfig = options.initialAutoUpdateConfig;
    this.onAutoUpdateConfigChanged = options.onAutoUpdateConfigChanged;
    this.dependencies = {
      runCommand,
      launchRestartWorker,
      now: () => new Date(),
      ...options.dependencies,
    };
  }

  getStatus(): EngineStatus {
    return {
      version: this.version,
      environment: this.environment,
      startedAt: this.startedAt,
      uptimeMs: Math.max(0, this.dependencies.now().getTime() - this.startedAtMs),
      runtimePath: this.runtimePath,
    };
  }

  async checkForUpdate(): Promise<EngineUpdateStatus> {
    this.assertProductionUpdate("检查正式版更新");
    const npmCommand = resolveNpmExecutableForNode(process.execPath) ?? "npm";
    const { stdout } = await this.dependencies.runCommand(
      npmCommand,
      ["view", `${UPDATE_PACKAGE_NAME}@latest`, "version"],
      {
        timeoutMs: 15_000,
        cwd: resolveUpdateCommandCwd(this.niubotHome),
        env: withNodeRuntimeOnPath(process.execPath, this.env),
      },
    );
    const latestVersion = stdout.trim();
    if (!isProductionVersion(latestVersion)) {
      throw new Error(`版本号格式异常：${latestVersion.slice(0, 50)}`);
    }
    return {
      currentVersion: this.version,
      latestVersion,
      updateAvailable: isNewerPackageVersion(latestVersion, this.version),
    };
  }

  async predownloadUpdate(version: string): Promise<boolean> {
    this.assertProductionUpdate("下载正式版更新");
    if (!isProductionVersion(version)) throw new Error(`不是正式版本：${version}`);
    const store = new SharedReleaseStore(resolveSharedRuntimeRoot({ env: this.env }));
    store.ensureDirectories();
    const expected = `yuanzhangjing-niubot-${version}.tgz`;
    const cachedArchive = path.join(store.packagesDirectory, expected);
    if (existsSync(cachedArchive)) {
      try {
        await assertInstallablePackageArchive(cachedArchive);
        return true;
      } catch (err) {
        rmSync(cachedArchive, { force: true });
        this.log.warn("discarded invalid update package cache", { version, file: expected, error: String(err) });
      }
    }

    const downloadDirectory = store.createStagingDirectory("auto-update-package");
    try {
      const npmCommand = resolveNpmExecutableForNode(process.execPath) ?? "npm";
      await this.dependencies.runCommand(
        npmCommand,
        ["pack", `${UPDATE_PACKAGE_NAME}@${version}`, "--pack-destination", downloadDirectory],
        {
          timeoutMs: 120_000,
          cwd: resolveUpdateCommandCwd(this.niubotHome),
          env: withNodeRuntimeOnPath(process.execPath, this.env),
        },
      );
      const downloadedArchive = path.join(downloadDirectory, expected);
      await assertInstallablePackageArchive(downloadedArchive);
      store.publishPackageArchive(downloadedArchive, expected);
    } finally {
      rmSync(downloadDirectory, { recursive: true, force: true });
    }
    return existsSync(path.join(store.packagesDirectory, expected));
  }

  getAutoUpdateConfig(): AutoUpdateConfig | undefined {
    if (!this.configPath) return this.autoUpdateConfig;
    try {
      this.autoUpdateConfig = loadConfig(this.configPath).autoUpdate;
    } catch (err) {
      this.autoUpdateConfig = undefined;
      this.log.warn("failed to read service auto-update config", { error: String(err) });
    }
    return this.autoUpdateConfig;
  }

  canPersistAutoUpdate(): boolean {
    return this.configPath !== undefined;
  }

  setAutoUpdateEnabled(enabled: boolean): void {
    if (!this.configPath) {
      throw new Error("当前服务没有配置文件，无法持久化自动升级开关。");
    }
    writeAutoUpdateEnabledToConfig(this.configPath, enabled);
    this.autoUpdateConfig = loadConfig(this.configPath).autoUpdate;
    try {
      this.onAutoUpdateConfigChanged?.();
    } catch (err) {
      this.log.warn("auto-update config observer failed", { error: String(err) });
    }
  }

  restart(request: EngineRestartRequest): EngineRestartResult {
    if (request.updateVersion) this.assertProductionUpdate("执行正式版更新");
    const sourceDirectory = request.updateVersion || (this.environment === "production" && !this.legacySourceMode)
      ? this.runtimePath
      : (this.restartConfig?.sourceDirectory ?? this.runtimePath);
    const launch = this.dependencies.launchRestartWorker({
      niubotHome: this.niubotHome,
      botName: request.botName,
      runtimeRoot: this.runtimePath,
      sourceDirectory,
      environment: this.environment,
      restartMode: this.legacySourceMode && !request.updateVersion ? "source" : undefined,
      autoUpdate: request.autoUpdate,
      notifyChatId: request.chatId,
      updateVersion: request.updateVersion,
    });
    this.log.info("restart worker launched", {
      pid: launch.pid,
      botName: request.botName,
      chatId: request.chatId,
      sourceDirectory,
      updateVersion: request.updateVersion,
      autoUpdate: request.autoUpdate === true,
      logFile: launch.logFile,
    });
    return { ...launch, sourceDirectory };
  }

  private assertProductionUpdate(action: string): void {
    if (this.environment === "production") return;
    throw new Error(`DEV 运行环境不能${action}；请在源码目录构建后重启。`);
  }
}
