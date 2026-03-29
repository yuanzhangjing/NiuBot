import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";

export interface NiuBotConfig {
  feishu: {
    appId: string;
    appSecret: string;
  };
  agent: {
    /** ACP server 命令，默认 claude-code-acp */
    command: string;
    /** agent 工作目录 */
    workingDirectory: string;
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

const DEFAULTS: Omit<NiuBotConfig, "feishu"> = {
  agent: {
    command: "npx -y @zed-industries/claude-agent-acp",
    workingDirectory: process.cwd(),
  },
  database: {
    path: "./niubot.db",
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
      "Missing Feishu credentials. Set FEISHU_APP_ID and FEISHU_APP_SECRET environment variables, " +
      "or provide them in config/default.yaml",
    );
  }

  const agentFile = (fileConfig["agent"] as Record<string, string>) ?? {};
  const dbFile = (fileConfig["database"] as Record<string, string>) ?? {};
  const queueFile = (fileConfig["queue"] as Record<string, number>) ?? {};

  return {
    feishu: { appId, appSecret },
    agent: {
      command: process.env["NIUBOT_AGENT_COMMAND"] ?? agentFile["command"] ?? DEFAULTS.agent.command,
      workingDirectory: process.env["NIUBOT_WORK_DIR"] ?? agentFile["workingDirectory"] ?? DEFAULTS.agent.workingDirectory,
    },
    database: {
      path: process.env["NIUBOT_DB_PATH"] ?? (dbFile["path"] as string) ?? DEFAULTS.database.path,
    },
    queue: {
      bufferMs: Number(process.env["NIUBOT_BUFFER_MS"]) || queueFile["bufferMs"] || DEFAULTS.queue.bufferMs,
      cancelThresholdMs: Number(process.env["NIUBOT_CANCEL_MS"]) || queueFile["cancelThresholdMs"] || DEFAULTS.queue.cancelThresholdMs,
    },
  };
}

function findConfigFile(): string | undefined {
  const candidates = ["config/default.yaml", "config/default.json", "niubot.yaml", "niubot.json"];
  return candidates.find((f) => fs.existsSync(path.resolve(f)));
}
