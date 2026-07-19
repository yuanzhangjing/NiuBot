import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

/** 展开路径中的 ~ 为用户 home 目录 */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function resolveHomePath(homePath: string, cwd?: string): string {
  const expanded = expandHome(homePath);
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.resolve(cwd ?? safeCurrentWorkingDirectory(), expanded);
}

function safeCurrentWorkingDirectory(): string {
  try { return process.cwd(); } catch { return os.homedir(); }
}

/** NIUBOT_HOME 默认 ~/.niubot */
const NIUBOT_HOME = resolveHomePath(process.env["NIUBOT_HOME"] ?? path.join(os.homedir(), ".niubot"));

// 从 NIUBOT_HOME 加载 .env
dotenv.config({ path: path.join(NIUBOT_HOME, ".env"), quiet: true });

export { NIUBOT_HOME };

export const AGENT_REGISTRY = {
  claude: {
    aliases: ["claude", "claude-code"],
    command: "claude",
    versionArgs: ["--version"],
    windowsSupport: "native",
  },
  codex: {
    aliases: ["codex"],
    command: "codex",
    versionArgs: ["--version"],
    windowsSupport: "native",
  },
  traecli: {
    aliases: ["traecli", "trae-cli"],
    command: "traecli",
    versionArgs: ["--version"],
    windowsSupport: "unknown",
  },
  opencode: {
    aliases: ["opencode"],
    command: "opencode",
    versionArgs: ["--version"],
    windowsSupport: "native",
  },
  cursor: {
    aliases: ["cursor", "cursor-agent"],
    command: "cursor-agent",
    versionArgs: ["--version"],
    windowsSupport: "wsl-only",
  },
  pi: {
    aliases: ["pi", "pi-agent", "pi-coding-agent"],
    command: "pi",
    versionArgs: ["--version"],
    windowsSupport: "unknown",
  },
  grok: {
    aliases: ["grok", "grok-build"],
    command: "grok",
    versionArgs: ["--version"],
    windowsSupport: "native",
  },
} as const;

/** 内置 agent backend 类型 */
export type BuiltinBackendType = keyof typeof AGENT_REGISTRY;
/** 任意 backend 类型（内置） */
export type AgentBackendType = string;

/** 单个 Bot 的配置 */
export interface BotConfig {
  /** 唯一标识，决定数据目录路径，初始化后不可修改 */
  id: string;
  appId: string;
  appSecret: string;
  /** agent backend（可选，运行时从 DB 恢复或自动选择第一个可用 backend） */
  backend?: string;
  /** agent 工作目录（默认 ~/niubot-workspace/<id>） */
  workingDirectory: string;
  /** 数据库路径（默认 ~/.niubot/<id>/niubot.db） */
  dbPath: string;
  /** Bot profile 路径（默认 ~/.niubot/<id>/bot_profile.md） */
  botProfilePath?: string;
  /** 旧版人格文件路径（兼容旧配置） */
  personaPath?: string;
  /** 旧版 Bot 级长期做事规则路径（兼容旧配置） */
  instructionsPath?: string;
  /** 项目级长期背景（可选；默认不创建 workspace .niubot/project.md） */
  projectContextPath?: string;
  /** 主模型（可选，覆盖 backend 默认值） */
  model?: string;
}

export interface RestartConfig {
  sourceDirectory?: string;
}

export interface NiuBotConfig {
  bots: BotConfig[];
  /** 可选：重启脚本配置。默认使用当前运行包目录。 */
  restart?: RestartConfig;
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

function assertBuiltinBackend(backend: string | undefined, botId: string): void {
  if (!backend) return;
  if (!BUILTIN_BACKENDS.has(backend as BuiltinBackendType)) {
    throw new Error(
      `Config error: bot '${botId}' uses unsupported backend '${backend}'. ` +
      `Supported backends: ${BUILTIN_BACKEND_LIST.join(", ")}`,
    );
  }
}

/** 标准化 backend 名称：内置别名映射 */
export function normalizeBackend(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // 内置 backend 支持别名（如 "claude-code" → "claude"）
  return BACKEND_ALIAS_MAP.get(raw.toLowerCase()) ?? raw;
}

export function loadConfig(configPath?: string): NiuBotConfig {
  // 1. 尝试从配置文件加载
  let fileConfig: Record<string, unknown> = {};
  const filePath = configPath ?? findConfigFile();
  const configHome = filePath ? path.dirname(path.resolve(filePath)) : NIUBOT_HOME;
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
    bots = rawBots.map((b) => parseBotConfig(b, legacyDefaultBackend, configHome));

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
      ?? path.join(configHome, "niubot.db");

    const legacyWorkingDirectory = path.resolve(expandHome(legacyWorkDir));
    bots = [{
      id: "NiuBot",
      appId,
      appSecret,
      backend: legacyDefaultBackend,
      workingDirectory: legacyWorkingDirectory,
      dbPath: path.resolve(expandHome(legacyDbPath)),
      botProfilePath: path.join(configHome, "NiuBot", "bot_profile.md"),
      personaPath: path.join(configHome, "NiuBot", "persona.md"),
      instructionsPath: path.join(configHome, "NiuBot", "instructions.md"),
    }];
    assertBuiltinBackend(bots[0]!.backend, bots[0]!.id);
  }

  return {
    bots,
    restart: parseRestartConfig(fileConfig["restart"]),
    queue: queueConfig,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseRestartConfig(raw: unknown): RestartConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const sourceDirectory = stringValue(obj["sourceDirectory"]);
  if (!sourceDirectory) return undefined;
  return {
    sourceDirectory: path.resolve(expandHome(sourceDirectory)),
  };
}

/** 解析单个 bot 配置，填充默认路径 */
function parseBotConfig(raw: Record<string, string>, legacyDefaultBackend: string | undefined, configHome: string): BotConfig {
  // 兼容旧配置：优先读 id，fallback 到 name
  const id = raw["id"] ?? raw["name"];
  if (!id) throw new Error("Config error: bot entry missing 'id'");

  const appId = raw["appId"];
  const appSecret = raw["appSecret"];
  if (!appId || !appSecret) {
    throw new Error(`Config error: bot '${id}' missing appId or appSecret`);
  }

  const botDir = path.join(configHome, id);

  const backend = normalizeBackend(raw["backend"]) ?? legacyDefaultBackend;
  assertBuiltinBackend(backend, id);
  const workingDirectory = raw["workingDirectory"]
    ? path.resolve(expandHome(raw["workingDirectory"]))
    : path.join(os.homedir(), "niubot-workspace", id);
  return {
    id,
    appId,
    appSecret,
    backend,
    workingDirectory,
    dbPath: raw["dbPath"] ? path.resolve(expandHome(raw["dbPath"])) : path.join(botDir, "niubot.db"),
    botProfilePath: raw["botProfilePath"] ? path.resolve(expandHome(raw["botProfilePath"])) : path.join(botDir, "bot_profile.md"),
    personaPath: raw["personaPath"] ? path.resolve(expandHome(raw["personaPath"])) : undefined,
    instructionsPath: raw["instructionsPath"] ? path.resolve(expandHome(raw["instructionsPath"])) : undefined,
    projectContextPath: raw["projectContextPath"] ? path.resolve(expandHome(raw["projectContextPath"])) : undefined,
    model: raw["model"] ?? undefined,
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
