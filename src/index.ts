import { loadConfig } from "./config.js";
import { initDatabase } from "./database/schema.js";
import { FeishuAdapter } from "./im/feishu/adapter.js";
import { AcpBackend } from "./agent/acp/backend.js";
import { Pipeline } from "./core/pipeline.js";
import { createLogger, setLogLevel } from "./logger.js";

const log = createLogger("main");

async function main(): Promise<void> {
  // 日志级别
  if (process.env["NIUBOT_LOG_LEVEL"]) {
    setLogLevel(process.env["NIUBOT_LOG_LEVEL"] as "debug" | "info" | "warn" | "error");
  }

  log.info("NiuBot starting...");

  // 1. 加载配置
  const config = loadConfig();
  log.info("config loaded", {
    agentCommand: config.agent.command,
    workDir: config.agent.workingDirectory,
    dbPath: config.database.path,
  });

  // 2. 初始化数据库
  const db = initDatabase(config.database.path);

  // 3. 初始化 IM adapter
  const im = new FeishuAdapter(config.feishu.appId, config.feishu.appSecret);

  // 4. 初始化 Agent backend
  const agent = new AcpBackend(config.agent.command);

  // 5. 构建管道
  const pipeline = new Pipeline(
    db,
    im,
    agent,
    config.agent.workingDirectory,
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

  log.info("NiuBot is running");

  // 优雅退出
  const shutdown = async () => {
    log.info("shutting down...");
    await im.stop();
    await agent.stop();
    db.close();
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
