import fs from "node:fs";
import path from "node:path";
import type { AgentBackend } from "./agent/types.js";
import { installBuiltinSkills } from "./platform/skills-install.js";
import { NIUBOT_HOME, type BotConfig, type AgentBackendType } from "./config.js";
import {
  initDatabase,
  ensureUser,
  getUserShortLabel,
  getUserShortLabelByPlatformId,
  getUserIdentityByPlatformId,
  getMessageByPlatformId,
  setUserIsBot,
} from "./database/schema.js";
import { seedPeerBots, type PeerBotDirectory } from "./peer-bots.js";
import { FeishuAdapter } from "./im/feishu/adapter.js";
import { PersistentTransport } from "./transport/persistent-transport.js";
import { Pipeline, type BotIdentity } from "./core/pipeline.js";
import type { EngineLifecycle } from "./engine-lifecycle.js";
import { ApiServer, type ApiHandler } from "./core/api.js";
import { CronScheduler } from "./core/cron.js";
import { LoopScheduler } from "./core/loop.js";
import { ensureBotProfileFile } from "./bot-profile.js";
import { ensureStaticContextFiles, ensureWorkspaceAgentFiles } from "./static-context.js";
import { createLogger } from "./logger.js";
import type { ResolvedBotRuntimeConfig } from "./runtime-config.js";
import type Database from "better-sqlite3";
import { resolveBotEndpoint } from "./platform/ipc.js";
import { TZ } from "./tz.js";
import type { BackendCapability } from "./agent/backend-capability.js";

export interface BotInstance {
  id: string;
  config: BotConfig;
  db: Database.Database;
  transport: PersistentTransport;
  pipeline: Pipeline;
  apiServer: ApiServer;
  cronScheduler: CronScheduler;
  loopScheduler: LoopScheduler;
}

/**
 * 创建一个 Bot 实例：初始化目录、DB、IM adapter、Pipeline、API Server、Cron、Summarizer。
 */
export async function createBotInstance(
  botConfig: BotConfig,
  agent: AgentBackend,
  queueConfig: { bufferMs: number },
  backendType?: AgentBackendType,
  backendResolver?: (type: AgentBackendType) => Promise<AgentBackend>,
  getAvailableBackends?: () => string[],
  runtimeConfig?: ResolvedBotRuntimeConfig,
  getBackendCapabilities?: () => BackendCapability[] | Promise<BackendCapability[]>,
  options: {
    preflight?: boolean;
    engineLifecycle?: EngineLifecycle;
    peerBots?: PeerBotDirectory;
  } = {},
): Promise<BotInstance> {
  const log = createLogger("bot-instance", botConfig.id);
  if (!options.engineLifecycle) {
    throw new Error("Engine lifecycle service is required");
  }

  // 1. 确保目录和默认文件存在
  fs.mkdirSync(path.dirname(botConfig.dbPath), { recursive: true });
  if (!options.preflight) {
    fs.mkdirSync(botConfig.workingDirectory, { recursive: true });
    // 内置技能安装：包内 skills/ → 备份源 $NIUBOT_HOME/skills/（镜像同步），
    // 并在 workingDirectory/.claude/skills/ 与 .agents/skills/ 建软链接
    // （claude / codex 自动发现；升级删减自动跟随；用户自装技能不被动）
    installBuiltinSkills(botConfig.workingDirectory, path.join(NIUBOT_HOME, "skills"));
    ensureBotProfileFile(botConfig.botProfilePath, {
      personaPath: botConfig.personaPath,
      instructionsPath: botConfig.instructionsPath,
      workspaceDirectory: botConfig.workingDirectory,
    });
    ensureStaticContextFiles({
      instructionsPath: botConfig.instructionsPath,
      projectContextPath: botConfig.projectContextPath,
    });
  }

  // 2. 初始化数据库
  const databaseStartedAt = Date.now();
  const db = initDatabase(botConfig.dbPath);
  log.info("database initialized", {
    dbPath: botConfig.dbPath,
    durationMs: Date.now() - databaseStartedAt,
    preflight: options.preflight === true,
  });

  // 3. 确保 workspace AGENTS.md 存在；已有用户文件不覆盖
  const refreshAgentContextFiles = options.preflight
    ? () => {}
    : () => generateAgentFiles(botConfig, log);
  refreshAgentContextFiles();

  // 4. 创建 IM adapter（注入 DB resolver 用于 merge_forward 等场景）
  const im = new FeishuAdapter(botConfig.appId, botConfig.appSecret);
  // 只读查询：DB 中已有用户直接返回 label
  im.setNameLookup((platformId) => {
    const label = getUserShortLabelByPlatformId(db, "feishu", platformId);
    if (label === platformId) return undefined; // 不在 DB 中
    return label; // 有名字 "U2(名字)"，无名字 "U2"
  });
  // 注册新用户：写 DB，返回 label
  im.setNameRegister((platformId, isBot) => {
    const userId = ensureUser(db, "feishu", platformId);
    if (isBot) setUserIsBot(db, userId);
    return getUserShortLabel(db, userId);
  });
  im.setContentResolver((platformMsgId) => {
    const msg = getMessageByPlatformId(db, "feishu", platformMsgId);
    return msg?.contentText ?? undefined;
  });
  im.setIdentityLookup((platformId) => {
    const row = getUserIdentityByPlatformId(db, "feishu", platformId);
    if (!row) return undefined;
    return { isBot: row.isBot };
  });
  if (options.peerBots) {
    const peerBots = options.peerBots;
    peerBots.subscribe((peers) => seedPeerBots(db, botConfig.id, peers));
    im.setOnIdentity(({ openId, name }) => {
      peerBots.register({
        botId: botConfig.id,
        openId,
        name: name || botConfig.id,
      });
    });
  }
  im.setStorageDir(path.dirname(botConfig.dbPath));

  // 5. 创建 Pipeline
  const botIdentity: BotIdentity = {
    name: botConfig.id,
    platform: "feishu",
    platformBotId: `_bot_${botConfig.id}_`,
    model: runtimeConfig?.model,
    effort: runtimeConfig?.effort,
  };

  const transport = new PersistentTransport({
    db,
    botId: botConfig.id,
    platform: "feishu",
    adapter: im,
    storageDir: path.dirname(botConfig.dbPath),
  });

  const pipeline = new Pipeline(
    db,
    transport,
    agent,
    botIdentity,
    botConfig.workingDirectory,
    botConfig.dbPath,
    queueConfig.bufferMs,
    backendType,
    backendResolver,
    getAvailableBackends,
    refreshAgentContextFiles,
    {
      botProfilePath: botConfig.botProfilePath,
      personaPath: botConfig.personaPath,
      instructionsPath: botConfig.instructionsPath,
    },
    undefined, // legacy restart config; EngineLifecycle owns restart
    undefined, // legacy Pipeline coordinator slot; Engine now owns auto-update
    undefined, // archiveHome
    getBackendCapabilities,
    undefined, // legacy auto-update config
    undefined, // legacy config path
    undefined, // legacy config observer
    options.engineLifecycle,
  );
  transport.onInbound((delivery) => pipeline.handleInbound(delivery));

  // 6. 创建 API Server
  const endpoint = resolveBotEndpoint(NIUBOT_HOME, botConfig.id, { unixSocketDirectory: path.dirname(botConfig.dbPath) });
  const apiHandler: ApiHandler = {
    sendMessage: (chatId, text, token) => pipeline.sendToChat(chatId, text, token),
    sendCard: (chatId, header, content, token) => pipeline.sendCardToChat(chatId, header, content, token),
    sendFile: (chatId, filePath, token) => pipeline.sendFileToChat(chatId, filePath, token),
    executeScheduleCommand: (chatId, command, token) => pipeline.executeScheduleAgentCommand(chatId, command, token),
    executeGoalFinishCommand: (chatId, command, token) => pipeline.executeGoalFinishCommand(chatId, command, token),
    executeGoalStartCommand: (chatId, objective, token) => pipeline.executeGoalStartCommand(chatId, objective, token),
    executeGoalProgressCommand: (chatId, content, status) => pipeline.executeGoalProgressCommand(chatId, content, status),
    executeWakeCommand: (chatId, prompt) => pipeline.executeWakeCommand(chatId, prompt),
    getTimezone: () => TZ,
    setTimezone: (raw) => pipeline.setEngineTimezone(raw),
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
  };
  const apiServer = new ApiServer(endpoint, apiHandler);

  // 7. 创建 Cron Scheduler（独立 session，不走用户消息队列）
  const cronScheduler = new CronScheduler(
    db,
    async (chatId, userId, prompt, description, cronJobId, claimToken) => {
      await pipeline.processCronJob(chatId, userId, prompt, description, cronJobId, claimToken);
    },
    {
      reportFailure: (chatId, description, error, paused) =>
        pipeline.reportCronJobFailure(chatId, description, error, paused),
    },
  );
  const loopScheduler = new LoopScheduler(db, (job) => {
    pipeline.enqueueLoopJob(job.id);
  });

  log.info("bot instance created", {
    workDir: botConfig.workingDirectory,
    botProfile: botConfig.botProfilePath,
    endpoint: endpoint.address,
  });

  return {
    id: botConfig.id,
    config: botConfig,
    db,
    transport,
    pipeline,
    apiServer,
    cronScheduler,
    loopScheduler,
  };
}

/**
 * 确保 workingDirectory 下有用户可编辑的 AGENTS.md。
 */
function generateAgentFiles(
  botConfig: BotConfig,
  log: ReturnType<typeof createLogger>,
): void {
  const agentsPath = path.join(botConfig.workingDirectory, "AGENTS.md");

  ensureWorkspaceAgentFiles(botConfig.workingDirectory, {
    projectContextPath: botConfig.projectContextPath,
  });

  log.info("workspace agent rules ensured", { agentsPath });
}
