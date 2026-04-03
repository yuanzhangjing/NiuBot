import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

/** NIUBOT_HOME 默认 ~/.niubot */
const NIUBOT_HOME = process.env["NIUBOT_HOME"] ?? path.join(os.homedir(), ".niubot");

// 从 NIUBOT_HOME 加载 .env
dotenv.config({ path: path.join(NIUBOT_HOME, ".env") });

export { NIUBOT_HOME };

/** 支持的 agent backend */
export type AgentBackendType = "claude-code";

/** 单个 Bot 的配置 */
export interface BotConfig {
  name: string;
  appId: string;
  appSecret: string;
  /** agent 工作目录（默认 ~/.niubot/<name>/workspace/） */
  workingDirectory: string;
  /** 数据库路径（默认 ~/.niubot/<name>/niubot.db） */
  dbPath: string;
  /** 人格文件路径（默认 ~/.niubot/<name>/persona.md） */
  personaPath: string;
  /** 轻量模型（可选，不配则用 backend 内置默认值） */
  liteModel?: string;
  /** Admin user platform IDs（配置文件中指定的管理员） */
  adminUsers?: string[];
}

export interface NiuBotConfig {
  bots: BotConfig[];
  agent: {
    backend: AgentBackendType;
  };
  queue: {
    /** 消息缓冲合并窗口（ms），默认 3000 */
    bufferMs: number;
    /** cancel+合并阈值（ms），默认 10000 */
    cancelThresholdMs: number;
  };
}

const VALID_BACKENDS = new Set<AgentBackendType>(["claude-code"]);

const DEFAULTS = {
  agent: {
    backend: "claude-code" as AgentBackendType,
  },
  queue: {
    bufferMs: 3000,
    cancelThresholdMs: 10000,
  },
};

export function loadConfig(configPath?: string): NiuBotConfig {
  // 1. 尝试从配置文件加载
  let fileConfig: Record<string, unknown> = {};
  const filePath = configPath ?? findConfigFile();
  if (filePath && fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, "utf-8");
    fileConfig = filePath.endsWith(".json") ? JSON.parse(raw) : yaml.parse(raw);
  }

  // 2. 共享配置
  const agentFile = (fileConfig["agent"] as Record<string, string>) ?? {};
  const queueFile = (fileConfig["queue"] as Record<string, number>) ?? {};

  // backend 校验
  const backendRaw = process.env["NIUBOT_BACKEND"] ?? agentFile["backend"] ?? DEFAULTS.agent.backend;
  if (!VALID_BACKENDS.has(backendRaw as AgentBackendType)) {
    throw new Error(
      `Invalid agent.backend: "${backendRaw}". Valid options: ${[...VALID_BACKENDS].join(", ")}`,
    );
  }
  const backend = backendRaw as AgentBackendType;

  const queueConfig = {
    bufferMs: parseNumEnv(process.env["NIUBOT_BUFFER_MS"]) ?? queueFile["bufferMs"] ?? DEFAULTS.queue.bufferMs,
    cancelThresholdMs: parseNumEnv(process.env["NIUBOT_CANCEL_MS"]) ?? queueFile["cancelThresholdMs"] ?? DEFAULTS.queue.cancelThresholdMs,
  };

  // 3. 解析 bots 配置
  let bots: BotConfig[];

  if (Array.isArray(fileConfig["bots"])) {
    // 新格式：bots 数组
    const rawBots = fileConfig["bots"] as Array<Record<string, string>>;
    if (rawBots.length === 0) {
      throw new Error("Config error: bots array is empty");
    }
    bots = rawBots.map((b) => parseBotConfig(b));

    // 校验 bot name 唯一性
    const names = new Set<string>();
    for (const bot of bots) {
      if (names.has(bot.name)) {
        throw new Error(`Config error: duplicate bot name '${bot.name}'`);
      }
      names.add(bot.name);
    }
  } else {
    // 旧格式兼容：feishu.appId + feishu.appSecret → 单 bot
    const feishuFile = (fileConfig["feishu"] as Record<string, string>) ?? {};
    const appId = process.env["FEISHU_APP_ID"] ?? feishuFile["appId"];
    const appSecret = process.env["FEISHU_APP_SECRET"] ?? feishuFile["appSecret"];

    if (!appId || !appSecret) {
      throw new Error(
        "Missing bot credentials. Use new format (bots array in config.yaml) " +
        "or legacy format (FEISHU_APP_ID + FEISHU_APP_SECRET).",
      );
    }

    // 旧格式的 workingDirectory 和 dbPath 沿用原位置
    const legacyWorkDir = process.env["NIUBOT_WORK_DIR"] ?? agentFile["workingDirectory"];
    if (!legacyWorkDir) {
      throw new Error(
        "Missing agent.workingDirectory. Set NIUBOT_WORK_DIR environment variable, " +
        "or provide agent.workingDirectory in config.yaml",
      );
    }

    const legacyDbPath = process.env["NIUBOT_DB_PATH"]
      ?? ((fileConfig["database"] as Record<string, string>)?.["path"])
      ?? path.join(NIUBOT_HOME, "niubot.db");

    bots = [{
      name: "NiuBot",
      appId,
      appSecret,
      workingDirectory: path.resolve(legacyWorkDir),
      dbPath: legacyDbPath,
      personaPath: path.join(NIUBOT_HOME, "persona.md"),
      liteModel: process.env["NIUBOT_LITE_MODEL"] ?? agentFile["liteModel"] ?? undefined,
    }];
  }

  return {
    bots,
    agent: { backend },
    queue: queueConfig,
  };
}

/** 解析单个 bot 配置，填充默认路径 */
function parseBotConfig(raw: Record<string, string>): BotConfig {
  const name = raw["name"];
  if (!name) throw new Error("Config error: bot entry missing 'name'");

  const appId = raw["appId"];
  const appSecret = raw["appSecret"];
  if (!appId || !appSecret) {
    throw new Error(`Config error: bot '${name}' missing appId or appSecret`);
  }

  const botDir = path.join(NIUBOT_HOME, name);

  const adminUsersRaw = (raw as Record<string, unknown>)["adminUsers"];
  const adminUsers = Array.isArray(adminUsersRaw)
    ? adminUsersRaw.map(String)
    : undefined;

  return {
    name,
    appId,
    appSecret,
    workingDirectory: raw["workingDirectory"]
      ? path.resolve(raw["workingDirectory"])
      : path.join(botDir, "workspace"),
    dbPath: raw["dbPath"] ?? path.join(botDir, "niubot.db"),
    personaPath: raw["personaPath"] ?? path.join(botDir, "persona.md"),
    liteModel: raw["liteModel"] ?? undefined,
    adminUsers,
  };
}

function findConfigFile(): string | undefined {
  const candidates = [
    path.join(NIUBOT_HOME, "config.yaml"),
    path.join(NIUBOT_HOME, "config.json"),
  ];
  return candidates.find((f) => fs.existsSync(f));
}

/** 解析数字环境变量，undefined 或 NaN 返回 undefined（不会把 0 当 falsy） */
function parseNumEnv(val: string | undefined): number | undefined {
  if (val === undefined) return undefined;
  const n = Number(val);
  return Number.isNaN(n) ? undefined : n;
}
