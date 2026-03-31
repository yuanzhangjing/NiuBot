import fs from "node:fs";
import path from "node:path";
import type { AgentBackend } from "./agent/types.js";
import type { BotConfig } from "./config.js";
import { initDatabase } from "./database/schema.js";
import { FeishuAdapter } from "./im/feishu/adapter.js";
import { Pipeline, type BotIdentity } from "./core/pipeline.js";
import { startSummarizer } from "./summarizer/index.js";
import { createLogger } from "./logger.js";
import type Database from "better-sqlite3";

export interface BotInstance {
  name: string;
  config: BotConfig;
  db: Database.Database;
  im: FeishuAdapter;
  pipeline: Pipeline;
  summarizer: { stop: () => void };
}

/**
 * 创建一个 Bot 实例：初始化目录、DB、IM adapter、Pipeline、Summarizer。
 */
export async function createBotInstance(
  botConfig: BotConfig,
  agent: AgentBackend,
  queueConfig: { bufferMs: number; cancelThresholdMs: number },
): Promise<BotInstance> {
  const log = createLogger("bot-instance", botConfig.name);

  // 1. 确保目录存在
  fs.mkdirSync(path.dirname(botConfig.dbPath), { recursive: true });
  fs.mkdirSync(botConfig.workingDirectory, { recursive: true });

  // 2. 初始化数据库
  const db = initDatabase(botConfig.dbPath);
  log.info("database initialized", { dbPath: botConfig.dbPath });

  // 3. 创建 IM adapter
  const im = new FeishuAdapter(botConfig.appId, botConfig.appSecret);

  // 4. 创建 Pipeline
  const botIdentity: BotIdentity = {
    name: botConfig.name,
    platform: "feishu",
    platformBotId: `_bot_${botConfig.name}_`,
    personaPath: botConfig.personaPath,
    liteModel: botConfig.liteModel,
  };

  const pipeline = new Pipeline(
    db,
    im,
    agent,
    botIdentity,
    botConfig.workingDirectory,
    botConfig.dbPath,
    queueConfig.bufferMs,
    queueConfig.cancelThresholdMs,
  );

  // 5. 创建 Summarizer
  const summarizer = startSummarizer(db, agent);

  log.info("bot instance created", {
    workDir: botConfig.workingDirectory,
    persona: botConfig.personaPath,
  });

  return {
    name: botConfig.name,
    config: botConfig,
    db,
    im,
    pipeline,
    summarizer,
  };
}
