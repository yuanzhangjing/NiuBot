import { writeFileSync, unlinkSync, mkdirSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  expandHome,
  NIUBOT_HOME,
  BUILTIN_BACKENDS,
  BUILTIN_BACKEND_LIST,
  type BuiltinBackendType,
  type NiuBotConfig,
} from "./config.js";
import type { AgentBackend } from "./agent/types.js";
import type { CliAgentBackend } from "./agent/cli-base.js";
import { createBotInstance, type BotInstance } from "./bot-instance.js";
import { loadPersistedBotRuntimeState } from "./database/schema.js";
import { createLogger, setLogLevel } from "./logger.js";
import { ensureRuntimeNbtShim, prependNiubotBinToPath } from "./niubot-cli.js";
import { summarizeProxyEnvironment } from "./proxy-env.js";
import { resolveBotRuntimeConfig } from "./runtime-config.js";
import { startBotRuntime } from "./bot-startup.js";

const log = createLogger("main");

const VALID_LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

// ── 内置 backend 注册表 ─────────────────────────────────

/** 内置 backend 的模块路径（相对于编译后的 dist/） */
const BUILTIN_BACKEND_PATHS: Record<string, () => Promise<{ default: new (options: Record<string, unknown>) => CliAgentBackend }>> = {
  claude: () => import("./backends/claude.js"),
  codex: () => import("./backends/codex.js"),
  traecli: () => import("./backends/traecli.js"),
  opencode: () => import("./backends/opencode.js"),
};

// ── 插件加载 ────────────────────────────────────────────

/** 已加载的 backend class 缓存 */
const backendClassCache = new Map<string, new (options: Record<string, unknown>) => CliAgentBackend>();

/** 校验插件类是否实现了必要方法 */
function validatePluginClass(name: string, cls: unknown): void {
  if (typeof cls !== "function") {
    throw new Error(`Backend plugin '${name}': default export is not a class`);
  }
  const proto = (cls as { prototype?: Record<string, unknown> }).prototype;
  const required = ["command", "buildSession", "buildInput", "parseOutput"];
  const missing = required.filter((m) => typeof proto?.[m] !== "function");
  if (missing.length > 0) {
    throw new Error(`Backend plugin '${name}': missing required methods: ${missing.join(", ")}`);
  }
}

/** 从 config 文件热读 backends 段，完整同步到运行时 config（增 + 删 + 改） */
function refreshCustomBackends(config: NiuBotConfig): void {
  try {
    const fresh = loadConfig();
    // 添加 / 更新
    for (const [name, def] of Object.entries(fresh.backends)) {
      if (!(name in config.backends)) {
        log.info("discovered new custom backend from config", { name });
      }
      config.backends[name] = def;
    }
    // 删除已从 config 中移除的（但保留 class 缓存，避免正在使用的 backend 挂掉）
    for (const name of Object.keys(config.backends)) {
      if (!(name in fresh.backends)) {
        delete config.backends[name];
        log.info("removed custom backend no longer in config", { name });
      }
    }
  } catch (err) {
    log.warn("failed to refresh custom backends from config", { error: String(err) });
  }
}

/** 加载 backend class（内置或自定义插件） */
async function loadBackendClass(
  type: string,
  config: NiuBotConfig,
): Promise<new (options: Record<string, unknown>) => CliAgentBackend> {
  const cached = backendClassCache.get(type);
  if (cached) return cached;

  let BackendClass: new (options: Record<string, unknown>) => CliAgentBackend;

  if (type in BUILTIN_BACKEND_PATHS) {
    // 内置 backend
    const mod = await BUILTIN_BACKEND_PATHS[type]();
    BackendClass = mod.default;
  } else {
    // 自定义插件：先查已加载的，未命中则热读 config
    if (!(type in config.backends)) {
      refreshCustomBackends(config);
    }
    const def = config.backends[type];
    if (!def) {
      throw new Error(
        `Unknown backend: "${type}". Built-in: ${BUILTIN_BACKEND_LIST.join(", ")}. ` +
        `Custom backends must be declared in config.yaml 'backends' section.`,
      );
    }
    const pluginPath = resolve(NIUBOT_HOME, expandHome(def.plugin));
    log.info("loading custom backend plugin", { name: type, path: pluginPath });
    const mod = await import(pluginPath);
    BackendClass = mod.default;
    validatePluginClass(type, BackendClass);
  }

  backendClassCache.set(type, BackendClass);
  return BackendClass;
}

// ── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  const preflight = process.argv.includes("--preflight");

  // 日志级别
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

  // 1. 加载配置
  const config = loadConfig();
  log.info("config loaded", {
    botCount: config.bots.length,
    bots: config.bots.map((b) => `${b.id}(${b.backend})`).join(", "),
    customBackends: Object.keys(config.backends).length > 0
      ? Object.keys(config.backends).join(", ")
      : undefined,
  });

  // 2. 创建 agent backend（per-bot，相同 backend type 共享实例）
  const backends = new Map<string, AgentBackend>();

  async function createBackend(type: string): Promise<AgentBackend> {
    const BackendClass = await loadBackendClass(type, config);
    const customOptions = config.backends[type]?.options ?? {};
    return new BackendClass({ ...customOptions });
  }

  /** 获取或创建 backend，确保已 start */
  async function getOrCreateBackend(type: string): Promise<AgentBackend> {
    let backend = backends.get(type);
    if (!backend) {
      backend = await createBackend(type);
      backends.set(type, backend);
      await backend.start();
      log.info("backend started (lazy)", { type });
    }
    return backend;
  }

  // 3. 创建所有 bot 实例（getOrCreateBackend 确保 backend 已 start）
  /** 动态获取可用 backend 列表（含热加载的自定义插件） */
  const getAvailableBackends = () => {
    refreshCustomBackends(config);
    const custom = Object.keys(config.backends).filter((b) => !BUILTIN_BACKENDS.has(b as BuiltinBackendType));
    return [...BUILTIN_BACKEND_LIST, ...custom];
  };

  // 确保插件 symlink 存在（使 import("niubot/plugin") 可解析）。
  // Preflight 运行在候选 release 上；不能提前改全局 symlink，否则预检失败也会影响旧服务。
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const pluginLink = resolve(NIUBOT_HOME, "node_modules", "niubot");
  if (preflight) {
    log.info("plugin symlink skipped in preflight", { link: pluginLink, target: packageRoot });
  } else {
    let needSymlink = true;
    try {
      needSymlink = realpathSync(pluginLink) !== realpathSync(packageRoot);
      if (needSymlink) rmSync(pluginLink, { recursive: true, force: true });
    } catch { /* 不存在 */ }
    if (needSymlink) {
      try {
        mkdirSync(dirname(pluginLink), { recursive: true });
        symlinkSync(packageRoot, pluginLink);
        log.info("plugin symlink created", { link: pluginLink, target: packageRoot });
      } catch (e) {
        log.warn("failed to create plugin symlink", { error: String(e) });
      }
    }
  }

  const bots: BotInstance[] = [];
  for (const botConfig of config.bots) {
    try {
      const autoUpdateNotificationsEnabled = bots.length === 0;
      const runtimeState = loadPersistedBotRuntimeState(botConfig.dbPath, botConfig.id);
      const runtimeConfig = resolveBotRuntimeConfig(botConfig.backend, runtimeState, getAvailableBackends());
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
        config.outputRewrite,
        config.restart,
        autoUpdateNotificationsEnabled,
      );
      bots.push(instance);
      log.info("bot backend assigned", {
        bot: botConfig.id,
        backend: backendType,
        configBackend: botConfig.backend,
        runtimeBackend: runtimeState?.backendType,
        model: runtimeConfig.model,
        liteModel: runtimeConfig.liteModel,
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

  // ── Preflight mode: verify init works, respond to /ping on temp socket, then exit ──
  if (preflight) {
    // Use a temporary socket so we don't conflict with the running instance
    const tempSocket = resolve(NIUBOT_HOME, bots[0].config.id ?? "NiuBot", "api.sock.preflight");
    const { ApiServer } = await import("./core/api.js");
    const tempApi = new ApiServer(tempSocket, {
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

  // 4. 启动所有 bot：pipeline/recover → API server → Cron → IM connect in background
  for (const bot of bots) {
    try {
      await startBotRuntime(bot, { log });
    } catch (err) {
      log.error("failed to start bot", { name: bot.id, error: String(err) });
    }
  }

  log.info("NiuBot is running", { activeBots: bots.length });

  // 写 PID 文件，供 restart.sh / start.sh 精确杀进程
  const pidFile = resolve(NIUBOT_HOME, "niubot.pid");
  try {
    mkdirSync(NIUBOT_HOME, { recursive: true });
    writeFileSync(pidFile, String(process.pid));
    log.info("PID file written", { pidFile, pid: process.pid });
  } catch (e) {
    log.warn("failed to write PID file", { pidFile, error: String(e) });
  }

  // 优雅退出
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info("shutting down...");

    // 1. 停止接收新消息 + 停止 cron/摘要/队列/API
    for (const bot of bots) {
      try { await bot.im.stop(); } catch (e) { log.error("im.stop failed", { bot: bot.id, error: String(e) }); }
      bot.cronScheduler.stop();
      bot.pipeline.stop();
      bot.apiServer.stop();
    }

    // 2. cancel 所有活跃 session 并等待 in-flight 任务完成（最多 15s）
    for (const bot of bots) {
      await bot.pipeline.shutdown();
    }
    const busyCount = bots.reduce((n, b) => n + (b.pipeline.hasBusyChats() ? 1 : 0), 0);
    if (busyCount > 0) {
      log.info("waiting for in-flight tasks", { busyBots: busyCount });
    }
    const deadline = Date.now() + 15_000;
    while (bots.some((b) => b.pipeline.hasBusyChats()) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (bots.some((b) => b.pipeline.hasBusyChats())) {
      log.warn("in-flight wait timed out, forcing exit");
    } else if (busyCount > 0) {
      log.info("in-flight tasks completed");
    }

    // 3. 关闭所有 agent backends
    for (const [type, backend] of backends) {
      try {
        await backend.stop();
        log.info("agent backend stopped", { type });
      } catch (e) { log.error("agent.stop failed", { type, error: String(e) }); }
    }

    // 4. 关闭所有数据库
    for (const bot of bots) {
      try { bot.db.close(); } catch (e) { log.error("db.close failed", { bot: bot.id, error: String(e) }); }
    }

    // 删除 PID 文件
    try {
      unlinkSync(pidFile);
      log.info("PID file removed");
    } catch { /* ignore */ }

    log.info("bye");
    process.exit(0);
  };

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

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
