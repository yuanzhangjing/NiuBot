import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

/** NIUBOT_HOME 默认 ~/.niubot */
const NIUBOT_HOME = process.env["NIUBOT_HOME"] ?? path.join(os.homedir(), ".niubot");

// 从 NIUBOT_HOME 加载 .env
dotenv.config({ path: path.join(NIUBOT_HOME, ".env"), quiet: true });

export { NIUBOT_HOME };

export const AGENT_REGISTRY = {
  claude: {
    aliases: ["claude", "claude-code"],
    defaultLiteModel: "haiku",
  },
  codex: {
    aliases: ["codex"],
    defaultLiteModel: "gpt-5.4-mini",
  },
} as const;

/** 支持的 agent backend */
export type AgentBackendType = keyof typeof AGENT_REGISTRY;

export interface DefaultConfig {
  backend: AgentBackendType;
  liteModel: Record<AgentBackendType, string>;
}

/** 单个 Bot 的配置 */
export interface BotConfig {
  name: string;
  appId: string;
  appSecret: string;
  /** agent backend（可选，覆盖全局 default_config.backend） */
  backend?: AgentBackendType;
  /** agent 工作目录（默认 ~/.niubot/<name>/workspace/） */
  workingDirectory: string;
  /** 数据库路径（默认 ~/.niubot/<name>/niubot.db） */
  dbPath: string;
  /** 人格文件路径（默认 ~/.niubot/<name>/persona.md） */
  personaPath: string;
  /** 轻量模型（可选，覆盖 backend 默认值） */
  liteModel?: string;
  /** Admin user platform IDs（配置文件中指定的管理员） */
  adminUsers?: string[];
}

export interface NiuBotConfig {
  bots: BotConfig[];
  defaultConfig: DefaultConfig;
  queue: {
    /** 消息缓冲合并窗口（ms），默认 3000 */
    bufferMs: number;
    /** cancel+合并阈值（ms），默认 10000 */
    cancelThresholdMs: number;
  };
}

export const VALID_BACKENDS = new Set<AgentBackendType>(Object.keys(AGENT_REGISTRY) as AgentBackendType[]);
export const AGENT_BACKEND_DISPLAY = Object.keys(AGENT_REGISTRY) as AgentBackendType[];

const BACKEND_ALIAS_MAP = new Map<string, AgentBackendType>(
  Object.entries(AGENT_REGISTRY).flatMap(([backend, meta]) =>
    meta.aliases.map((alias) => [alias, backend as AgentBackendType] as const),
  ),
);

const DEFAULTS = {
  defaultConfig: {
    backend: "claude" as AgentBackendType,
    liteModel: Object.fromEntries(
      Object.entries(AGENT_REGISTRY).map(([backend, meta]) => [backend, meta.defaultLiteModel]),
    ) as Record<AgentBackendType, string>,
  },
  queue: {
    bufferMs: 3000,
    cancelThresholdMs: 10000,
  },
};

export function normalizeBackend(raw: string | undefined, fieldName = "backend"): AgentBackendType | undefined {
  if (!raw) return undefined;
  const normalized = BACKEND_ALIAS_MAP.get(raw.toLowerCase());
  if (!normalized) {
    throw new Error(`Invalid ${fieldName}: "${raw}". Valid options: ${[...VALID_BACKENDS].join(", ")}`);
  }
  return normalized;
}

export function getDefaultLiteModel(config: NiuBotConfig, backend: AgentBackendType): string {
  return config.defaultConfig.liteModel[backend];
}

export function getConfiguredBackend(config: NiuBotConfig, bot: BotConfig): AgentBackendType {
  return bot.backend ?? config.defaultConfig.backend;
}

export function getBotLiteModel(config: NiuBotConfig, bot: BotConfig, backend: AgentBackendType): string {
  return bot.liteModel ?? getDefaultLiteModel(config, backend);
}

export function loadConfig(configPath?: string): NiuBotConfig {
  // 1. 尝试从配置文件加载
  let fileConfig: Record<string, unknown> = {};
  const filePath = configPath ?? findConfigFile();
  if (filePath && fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, "utf-8");
    fileConfig = filePath.endsWith(".json") ? JSON.parse(raw) : yaml.parse(raw);
  }

  // 2. 共享配置
  const defaultConfigFile = (fileConfig["default_config"] as Record<string, unknown>) ?? {};
  const legacyAgentFile = (fileConfig["agent"] as Record<string, unknown>) ?? {};
  const queueFile = (fileConfig["queue"] as Record<string, number>) ?? {};
  const defaultConfig = parseDefaultConfig(defaultConfigFile, legacyAgentFile);

  const queueConfig = {
    bufferMs: parseNumEnv(process.env["NIUBOT_BUFFER_MS"]) ?? queueFile["bufferMs"] ?? DEFAULTS.queue.bufferMs,
    cancelThresholdMs: parseNumEnv(process.env["NIUBOT_CANCEL_MS"]) ?? queueFile["cancelThresholdMs"] ?? DEFAULTS.queue.cancelThresholdMs,
  };

  // 3. 解析 bots 配置
  let bots: BotConfig[];

  if (Array.isArray(fileConfig["bots"])) {
    const rawBots = fileConfig["bots"] as Array<Record<string, string>>;
    if (rawBots.length === 0) {
      throw new Error("Config error: bots array is empty");
    }
    bots = rawBots.map((b) => parseBotConfig(b));

    const names = new Set<string>();
    for (const bot of bots) {
      if (names.has(bot.name)) {
        throw new Error(`Config error: duplicate bot name '${bot.name}'`);
      }
      names.add(bot.name);
    }
  } else {
    const feishuFile = (fileConfig["feishu"] as Record<string, string>) ?? {};
    const appId = process.env["FEISHU_APP_ID"] ?? feishuFile["appId"];
    const appSecret = process.env["FEISHU_APP_SECRET"] ?? feishuFile["appSecret"];

    if (!appId || !appSecret) {
      throw new Error(
        "Missing bot credentials. Use new format (bots array in config.yaml) " +
        "or legacy format (FEISHU_APP_ID + FEISHU_APP_SECRET).",
      );
    }

    const legacyWorkDir = process.env["NIUBOT_WORK_DIR"] ?? (legacyAgentFile["workingDirectory"] as string | undefined);
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
      liteModel: process.env["NIUBOT_LITE_MODEL"] ?? (legacyAgentFile["liteModel"] as string | undefined) ?? undefined,
    }];
  }

  return {
    bots,
    defaultConfig,
    queue: queueConfig,
  };
}

function parseDefaultConfig(
  defaultConfigFile: Record<string, unknown>,
  legacyAgentFile: Record<string, unknown>,
): DefaultConfig {
  const backend = normalizeBackend(
    process.env["NIUBOT_BACKEND"]
      ?? (defaultConfigFile["backend"] as string | undefined)
      ?? (legacyAgentFile["backend"] as string | undefined)
      ?? DEFAULTS.defaultConfig.backend,
    "default_config.backend",
  )!;

  const liteModelFile = (defaultConfigFile["liteModel"] as Record<string, string> | undefined) ?? {};
  const liteModel = {} as Record<AgentBackendType, string>;

  for (const backendKey of AGENT_BACKEND_DISPLAY) {
    liteModel[backendKey] =
      liteModelFile[backendKey]
      ?? (backendKey === backend ? process.env["NIUBOT_LITE_MODEL"] : undefined)
      ?? DEFAULTS.defaultConfig.liteModel[backendKey];
  }

  return { backend, liteModel };
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

  const backend = normalizeBackend(raw["backend"], `bot '${name}'.backend`);

  return {
    name,
    appId,
    appSecret,
    backend,
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
