import dotenv from "dotenv";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";
import { AUTO_UPDATE_DEFAULTS, type AutoUpdateConfig } from "./core/auto-update.js";
import { recoverFileReplacementSync, replaceFileSync } from "./platform/files.js";
import { acquireProcessLock } from "./process-lock.js";

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
  },
  codex: {
    aliases: ["codex"],
    command: "codex",
    versionArgs: ["--version"],
  },
  traecli: {
    aliases: ["traecli", "trae-cli"],
    command: "traecli",
    versionArgs: ["--version"],
  },
  opencode: {
    aliases: ["opencode"],
    command: "opencode",
    versionArgs: ["--version"],
  },
  cursor: {
    aliases: ["cursor", "cursor-agent"],
    command: "cursor-agent",
    versionArgs: ["--version"],
  },
  pi: {
    aliases: ["pi", "pi-agent", "pi-coding-agent"],
    command: "pi",
    versionArgs: ["--version"],
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
  /** 实际加载的配置文件；纯环境变量启动时为空。 */
  configPath?: string;
  bots: BotConfig[];
  /** 可选：重启脚本配置。默认使用当前运行包目录。 */
  restart?: RestartConfig;
  /** 可选：自动升级配置。未配置或 enabled=false 时不启用。 */
  autoUpdate?: AutoUpdateConfig;
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
  if (filePath) recoverConfigFileReplacement(filePath);
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
    configPath: filePath ? path.resolve(filePath) : undefined,
    bots,
    restart: parseRestartConfig(fileConfig["restart"]),
    autoUpdate: parseAutoUpdateConfig(fileConfig["autoUpdate"]),
    queue: queueConfig,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * 解析 autoUpdate 配置：只支持一个布尔开关。
 * autoUpdate: true → 启用（窗口等用默认值）；false 或缺省 → 未配置（关闭）。
 * /update auto on|off 直接原子修改同一配置文件。
 */
function parseAutoUpdateConfig(raw: unknown): AutoUpdateConfig | undefined {
  if (raw !== true) return undefined;
  return { enabled: true, ...AUTO_UPDATE_DEFAULTS };
}

/** 原子修改配置文件中的 autoUpdate 布尔值，并保留 YAML 注释。 */
export function writeAutoUpdateEnabledToConfig(configPath: string, enabled: boolean): void {
  updateConfigFileAtomically(configPath, (raw, format) => {
    if (format === "json") {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("配置文件根节点必须是对象");
      }
      (parsed as Record<string, unknown>)["autoUpdate"] = enabled;
      return `${JSON.stringify(parsed, null, 2)}\n`;
    }
    const document = yaml.parseDocument(raw);
    if (document.errors.length > 0) throw document.errors[0];
    if (document.contents !== null && !yaml.isMap(document.contents)) {
      throw new Error("配置文件根节点必须是对象");
    }
    document.set("autoUpdate", enabled);
    return document.toString({ lineWidth: 0 });
  });
}

/** 在公用锁内重读最新配置，再原子替换；避免多个程序内写入者相互覆盖。 */
export function updateConfigFileAtomically(
  configPath: string,
  update: (raw: string, format: "yaml" | "json") => string,
): void {
  const source = path.resolve(configPath);
  const releaseLock = acquireProcessLock(configMutationLockPath(source), "Config update");
  try {
    const target = fs.realpathSync.native(source);
    const raw = fs.readFileSync(target, "utf-8");
    const serialized = update(raw, source.endsWith(".json") ? "json" : "yaml");

    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    const originalStats = fs.statSync(target);
    const mode = originalStats.mode & 0o777;
    fs.writeFileSync(temporary, serialized, { encoding: "utf-8", mode, flag: "wx" });
    try {
      if (process.platform !== "win32") {
        const temporaryStats = fs.statSync(temporary);
        if (temporaryStats.uid !== originalStats.uid || temporaryStats.gid !== originalStats.gid) {
          fs.chownSync(temporary, originalStats.uid, originalStats.gid);
        }
        fs.chmodSync(temporary, mode);
      }
      replaceFileSync(temporary, target);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  } finally {
    releaseLock();
  }
}

/** 所有程序内的服务配置写入共用同一把跨进程锁。 */
export function configMutationLockPath(configPath: string): string {
  return path.join(path.dirname(path.resolve(configPath)), "run", "config.lock");
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
  return candidates.find((candidate) => {
    recoverConfigFileReplacement(candidate);
    return fs.existsSync(candidate);
  });
}

/**
 * Windows 替换文件要经过 destination → backup → destination 两步。
 * 若进程在中间退出，下次读配置时先恢复旧文件。
 */
function recoverConfigFileReplacement(configPath: string): void {
  recoverFileReplacementSync(resolveConfigStoragePath(configPath));
}

/** 即使软链的最终目标暂时缺失，也能定位其 backup。 */
function resolveConfigStoragePath(configPath: string): string {
  let current = path.resolve(configPath);
  const seen = new Set<string>();
  for (let depth = 0; depth < 32; depth++) {
    if (seen.has(current)) throw new Error(`Config error: symlink cycle at '${configPath}'`);
    seen.add(current);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return current;
      throw err;
    }
    if (!stats.isSymbolicLink()) return current;
    const target = fs.readlinkSync(current);
    current = path.resolve(path.dirname(current), target);
  }
  throw new Error(`Config error: too many symlinks at '${configPath}'`);
}

/** 解析数字环境变量，undefined 或 NaN 返回 undefined（不会把 0 当 falsy） */
function parseNumEnv(val: string | undefined): number | undefined {
  if (val === undefined) return undefined;
  const n = Number(val);
  return Number.isNaN(n) ? undefined : n;
}
