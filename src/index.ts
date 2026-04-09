import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  getConfiguredBackend,
  getDefaultLiteModel,
  loadConfig,
  type AgentBackendType,
} from "./config.js";
import { ClaudeCliBackend } from "./agent/claude-cli/backend.js";
import { CodexCliBackend } from "./agent/codex/backend.js";
import type { AgentBackend } from "./agent/types.js";
import { createBotInstance, type BotInstance } from "./bot-instance.js";
import { createLogger, setLogLevel } from "./logger.js";
import { prependNiubotBinToPath } from "./niubot-cli.js";

const log = createLogger("main");

const VALID_LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

async function main(): Promise<void> {
  // 日志级别
  const envLogLevel = process.env["NIUBOT_LOG_LEVEL"]?.toLowerCase();
  if (envLogLevel && VALID_LOG_LEVELS.has(envLogLevel)) {
    setLogLevel(envLogLevel as "debug" | "info" | "warn" | "error");
  }

  log.info("NiuBot starting...");
  process.env["PATH"] = prependNiubotBinToPath();

  // 1. 加载配置
  const config = loadConfig();
  log.info("config loaded", {
    backend: config.defaultConfig.backend,
    botCount: config.bots.length,
    bots: config.bots.map((b) => b.name).join(", "),
  });

  // 2. 创建 agent backend（per-bot，相同 backend type 共享实例）
  const backends = new Map<AgentBackendType, AgentBackend>();
  const startedBackends = new Set<AgentBackendType>();

  function createBackend(type: AgentBackendType): AgentBackend {
    switch (type) {
      case "claude":
        return new ClaudeCliBackend("bypassPermissions", getDefaultLiteModel(config, type));
      case "codex":
        return new CodexCliBackend("danger-full-access", getDefaultLiteModel(config, type));
    }
  }

  /** 获取或创建 backend，确保已 start */
  async function getOrCreateBackend(type: AgentBackendType): Promise<AgentBackend> {
    let backend = backends.get(type);
    if (!backend) {
      backend = createBackend(type);
      backends.set(type, backend);
      await backend.start();
      startedBackends.add(type);
      log.info("backend started (lazy)", { type });
    }
    return backend;
  }

  // 3. 创建所有 bot 实例（getOrCreateBackend 确保 backend 已 start）
  const bots: BotInstance[] = [];
  for (const botConfig of config.bots) {
    try {
      const backendType = getConfiguredBackend(config, botConfig);
      const agent = await getOrCreateBackend(backendType);
      const instance = await createBotInstance(botConfig, agent, config.queue, backendType, getOrCreateBackend);
      bots.push(instance);
      log.info("bot backend assigned", {
        bot: botConfig.name,
        backend: backendType,
      });
    } catch (err) {
      log.error("failed to create bot instance", { bot: botConfig.name, error: String(err) });
    }
  }

  if (bots.length === 0) {
    log.error("no bot instances created, exiting");
    process.exit(1);
  }

  // 4. 启动所有 bot：start（identity + admin 检测） → recover → IM connect → API server → Cron
  for (const bot of bots) {
    try {
      await bot.pipeline.start();
      await bot.pipeline.recover();
      await bot.im.start();

      // Start API server for IPC
      await bot.apiServer.start();

      // Start cron scheduler
      bot.cronScheduler.start();

      log.info("bot started", { name: bot.name });
    } catch (err) {
      log.error("failed to start bot", { name: bot.name, error: String(err) });
    }
  }

  log.info("NiuBot is running", { activeBots: bots.length });

  // 写 PID 文件，供 restart.sh / start.sh 精确杀进程
  const niubotHome = process.env["NIUBOT_HOME"] ?? resolve(process.env["HOME"] ?? "", ".niubot");
  const pidFile = resolve(niubotHome, "niubot.pid");
  try {
    mkdirSync(niubotHome, { recursive: true });
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
      try { await bot.im.stop(); } catch (e) { log.error("im.stop failed", { bot: bot.name, error: String(e) }); }
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
      try { bot.db.close(); } catch (e) { log.error("db.close failed", { bot: bot.name, error: String(e) }); }
    }

    // 删除 PID 文件
    try {
      unlinkSync(pidFile);
      log.info("PID file removed");
    } catch { /* ignore */ }

    log.info("bye");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
