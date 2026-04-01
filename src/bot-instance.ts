import fs from "node:fs";
import path from "node:path";
import type { AgentBackend } from "./agent/types.js";
import type { BotConfig } from "./config.js";
import { initDatabase } from "./database/schema.js";
import { FeishuAdapter } from "./im/feishu/adapter.js";
import { Pipeline, type BotIdentity } from "./core/pipeline.js";
import { startSummarizer } from "./summarizer/index.js";
import { loadPersona } from "./persona.js";
import { buildStaticContext } from "./memory/inject.js";
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

  // 3. 生成 AGENTS.md + CLAUDE.md symlink
  generateAgentFiles(botConfig, log);

  // 4. 创建 IM adapter
  const im = new FeishuAdapter(botConfig.appId, botConfig.appSecret);

  // 5. 创建 Pipeline
  const botIdentity: BotIdentity = {
    name: botConfig.name,
    platform: "feishu",
    platformBotId: `_bot_${botConfig.name}_`,
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

  // 6. 创建 Summarizer
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

/**
 * 在 workingDirectory 下生成 AGENTS.md 和 CLAUDE.md（→ AGENTS.md 的 symlink）。
 * 每次启动时重新生成，支持 persona 热更新。
 */
function generateAgentFiles(
  botConfig: BotConfig,
  log: ReturnType<typeof createLogger>,
): void {
  const agentsPath = path.join(botConfig.workingDirectory, "AGENTS.md");
  const claudePath = path.join(botConfig.workingDirectory, "CLAUDE.md");

  // 生成 AGENTS.md
  const persona = loadPersona(botConfig.personaPath);
  const content = buildStaticContext(botConfig.name, persona);
  fs.writeFileSync(agentsPath, content, "utf-8");

  // CLAUDE.md → AGENTS.md symlink（先删再建，防止残留）
  try { fs.unlinkSync(claudePath); } catch { /* 不存在就忽略 */ }
  fs.symlinkSync("AGENTS.md", claudePath);

  log.info("agent files generated", { agentsPath, claudePath });
}
