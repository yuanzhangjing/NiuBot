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
export type AgentBackendType = "claude-code" | "claude-code-acp";

export interface NiuBotConfig {
  feishu: {
    appId: string;
    appSecret: string;
  };
  agent: {
    /** 选择 agent backend */
    backend: AgentBackendType;
    /** agent 工作目录（必填，agent 在此目录下工作） */
    workingDirectory: string;
    /** 轻量任务使用的模型（可选，不配则用 backend 内置默认值） */
    liteModel?: string;
  };
  database: {
    path: string;
  };
  queue: {
    /** 消息缓冲合并窗口（ms），默认 3000 */
    bufferMs: number;
    /** cancel+合并阈值（ms），默认 10000 */
    cancelThresholdMs: number;
  };
}

const VALID_BACKENDS = new Set<AgentBackendType>(["claude-code", "claude-code-acp"]);

const DEFAULTS = {
  agent: {
    backend: "claude-code" as AgentBackendType,
  },
  database: {
    path: path.join(NIUBOT_HOME, "niubot.db"),
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

  // 2. Env 优先覆盖
  const appId = process.env["FEISHU_APP_ID"] ?? (fileConfig["feishu"] as Record<string, string>)?.["appId"];
  const appSecret = process.env["FEISHU_APP_SECRET"] ?? (fileConfig["feishu"] as Record<string, string>)?.["appSecret"];

  if (!appId || !appSecret) {
    throw new Error(
      "Missing Feishu credentials. Set FEISHU_APP_ID and FEISHU_APP_SECRET in ~/.niubot/.env, " +
      "or provide them in ~/.niubot/config.yaml",
    );
  }

  const agentFile = (fileConfig["agent"] as Record<string, string>) ?? {};
  const dbFile = (fileConfig["database"] as Record<string, string>) ?? {};
  const queueFile = (fileConfig["queue"] as Record<string, number>) ?? {};

  // workingDirectory 必填
  const workingDirectory = process.env["NIUBOT_WORK_DIR"] ?? agentFile["workingDirectory"];
  if (!workingDirectory) {
    throw new Error(
      "Missing agent.workingDirectory. Set NIUBOT_WORK_DIR environment variable, " +
      "or provide agent.workingDirectory in config.yaml",
    );
  }

  // backend 校验
  const backendRaw = process.env["NIUBOT_BACKEND"] ?? agentFile["backend"] ?? DEFAULTS.agent.backend;
  if (!VALID_BACKENDS.has(backendRaw as AgentBackendType)) {
    throw new Error(
      `Invalid agent.backend: "${backendRaw}". Valid options: ${[...VALID_BACKENDS].join(", ")}`,
    );
  }
  const backend = backendRaw as AgentBackendType;

  return {
    feishu: { appId, appSecret },
    agent: {
      backend,
      workingDirectory: path.resolve(workingDirectory),
      liteModel: process.env["NIUBOT_LITE_MODEL"] ?? agentFile["liteModel"] ?? undefined,
    },
    database: {
      path: process.env["NIUBOT_DB_PATH"] ?? (dbFile["path"] as string) ?? DEFAULTS.database.path,
    },
    queue: {
      bufferMs: parseNumEnv(process.env["NIUBOT_BUFFER_MS"]) ?? queueFile["bufferMs"] ?? DEFAULTS.queue.bufferMs,
      cancelThresholdMs: parseNumEnv(process.env["NIUBOT_CANCEL_MS"]) ?? queueFile["cancelThresholdMs"] ?? DEFAULTS.queue.cancelThresholdMs,
    },
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
