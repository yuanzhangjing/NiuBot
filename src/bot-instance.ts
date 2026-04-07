import fs from "node:fs";
import path from "node:path";
import type { AgentBackend } from "./agent/types.js";
import type { BotConfig } from "./config.js";
import { initDatabase, ensureUser, getUserShortLabel, getUserShortLabelByPlatformId, getMessageByPlatformId } from "./database/schema.js";
import { FeishuAdapter } from "./im/feishu/adapter.js";
import { Pipeline, type BotIdentity } from "./core/pipeline.js";
import { ApiServer, type ApiHandler } from "./core/api.js";
import { CronScheduler } from "./core/cron.js";
import { startSummarizer } from "./summarizer/index.js";
import { ensurePersonaFile } from "./persona.js";
import { buildStaticContext } from "./memory/inject.js";
import { createLogger } from "./logger.js";
import type Database from "better-sqlite3";

export interface BotInstance {
  name: string;
  config: BotConfig;
  db: Database.Database;
  im: FeishuAdapter;
  pipeline: Pipeline;
  apiServer: ApiServer;
  cronScheduler: CronScheduler;
  summarizer: { stop: () => void };
}

/**
 * 创建一个 Bot 实例：初始化目录、DB、IM adapter、Pipeline、API Server、Cron、Summarizer。
 */
export async function createBotInstance(
  botConfig: BotConfig,
  agent: AgentBackend,
  queueConfig: { bufferMs: number; cancelThresholdMs: number },
): Promise<BotInstance> {
  const log = createLogger("bot-instance", botConfig.name);

  // 1. 确保目录和默认文件存在
  fs.mkdirSync(path.dirname(botConfig.dbPath), { recursive: true });
  fs.mkdirSync(botConfig.workingDirectory, { recursive: true });
  ensurePersonaFile(botConfig.personaPath);

  // 2. 初始化数据库
  const db = initDatabase(botConfig.dbPath);
  log.info("database initialized", { dbPath: botConfig.dbPath });

  // 3. 生成 AGENTS.md + CLAUDE.md symlink
  generateAgentFiles(botConfig, log);

  // 4. 创建 IM adapter（注入 DB resolver 用于 merge_forward 等场景）
  const im = new FeishuAdapter(botConfig.appId, botConfig.appSecret);
  // 只读查询：DB 中已有用户直接返回 label
  im.setNameLookup((platformId) => {
    const label = getUserShortLabelByPlatformId(db, "feishu", platformId);
    if (label === platformId) return undefined; // 不在 DB 中
    return label; // 有名字 "U2(名字)"，无名字 "U2"
  });
  // 注册新用户：写 DB，返回 label
  im.setNameRegister((platformId) => {
    const userId = ensureUser(db, "feishu", platformId);
    return getUserShortLabel(db, userId);
  });
  im.setContentResolver((platformMsgId) => {
    const msg = getMessageByPlatformId(db, "feishu", platformMsgId);
    return msg?.contentText ?? undefined;
  });
  im.setStorageDir(path.dirname(botConfig.dbPath));

  // 5. 创建 Pipeline
  const botIdentity: BotIdentity = {
    name: botConfig.name,
    platform: "feishu",
    platformBotId: `_bot_${botConfig.name}_`,
    liteModel: botConfig.liteModel,
    adminPlatformIds: botConfig.adminUsers,
    personaPath: botConfig.personaPath,
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

  // 6. 创建 API Server
  const socketPath = path.join(path.dirname(botConfig.dbPath), "api.sock");
  const apiHandler: ApiHandler = {
    sendMessage: (chatId, text) => pipeline.sendToChat(chatId, text),
    sendFile: (chatId, filePath) => pipeline.sendFileToChat(chatId, filePath),
    resolveChatPlatformId: (input: string) => {
      // Try as internal ID (c1, c2)
      const lower = input.toLowerCase();
      if (/^c\d+$/.test(lower)) {
        const row = db.prepare("SELECT platform_id FROM chats WHERE id = ?").get(lower) as { platform_id: string } | undefined;
        return row?.platform_id;
      }
      // Try as platform ID directly
      const row = db.prepare("SELECT platform_id FROM chats WHERE platform_id = ?").get(input) as { platform_id: string } | undefined;
      return row?.platform_id ?? input;
    },
    getDefaultPlatformChatId: () => undefined,
    restart: () => {
      log.info("restart requested via API");
      process.exit(0); // Exit cleanly, let supervisor restart
    },
  };
  const apiServer = new ApiServer(socketPath, apiHandler);

  // 7. 创建 Cron Scheduler
  const cronScheduler = new CronScheduler(db, async (chatId, userId, prompt) => {
    // Route cron prompt through the agent pipeline (same path as user messages)
    pipeline.injectPrompt(chatId, userId, `[定时任务] ${prompt}`);
  });

  // 8. 创建 Summarizer
  const summarizer = startSummarizer(db, agent);

  log.info("bot instance created", {
    workDir: botConfig.workingDirectory,
    persona: botConfig.personaPath,
    socketPath,
  });

  return {
    name: botConfig.name,
    config: botConfig,
    db,
    im,
    pipeline,
    apiServer,
    cronScheduler,
    summarizer,
  };
}

/**
 * 在 workingDirectory 下生成 AGENTS.md 和 CLAUDE.md（→ AGENTS.md 的 symlink）。
 */
function generateAgentFiles(
  botConfig: BotConfig,
  log: ReturnType<typeof createLogger>,
): void {
  const agentsPath = path.join(botConfig.workingDirectory, "AGENTS.md");
  const claudePath = path.join(botConfig.workingDirectory, "CLAUDE.md");

  const content = buildStaticContext();
  fs.writeFileSync(agentsPath, content, "utf-8");

  try { fs.unlinkSync(claudePath); } catch { /* 不存在就忽略 */ }
  fs.symlinkSync("AGENTS.md", claudePath);

  log.info("agent files generated", { agentsPath, claudePath });
}
