import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
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
import { loadPersistedBotRuntimeState } from "./database/schema.js";
import { createLogger, setLogLevel } from "./logger.js";
import { ensureRuntimeNbtShim, prependNiubotBinToPath } from "./platform/cli-runtime.js";
import { summarizeProxyEnvironment } from "./proxy-env.js";
import { resolveBotRuntimeConfig } from "./runtime-config.js";
import { startBotRuntime } from "./bot-startup.js";
import { resolveEngineEndpoint, resolvePreflightEndpoint } from "./platform/ipc.js";
import { probeAllBackendCapabilities, probeBackendCapability } from "./agent/backend-capability.js";
import { normalizeBackend } from "./config.js";
import { EngineControlServer, type EngineIdentity } from "./local-api/engine-server.js";
import { clearProcessState, writeProcessState } from "./process-state.js";
import { queryProcessStartMarker } from "./platform/process.js";

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
  const preflight = process.argv.includes("--preflight");

  const envLogLevel = process.env["NIUBOT_LOG_LEVEL"]?.toLowerCase();
  if (envLogLevel && VALID_LOG_LEVELS.has(envLogLevel)) {
    setLogLevel(envLogLevel as "debug" | "info" | "warn" | "error");
  }

  log.info(preflight ? "NiuBot preflight check starting..." : "NiuBot starting...");
  log.info("proxy environment", summarizeProxyEnvironment());
  process.env["PATH"] = prependNiubotBinToPath();
  try {
    const nbtShim = ensureRuntimeNbtShim({ preflight });
    if (nbtShim.status === "conflict") {
      log.warn("nbt shim not installed because target already exists", {
        shimPath: nbtShim.shimPath,
        targetPath: nbtShim.targetPath,
        reason: nbtShim.reason,
      });
    } else if (nbtShim.status === "skipped" && nbtShim.reason === "preflight run") {
      log.info("nbt shim setup skipped", {
        shimPath: nbtShim.shimPath,
        targetPath: nbtShim.targetPath,
        reason: nbtShim.reason,
      });
    } else if (nbtShim.status === "skipped") {
      log.warn("nbt shim setup skipped", {
        shimPath: nbtShim.shimPath,
        targetPath: nbtShim.targetPath,
        reason: nbtShim.reason,
      });
    } else {
      log.info("nbt shim ready", {
        status: nbtShim.status,
        shimPath: nbtShim.shimPath,
        targetPath: nbtShim.targetPath,
      });
    }
  } catch (err) {
    log.warn("nbt shim setup failed", { error: String(err) });
  }

  const config = loadConfig();
  log.info("config loaded", {
    botCount: config.bots.length,
    bots: config.bots.map((b) => `${b.id}(${b.backend})`).join(", "),
  });

  const backends = new Map<string, AgentBackend>();

  async function createBackend(type: string): Promise<AgentBackend> {
    const BackendClass = await loadBackendClass(type);
    return new BackendClass({});
  }

  async function getOrCreateBackend(type: string): Promise<AgentBackend> {
    const capability = probeBackendCapability(type);
    if (!capability?.selectable) {
      throw new Error(`Backend '${type}' is unavailable: ${capability?.reason ?? "unknown backend"}`);
    }
    let backend = backends.get(type);
    if (!backend) {
      backend = await createBackend(type);
      backends.set(type, backend);
      await backend.start();
      log.info("backend started (lazy)", { type });
    }
    return backend;
  }

  const getBackendCapabilities = () => probeAllBackendCapabilities();
  const getAvailableBackends = () => getBackendCapabilities()
    .filter((capability) => capability.selectable)
    .map((capability) => capability.backend);

  const startupCapabilities = probeAllBackendCapabilities();
  log.info("backend capabilities", {
    backends: startupCapabilities.map((capability) => ({
      backend: capability.backend,
      selectable: capability.selectable,
      version: capability.version ?? null,
      reason: capability.reason ?? null,
    })),
  });

  const bots: BotInstance[] = [];
  for (const botConfig of config.bots) {
    try {
      const autoUpdateNotificationsEnabled = bots.length === 0;
      const runtimeState = loadPersistedBotRuntimeState(botConfig.dbPath, botConfig.id);
      const availableBackends = getAvailableBackends();
      const runtimeBackend = normalizeBackend(runtimeState?.backendType);
      const configBackend = normalizeBackend(botConfig.backend);
      const runtimeSelectable = runtimeBackend ? availableBackends.some((backend) => backend === runtimeBackend) : false;
      if (!runtimeSelectable && configBackend && !availableBackends.some((backend) => backend === configBackend)) {
        const capability = startupCapabilities.find((candidate) => candidate.backend === configBackend);
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
        config.restart,
        autoUpdateNotificationsEnabled,
        getBackendCapabilities,
      );
      bots.push(instance);
      log.info("bot backend assigned", {
        bot: botConfig.id,
        backend: backendType,
        configBackend: botConfig.backend,
        runtimeBackend: runtimeState?.backendType,
        model: runtimeConfig.model,
        autoUpdateNotifications: autoUpdateNotificationsEnabled,
      });
    } catch (err) {
      log.error("failed to create bot instance", { bot: botConfig.id, error: String(err) });
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
    await tempApi.start();
    log.info("preflight check passed");
    tempApi.stop();
    for (const bot of bots) {
      try { bot.db.close(); } catch { /* ignore */ }
    }
    process.exit(0);
  }

  const runtimePath = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const version = readRuntimeVersion(runtimePath);
  const instanceId = process.env["NIUBOT_INSTANCE_ID"] || randomUUID();
  const controlToken = process.env["NIUBOT_CONTROL_TOKEN"] || randomBytes(32).toString("hex");
  const startedAt = process.env["NIUBOT_STARTED_AT"] || new Date().toISOString();
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

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info("shutting down...");

    for (const bot of bots) {
      try { await bot.im.stop(); } catch (e) { log.error("im.stop failed", { bot: bot.id, error: String(e) }); }
      bot.cronScheduler.stop();
      bot.pipeline.stop();
      bot.apiServer.stop();
    }

    for (const bot of bots) {
      await bot.pipeline.shutdown();
    }
    const busyCount = bots.reduce((n, b) => n + (b.pipeline.hasBusyChats() ? 1 : 0), 0);
    if (busyCount > 0) log.info("waiting for in-flight tasks", { busyBots: busyCount });
    const deadline = Date.now() + 15_000;
    while (bots.some((b) => b.pipeline.hasBusyChats()) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (bots.some((b) => b.pipeline.hasBusyChats())) {
      log.warn("in-flight wait timed out, forcing exit");
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
      unlinkSync(pidFile);
      log.info("PID file removed");
    } catch { /* ignore */ }

    log.info("bye");
    process.exit(0);
  };

  for (const bot of bots) {
    try {
      await startBotRuntime(bot, { log });
    } catch (err) {
      log.error("failed to start bot", { name: bot.id, error: String(err) });
    }
  }

  engineControlServer = new EngineControlServer(engineEndpoint, identity, controlToken, shutdown);
  await engineControlServer.start();
  writeProcessState(NIUBOT_HOME, {
    pid: process.pid,
    instanceId,
    startedAt,
    platformStartMarker: queryProcessStartMarker(process.pid),
    endpoint: engineEndpoint.address,
    endpointKind: engineEndpoint.kind,
    controlToken,
    version,
    runtimeMode: process.env["NIUBOT_RUNTIME_MODE"] || "",
    runtimePath,
    nodePath: process.execPath,
  });
  log.info("process state written", { instanceId, endpoint: engineEndpoint.address });

  log.info("NiuBot is running", { activeBots: bots.length });

  // Legacy compatibility for one migration cycle.
  try {
    mkdirSync(NIUBOT_HOME, { recursive: true });
    writeFileSync(pidFile, String(process.pid));
    log.info("PID file written", { pidFile, pid: process.pid });
  } catch (e) {
    log.warn("failed to write PID file", { pidFile, error: String(e) });
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

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
