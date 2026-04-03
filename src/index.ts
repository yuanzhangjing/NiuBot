import { loadConfig } from "./config.js";
import { ClaudeCliBackend } from "./agent/claude-cli/backend.js";
import type { AgentBackend } from "./agent/types.js";
import { createBotInstance, type BotInstance } from "./bot-instance.js";
import { createLogger, setLogLevel } from "./logger.js";

const log = createLogger("main");

const VALID_LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

async function main(): Promise<void> {
  // 日志级别
  const envLogLevel = process.env["NIUBOT_LOG_LEVEL"]?.toLowerCase();
  if (envLogLevel && VALID_LOG_LEVELS.has(envLogLevel)) {
    setLogLevel(envLogLevel as "debug" | "info" | "warn" | "error");
  }

  log.info("NiuBot starting...");

  // 1. 加载配置
  const config = loadConfig();
  log.info("config loaded", {
    backend: config.agent.backend,
    botCount: config.bots.length,
    bots: config.bots.map((b) => b.name).join(", "),
  });

  // 2. 创建共享 agent backend
  let agent: AgentBackend;
  switch (config.agent.backend) {
    case "claude-code":
      agent = new ClaudeCliBackend("bypassPermissions");
      break;
  }
  await agent.start();

  // 3. 创建所有 bot 实例
  const bots: BotInstance[] = [];
  for (const botConfig of config.bots) {
    try {
      const instance = await createBotInstance(botConfig, agent, config.queue);
      bots.push(instance);
    } catch (err) {
      log.error("failed to create bot instance", { bot: botConfig.name, error: String(err) });
    }
  }

  if (bots.length === 0) {
    log.error("no bot instances created, exiting");
    process.exit(1);
  }

  // 4. 启动所有 bot：recover → start → IM connect → API server → Cron
  for (const bot of bots) {
    try {
      await bot.pipeline.recover();
      await bot.pipeline.start();
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
      bot.summarizer.stop();
      bot.pipeline.stop();
      bot.apiServer.stop();
    }

    // 2. cancel 所有活跃 session 并等待 in-flight 任务完成（最多 15s）
    for (const bot of bots) {
      await bot.pipeline.shutdown();
    }
    const deadline = Date.now() + 15_000;
    while (bots.some((b) => b.pipeline.hasBusyChats()) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }

    // 3. 关闭 agent backend
    try { await agent.stop(); } catch (e) { log.error("agent.stop failed", { error: String(e) }); }

    // 4. 关闭所有数据库
    for (const bot of bots) {
      try { bot.db.close(); } catch (e) { log.error("db.close failed", { bot: bot.name, error: String(e) }); }
    }

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
