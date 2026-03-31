import { loadConfig } from "./config.js";
import { initDatabase } from "./database/schema.js";
import { FeishuAdapter } from "./im/feishu/adapter.js";
import { AcpBackend } from "./agent/acp/backend.js";
import { ClaudeCliBackend } from "./agent/claude-cli/backend.js";
import type { AgentBackend } from "./agent/types.js";
import { Pipeline } from "./core/pipeline.js";
import { startSummarizer } from "./summarizer/index.js";
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
    workDir: config.agent.workingDirectory,
    dbPath: config.database.path,
  });

  // 2. 初始化数据库
  const db = initDatabase(config.database.path);

  // 3. 初始化 IM adapter
  const im = new FeishuAdapter(config.feishu.appId, config.feishu.appSecret);

  // 4. 初始化 Agent backend
  let agent: AgentBackend;
  switch (config.agent.backend) {
    case "claude-code":
      agent = new ClaudeCliBackend("bypassPermissions", config.agent.liteModel);
      break;
    case "claude-code-acp":
      agent = new AcpBackend("npx -y @agentclientprotocol/claude-agent-acp", "autoApprove", config.agent.liteModel);
      break;
  }

  // 5. 构建管道
  const pipeline = new Pipeline(
    db,
    im,
    agent,
    config.agent.workingDirectory,
    config.database.path,
    config.queue.bufferMs,
    config.queue.cancelThresholdMs,
  );

  // 6. 进程恢复（标记残留 active session 为 aborted）
  pipeline.recover();

  // 7. 启动 agent backend
  await agent.start();

  // 8. 注册消息回调 + 启动管道
  pipeline.start();

  // 9. 启动 IM（连接飞书 WebSocket，开始接收消息）
  await im.start();

  // 10. 启动定时摘要任务（每天 UTC 20:00 = CST 4:00）
  const summarizer = startSummarizer(db, agent);

  log.info("NiuBot is running");

  // 优雅退出
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info("shutting down...");

    // 1. 停止接收新消息
    try { await im.stop(); } catch (e) { log.error("im.stop failed", { error: String(e) }); }

    // 2. 停止摘要任务和队列
    summarizer.stop();
    pipeline.stop();

    // 3. cancel 所有活跃 session 并等待 in-flight 任务完成（最多 15s）
    await pipeline.shutdown();
    const deadline = Date.now() + 15_000;
    while (pipeline.hasBusyChats() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }

    // 4. 关闭 agent backend
    try { await agent.stop(); } catch (e) { log.error("agent.stop failed", { error: String(e) }); }

    // 5. 关闭数据库
    try { db.close(); } catch (e) { log.error("db.close failed", { error: String(e) }); }

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
