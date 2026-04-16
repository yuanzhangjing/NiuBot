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
  },
  codex: {
    aliases: ["codex"],
  },
  traecli: {
    aliases: ["traecli", "trae-cli"],
  },
} as const;

/** 内置 agent backend 类型 */
export type BuiltinBackendType = keyof typeof AGENT_REGISTRY;
/** 任意 backend 类型（内置 + 自定义插件） */
export type AgentBackendType = string;

/** 自定义 backend 插件配置 */
export interface CustomBackendDef {
  plugin: string;
  options?: Record<string, unknown>;
}

/** 单个 Bot 的配置 */
export interface BotConfig {
  /** 唯一标识，决定数据目录路径，初始化后不可修改 */
  id: string;
  appId: string;
  appSecret: string;
  /** agent backend（必填） */
  backend: string;
  /** agent 工作目录（默认 ~/niubot-workspace/<id>） */
  workingDirectory: string;
  /** 数据库路径（默认 ~/.niubot/<id>/niubot.db） */
  dbPath: string;
  /** 人格文件路径（默认 ~/.niubot/<id>/persona.md） */
  personaPath: string;
  /** 主模型（可选，覆盖 backend 默认值） */
  model?: string;
  /** 轻量模型（可选，覆盖 backend 默认值） */
  liteModel?: string;
}

export interface NiuBotConfig {
  bots: BotConfig[];
  /** 自定义 backend 插件注册 */
  backends: Record<string, CustomBackendDef>;
  queue: {
    /** 消息缓冲合并窗口（ms），默认 1500 */
    bufferMs: number;
  };
}

export const BUILTIN_BACKENDS = new Set<BuiltinBackendType>(Object.keys(AGENT_REGISTRY) as BuiltinBackendType[]);
export const BUILTIN_BACKEND_LIST = Object.keys(AGENT_REGISTRY) as BuiltinBackendType[];

const BACKEND_ALIAS_MAP = new Map<string, BuiltinBackendType>(
  Object.entries(AGENT_REGISTRY).flatMap(([backend, meta]) =>
    meta.aliases.map((alias) => [alias, backend as BuiltinBackendType] as const),
  ),
);

const DEFAULTS = {
  queue: {
    bufferMs: 1500,
  },
};

/** 标准化 backend 名称：内置别名映射，自定义名称原样返回 */
export function normalizeBackend(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // 内置 backend 支持别名（如 "claude-code" → "claude"）
  return BACKEND_ALIAS_MAP.get(raw.toLowerCase()) ?? raw;
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
  const legacyAgentFile = (fileConfig["agent"] as Record<string, unknown>) ?? {};
  const queueFile = (fileConfig["queue"] as Record<string, number>) ?? {};

  // 向后兼容：从旧 default_config.backend / env 读取 fallback backend
  const legacyDefaultBackend = normalizeBackend(
    process.env["NIUBOT_BACKEND"]
      ?? ((fileConfig["default_config"] as Record<string, unknown>)?.["backend"] as string | undefined)
      ?? (legacyAgentFile["backend"] as string | undefined),
  );

  const queueConfig = {
    bufferMs: parseNumEnv(process.env["NIUBOT_BUFFER_MS"]) ?? queueFile["bufferMs"] ?? DEFAULTS.queue.bufferMs,
  };

  // 3. 解析 bots 配置
  let bots: BotConfig[];

  if (Array.isArray(fileConfig["bots"])) {
    const rawBots = fileConfig["bots"] as Array<Record<string, string>>;
    if (rawBots.length === 0) {
      throw new Error("Config error: bots array is empty");
    }
    bots = rawBots.map((b) => parseBotConfig(b, legacyDefaultBackend));

    const ids = new Set<string>();
    for (const bot of bots) {
      if (ids.has(bot.id)) {
        throw new Error(`Config error: duplicate bot id '${bot.id}'`);
      }
      ids.add(bot.id);
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
      id: "NiuBot",
      appId,
      appSecret,
      backend: legacyDefaultBackend ?? "claude",
      workingDirectory: path.resolve(legacyWorkDir),
      dbPath: legacyDbPath,
      personaPath: path.join(NIUBOT_HOME, "persona.md"),
      liteModel: process.env["NIUBOT_LITE_MODEL"] ?? (legacyAgentFile["liteModel"] as string | undefined) ?? undefined,
    }];
  }

  // 4. 解析自定义 backends
  const backends: Record<string, CustomBackendDef> = {};
  const backendsFile = fileConfig["backends"] as Record<string, Record<string, unknown>> | undefined;
  if (backendsFile) {
    for (const [name, def] of Object.entries(backendsFile)) {
      if (!def["plugin"] || typeof def["plugin"] !== "string") {
        throw new Error(`Config error: backend '${name}' missing 'plugin' path`);
      }
      backends[name] = {
        plugin: def["plugin"] as string,
        options: (def["options"] as Record<string, unknown>) ?? undefined,
      };
    }
  }

  return {
    bots,
    backends,
    queue: queueConfig,
  };
}

/** 解析单个 bot 配置，填充默认路径 */
function parseBotConfig(raw: Record<string, string>, legacyDefaultBackend?: string): BotConfig {
  // 兼容旧配置：优先读 id，fallback 到 name
  const id = raw["id"] ?? raw["name"];
  if (!id) throw new Error("Config error: bot entry missing 'id'");

  const appId = raw["appId"];
  const appSecret = raw["appSecret"];
  if (!appId || !appSecret) {
    throw new Error(`Config error: bot '${id}' missing appId or appSecret`);
  }

  const botDir = path.join(NIUBOT_HOME, id);

  const backend = normalizeBackend(raw["backend"]) ?? legacyDefaultBackend;
  if (!backend) {
    throw new Error(
      `Config error: bot '${id}' missing 'backend'. ` +
      `Set backend on the bot entry (e.g. backend: claude). ` +
      `Run 'niubot init' to detect available backends.`,
    );
  }

  return {
    id,
    appId,
    appSecret,
    backend,
    workingDirectory: raw["workingDirectory"]
      ? path.resolve(raw["workingDirectory"])
      : path.join(os.homedir(), "niubot-workspace", id),
    dbPath: raw["dbPath"] ?? path.join(botDir, "niubot.db"),
    personaPath: raw["personaPath"] ?? path.join(botDir, "persona.md"),
    model: raw["model"] ?? undefined,
    liteModel: raw["liteModel"] ?? undefined,
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
