import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  NIUBOT_HOME,
  BUILTIN_BACKEND_LIST,
  type NiuBotConfig,
} from "./config.js";
import type { AgentBackend } from "./agent/types.js";
import type { CliAgentBackend } from "./agent/cli-base.js";
import { createBotInstance, type BotInstance } from "./bot-instance.js";
import {
  LATEST_SCHEMA_VERSION,
  ROLLBACK_COMPATIBLE_SCHEMA_VERSIONS,
  loadPersistedBotRuntimeState,
} from "./database/schema.js";
import { createLogger, setLogLevel } from "./logger.js";
import { ensureRuntimeCliShims, prependNiubotBinToPath } from "./platform/cli-runtime.js";
import { summarizeProxyEnvironment } from "./proxy-env.js";
import { resolveBotRuntimeConfig } from "./runtime-config.js";
import { startBotRuntime } from "./bot-startup.js";
import { resolveEngineEndpoint, resolvePreflightEndpoint } from "./platform/ipc.js";
import { probeAllBackendCapabilitiesAsync, probeBackendCapabilityAsync } from "./agent/backend-capability.js";
import { BackendCapabilityCache } from "./agent/backend-capability-cache.js";
import { normalizeBackend } from "./config.js";
import { EngineControlServer, type EngineIdentity } from "./local-api/engine-server.js";
import { clearProcessState, readProcessState, writeProcessState } from "./process-state.js";
import { queryProcessStartMarker } from "./platform/process.js";
import { samePlatformPath } from "./platform/files.js";
import { resolveInFlightShutdownTimeoutMs } from "./lifecycle-timeouts.js";
import {
  applyPreflightDatabaseManifest,
  assertDatabasesAtCompatibleSchemaVersion,
  PREFLIGHT_DATABASE_MANIFEST_ENV,
  shouldRunFullPreflight,
} from "./database/restart-snapshot.js";
import { assertSupportedNodeRuntime } from "./node-support.js";
import { currentNodeRuntimeRef, sameReleaseRef } from "./release-ref.js";
import { resolveSharedRuntimeRoot } from "./platform/shared-runtime.js";
import { SharedReleaseStore } from "./shared-release-store.js";
import { HomeReleaseStore } from "./home-release-store.js";
import { RecommendedReleaseStore } from "./recommended-release.js";
import { EngineAutoUpdateCoordinator } from "./engine-auto-update.js";
import { EngineLifecycleService } from "./engine-lifecycle.js";
import {
  completeRuntimeHomeMigrationAfterStartup,
} from "./runtime-home-migration.js";
import { isProductionVersion, runtimeEnvironmentForVersion } from "./version.js";
import { writeLegacyRuntimeVersion } from "./legacy-runtime-metadata.js";

const log = createLogger("main");

const VALID_LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

const BUILTIN_BACKEND_PATHS: Record<string, () => Promise<{ default: new (options: Record<string, unknown>) => CliAgentBackend }>> = {
  claude: () => import("./backends/claude.js"),
  codex: () => import("./backends/codex.js"),
  traecli: () => import("./backends/traecli.js"),
  opencode: () => import("./backends/opencode.js"),
  cursor: () => import("./backends/cursor-agent.js"),
  pi: () => import("./backends/pi.js"),
  grok: () => import("./backends/grok.js"),
};

const backendClassCache = new Map<string, new (options: Record<string, unknown>) => CliAgentBackend>();

async function loadBackendClass(
  type: string,
): Promise<new (options: Record<string, unknown>) => CliAgentBackend> {
  const cached = backendClassCache.get(type);
  if (cached) return cached;

  const loader = BUILTIN_BACKEND_PATHS[type];
  if (!loader) {
    throw new Error(
      `Unknown backend: "${type}". Supported: ${BUILTIN_BACKEND_LIST.join(", ")}`,
    );
  }

  const mod = await loader();
  const BackendClass = mod.default;
  backendClassCache.set(type, BackendClass);
  return BackendClass;
}

async function main(): Promise<void> {
  assertSupportedNodeRuntime();
  const preflight = process.argv.includes("--preflight");
  const runtimePath = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const preflightStartedAt = Date.now();
  const logPreflightStage = (
    stage: string,
    startedAt: number,
    fields: Record<string, unknown> = {},
  ) => {
    if (!preflight) return;
    log.info("preflight stage finished", {
      stage,
      durationMs: Date.now() - startedAt,
      ...fields,
    });
  };

  const envLogLevel = process.env["NIUBOT_LOG_LEVEL"]?.toLowerCase();
  if (envLogLevel && VALID_LOG_LEVELS.has(envLogLevel)) {
    setLogLevel(envLogLevel as "debug" | "info" | "warn" | "error");
  }

  log.info(preflight ? "NiuBot preflight check starting..." : "NiuBot starting...");
  log.info("proxy environment", summarizeProxyEnvironment());
  process.env["PATH"] = prependNiubotBinToPath();

  const configStartedAt = Date.now();
  let config = loadConfig();
  let legacyReadOnlyPreflight = false;
  if (preflight) {
    const manifestPath = process.env[PREFLIGHT_DATABASE_MANIFEST_ENV];
    if (manifestPath) {
      config = applyPreflightDatabaseManifest(config, manifestPath);
    }
    if (!manifestPath || !shouldRunFullPreflight()) {
      assertDatabasesAtCompatibleSchemaVersion(
        config.bots.map((bot) => bot.dbPath),
        ROLLBACK_COMPATIBLE_SCHEMA_VERSIONS,
        LATEST_SCHEMA_VERSION,
      );
      legacyReadOnlyPreflight = true;
      log.info("compatibility preflight restricted to read-only checks", {
        hasDatabaseManifest: Boolean(manifestPath),
        reason: manifestPath ? "restart worker predates extended preflight" : "database manifest unavailable",
      });
    }
  }
  logPreflightStage("config_and_database_manifest", configStartedAt, {
    botCount: config.bots.length,
  });
  log.info("config loaded", {
    botCount: config.bots.length,
    bots: config.bots.map((b) => `${b.id}(${b.backend})`).join(", "),
  });

  const capabilityStartedAt = Date.now();
  const initialCapabilities = await probeAllBackendCapabilitiesAsync({
    // Startup validates each configured backend through backend.start(). Only
    // discover executables here so slow Windows hosts do not run every version
    // command and then immediately run the configured one a second time.
    verifyVersion: false,
  });
  logPreflightStage("backend_discovery", capabilityStartedAt, {
    backendCount: initialCapabilities.length,
    versionCommandsRun: 0,
  });
  const capabilityCache = new BackendCapabilityCache(
    initialCapabilities,
    // Refresh only checks executable presence; version probing is deferred
    // to per-backend recheck() when the user actually switches to one.
    () => probeAllBackendCapabilitiesAsync({ verifyVersion: false }),
    (backend) => probeBackendCapabilityAsync(backend),
  );
  log.info("backend capabilities", {
    backends: initialCapabilities.map((capability) => ({
      backend: capability.backend,
      selectable: capability.selectable,
      version: capability.version ?? null,
      reason: capability.reason ?? null,
    })),
  });

  if (preflight && legacyReadOnlyPreflight) {
    for (const bot of config.bots) {
      const backend = normalizeBackend(bot.backend);
      if (!backend) continue;
      const capability = initialCapabilities.find((candidate) => candidate.backend === backend);
      if (!capability?.selectable) {
        throw new Error(`Configured backend '${backend}' is unavailable: ${capability?.reason ?? "not installed"}`);
      }
    }
    log.info("legacy read-only preflight check passed");
    process.exit(0);
  }

  const backends = new Map<string, AgentBackend>();
  /** in-flight 去重：并发解析同一类型时共享同一个创建 Promise（Worker 角色并发 Job 场景） */
  const backendInflight = new Map<string, Promise<AgentBackend>>();

  async function createBackend(type: string): Promise<AgentBackend> {
    const BackendClass = await loadBackendClass(type);
    return new BackendClass({});
  }

  async function getOrCreateBackend(type: string): Promise<AgentBackend> {
    let capability = capabilityCache.get(type);
    if (!capability?.selectable) {
      capability = await capabilityCache.recheck(type);
    }
    if (!capability?.selectable) {
      throw new Error(`Backend '${type}' is unavailable: ${capability?.reason ?? "unknown backend"}`);
    }
    const cached = backends.get(type);
    if (cached) return cached;
    const inflight = backendInflight.get(type);
    if (inflight) return inflight;
    const creating = (async () => {
      const backend = await createBackend(type);
      const backendStartedAt = Date.now();
      let validated = false;
      try {
        await backend.start();
        validated = true;
      } finally {
        logPreflightStage("backend_validation", backendStartedAt, {
          backend: type,
          success: validated,
        });
      }
      backends.set(type, backend);
      log.info("backend started (lazy)", { type });
      return backend;
    })();
    backendInflight.set(type, creating);
    try {
      return await creating;
    } finally {
      backendInflight.delete(type);
    }
  }

  const getBackendCapabilities = async () => {
    const capabilities = await capabilityCache.refresh();
    return capabilities;
  };
  const getAvailableBackends = () => capabilityCache.availableBackends();

  const bots: BotInstance[] = [];
  let engineAutoUpdateCoordinator: EngineAutoUpdateCoordinator | undefined;
  const version = readRuntimeVersion(runtimePath);
  const startedAt = process.env["NIUBOT_STARTED_AT"] || new Date().toISOString();
  const engineLifecycle = new EngineLifecycleService({
    version,
    startedAt,
    runtimePath,
    niubotHome: NIUBOT_HOME,
    restartConfig: config.restart,
    configPath: config.configPath,
    initialAutoUpdateConfig: config.autoUpdate,
    onAutoUpdateConfigChanged: () => engineAutoUpdateCoordinator?.configChanged(),
  });
  for (const botConfig of config.bots) {
    const botStartedAt = Date.now();
    let initialized = false;
    try {
      const runtimeState = loadPersistedBotRuntimeState(botConfig.dbPath, botConfig.id);
      const availableBackends = getAvailableBackends();
      const runtimeBackend = normalizeBackend(runtimeState?.backendType);
      const configBackend = normalizeBackend(botConfig.backend);
      const runtimeSelectable = runtimeBackend ? availableBackends.some((backend) => backend === runtimeBackend) : false;
      if (!runtimeSelectable && configBackend && !availableBackends.some((backend) => backend === configBackend)) {
        const capability = capabilityCache.get(configBackend);
        throw new Error(`Configured backend '${configBackend}' is unavailable: ${capability?.reason ?? "not installed"}`);
      }
      const runtimeConfig = resolveBotRuntimeConfig(botConfig.backend, runtimeState, availableBackends);
      const backendType = runtimeConfig.backendType;
      const agent = await getOrCreateBackend(backendType);
      const instance = await createBotInstance(
        botConfig,
        agent,
        config.queue,
        backendType,
        getOrCreateBackend,
        getAvailableBackends,
        runtimeConfig,
        getBackendCapabilities,
        {
          preflight,
          engineLifecycle,
        },
      );
      bots.push(instance);
      initialized = true;
      log.info("bot backend assigned", {
        bot: botConfig.id,
        backend: backendType,
        configBackend: botConfig.backend,
        runtimeBackend: runtimeState?.backendType,
        model: runtimeConfig.model,
      });
    } catch (err) {
      log.error("failed to create bot instance", { bot: botConfig.id, error: String(err) });
    } finally {
      logPreflightStage("bot_initialization", botStartedAt, {
        bot: botConfig.id,
        success: initialized,
      });
    }
  }

  if (bots.length === 0) {
    log.error("no bot instances created, exiting");
    process.exit(1);
  }

  if (preflight) {
    const tempEndpoint = resolvePreflightEndpoint(NIUBOT_HOME, bots[0].config.id ?? "NiuBot");
    const { ApiServer } = await import("./core/api.js");
    const tempApi = new ApiServer(tempEndpoint, {
      sendMessage: async () => {},
      sendCard: async () => {},
      sendFile: async () => {},
      resolveChatPlatformId: () => undefined,
      getDefaultPlatformChatId: () => undefined,
    });
    const apiStartedAt = Date.now();
    await tempApi.start();
    logPreflightStage("temporary_api_start", apiStartedAt);
    log.info("preflight check passed");
    tempApi.stop();
    for (const bot of bots) {
      try { bot.db.close(); } catch { /* ignore */ }
    }
    logPreflightStage("total", preflightStartedAt);
    process.exit(0);
  }

  const instanceId = process.env["NIUBOT_INSTANCE_ID"] || randomUUID();
  const controlToken = process.env["NIUBOT_CONTROL_TOKEN"] || randomBytes(32).toString("hex");
  const engineEndpoint = resolveEngineEndpoint(NIUBOT_HOME);
  const identity: EngineIdentity = {
    pid: process.pid,
    instanceId,
    home: NIUBOT_HOME,
    version,
    runtimePath,
    startedAt,
  };
  let engineControlServer: EngineControlServer | undefined;
  let shuttingDown = false;
  const pidFile = resolve(NIUBOT_HOME, "niubot.pid");

  // 重启后恢复持久化的防休眠状态（失败不阻断启动）
  void engineLifecycle.restoreKeepAwakeFromConfig();

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info("shutting down...");
    engineAutoUpdateCoordinator?.stop();
    // 只停止 keep-awake 子进程，不写配置：持久化的开关状态在下次启动时恢复
    try { await engineLifecycle.setKeepAwakeEnabled(false, { persist: false }); } catch (e) {
      log.warn("failed to disable keep-awake during shutdown", { error: String(e) });
    }

    const schedulerStopPromises: Array<Promise<void>> = [];
    for (const bot of bots) {
      try { await bot.transport.stop(); } catch (e) { log.error("transport.stop failed", { bot: bot.id, error: String(e) }); }
      // 只清理 timer 并开始等当前 tick；真正等 tick 结束放到取消独立 session 之后，避免长 Agent 回合阻塞关闭。
      schedulerStopPromises.push(bot.cronScheduler.stop(), bot.loopScheduler.stop());
      bot.pipeline.stop();
      bot.apiServer.stop();
    }

    let schedulerStopSettled = false;
    const schedulerStopWait = Promise.all(schedulerStopPromises).then(() => { schedulerStopSettled = true; }).catch((err) => {
      log.error("scheduler drain failed", { error: String(err) });
      schedulerStopSettled = true;
    });
    for (const bot of bots) {
      await bot.pipeline.shutdown();
    }

    // Cron drain、独立 session 完成与 busy wait 共用同一截止时间，超时即强制退出，
    // 避免在有超时保护的等待之前无界 await（tick 卡在 createAgentSession 等不可取消阶段时）。
    const busyCount = bots.reduce((n, b) => n + (b.pipeline.hasBusyChats() ? 1 : 0), 0);
    if (busyCount > 0) log.info("waiting for in-flight tasks", { busyBots: busyCount });
    const inFlightTimeoutMs = resolveInFlightShutdownTimeoutMs();
    const deadline = Date.now() + inFlightTimeoutMs;
    while (Date.now() < deadline && (!schedulerStopSettled || bots.some((b) => b.pipeline.hasBusyChats()))) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!schedulerStopSettled) {
      log.warn("scheduler drain timed out, forcing exit", { timeoutMs: inFlightTimeoutMs });
    } else {
      // 已 settle，await 立即返回（不能无条件 await：卡死的 tick 会让关闭永久阻塞）。
      await schedulerStopWait;
    }
    if (bots.some((b) => b.pipeline.hasBusyChats())) {
      log.warn("in-flight wait timed out, forcing exit", { timeoutMs: inFlightTimeoutMs });
    } else if (busyCount > 0) {
      log.info("in-flight tasks completed");
    }

    for (const [type, backend] of backends) {
      try {
        await backend.stop();
        log.info("agent backend stopped", { type });
      } catch (e) { log.error("agent.stop failed", { type, error: String(e) }); }
    }

    for (const bot of bots) {
      try { bot.db.close(); } catch (e) { log.error("db.close failed", { bot: bot.id, error: String(e) }); }
    }

    engineControlServer?.stop();
    try { clearProcessState(NIUBOT_HOME, instanceId); } catch (e) {
      log.warn("failed to clear process state", { error: String(e) });
    }
    try {
      if (readFileSync(pidFile, "utf-8").trim() === String(process.pid)) {
        unlinkSync(pidFile);
        log.info("PID file removed");
      }
    } catch { /* ignore */ }

    log.info("bye");
    process.exit(0);
  };

  const runningBots: BotInstance[] = [];
  for (const bot of bots) {
    try {
      await startBotRuntime(bot, { log });
      runningBots.push(bot);
    } catch (err) {
      log.error("failed to start bot", { name: bot.id, error: String(err) });
    }
  }

  if (runningBots.length > 0) {
    const notificationBot = runningBots[0]!;
    engineAutoUpdateCoordinator = new EngineAutoUpdateCoordinator({
      lifecycle: engineLifecycle,
      participants: runningBots.map((bot) => bot.pipeline),
      notificationTarget: {
        id: notificationBot.id,
        db: notificationBot.db,
        dbPath: notificationBot.config.dbPath,
        transport: notificationBot.transport,
        platform: "feishu",
      },
    });
    engineAutoUpdateCoordinator.start();
  }

  engineControlServer = new EngineControlServer(engineEndpoint, identity, controlToken, shutdown);
  await engineControlServer.start();
  const launcherState = readProcessState(NIUBOT_HOME)?.processes.engine;
  const launcherManagesState = launcherState?.instanceId === instanceId
    && launcherState.pid === process.pid
    && launcherState.controlToken === controlToken
    && launcherState.startedAt === startedAt
    && launcherState.endpoint === engineEndpoint.address
    && samePlatformPath(launcherState.runtimePath, runtimePath);
  if (launcherManagesState) {
    log.info("launcher-managed process state retained", { instanceId, endpoint: engineEndpoint.address });
  } else {
    const platformStartMarker = queryProcessStartMarker(process.pid);
    writeProcessState(NIUBOT_HOME, {
      pid: process.pid,
      instanceId,
      startedAt,
      platformStartMarker,
      endpoint: engineEndpoint.address,
      endpointKind: engineEndpoint.kind,
      controlToken,
      version,
      runtimeMode: runtimeEnvironmentForVersion(version) ?? "",
      runtimePath,
      nodePath: process.execPath,
      logFile: process.env["NIUBOT_LOG_FILE"],
    });
    log.info("process state written", { instanceId, endpoint: engineEndpoint.address });
  }

  log.info("NiuBot is running", { activeBots: bots.length });

  {
    const timer = setTimeout(() => {
      const sharedStore = new SharedReleaseStore(resolveSharedRuntimeRoot());
      void completeRuntimeHomeMigrationAfterStartup({
        niubotHome: NIUBOT_HOME,
        runtimePath,
        node: currentNodeRuntimeRef(),
        sharedStore,
        env: process.env,
        settleMs: 0,
        timeoutMs: resolveRuntimeMigrationWaitMs(),
      }).then((migration) => {
        let launcherRuntimePath = runtimePath;
        if (migration) {
          const { homeStore, sharedRef, state } = migration;
          log.info("legacy runtime reference migrated to shared store", {
            artifactId: sharedRef.artifactId,
            currentStorage: state.current?.storage,
          });
          launcherRuntimePath = homeStore.resolveRuntime(sharedRef, true);
        }
        if (isProductionVersion(version)) {
          const homeStore = migration?.homeStore ?? new HomeReleaseStore(NIUBOT_HOME, sharedStore);
          const runningRef = migration?.sharedRef
            ?? homeStore.releaseRefForRuntimePath(runtimePath, currentNodeRuntimeRef());
          const stableState = homeStore.stateExistsRecovering() ? homeStore.readStateStrict() : undefined;
          if (runningRef?.storage === "shared" && !stableState?.transaction && sameReleaseRef(stableState?.current, runningRef)) {
            try {
              const recommended = new RecommendedReleaseStore(sharedStore).promote(runningRef);
              log.info("production recommendation ready", {
                artifactId: recommended.release.artifactId,
                generation: recommended.generation,
              });
            } catch (err) {
              log.info("production recommendation unchanged", { reason: String(err) });
            }
          }
        }
        setupRuntimeCliShims(launcherRuntimePath);
      }).catch((err) => {
        log.warn("legacy runtime reference migration deferred", { error: String(err) });
      });
    }, resolveRuntimeMigrationSettleMs());
    timer.unref();
  }

  // Legacy compatibility for one migration cycle.
  try {
    mkdirSync(NIUBOT_HOME, { recursive: true });
    writeFileSync(pidFile, String(process.pid));
    log.info("PID file written", { pidFile, pid: process.pid });
  } catch (e) {
    log.warn("failed to write PID file", { pidFile, error: String(e) });
  }
  try {
    writeLegacyRuntimeVersion(NIUBOT_HOME, version);
    log.info("legacy version snapshot written", { version });
  } catch (e) {
    // Canonical process state and Engine identity remain authoritative. This
    // file only serves old CLIs and must not make a healthy Engine fail.
    log.warn("failed to write legacy version snapshot", { error: String(e) });
  }

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      log.info("received signal", { signal: sig, pid: process.pid, ppid: process.ppid });
      void shutdown();
    });
  }

  process.on("uncaughtException", (err) => {
    log.error("uncaught exception", { error: String(err), stack: err.stack });
    void shutdown();
  });

  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { reason: String(reason) });
  });
}

function readRuntimeVersion(runtimePath: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(runtimePath, "package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function resolveRuntimeMigrationSettleMs(): number {
  const parsed = Number(process.env["NIUBOT_RUNTIME_MIGRATION_SETTLE_MS"]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2_000;
}

function resolveRuntimeMigrationWaitMs(): number {
  const parsed = Number(process.env["NIUBOT_RUNTIME_MIGRATION_WAIT_MS"]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 120_000;
}

function setupRuntimeCliShims(runtimePath: string): void {
  try {
    const shims = ensureRuntimeCliShims({
      projectRoot: runtimePath,
      includeNiubot: !existsSync(resolve(runtimePath, "src")),
    });
    for (const [command, shim] of Object.entries(shims)) {
      if (shim.status === "conflict" || shim.status === "skipped") {
        log.warn(`${command} shim setup skipped`, {
          status: shim.status,
          reason: shim.reason,
          shimPath: shim.shimPath,
        });
      } else {
        log.info(`${command} shim ready`, {
          status: shim.status,
          shimPath: shim.shimPath,
          targetPath: shim.targetPath,
        });
      }
    }
  } catch (err) {
    log.warn("CLI shim setup failed", { error: String(err) });
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
