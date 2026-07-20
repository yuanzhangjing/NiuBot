/**
 * 结构化日志。人类可读格式输出，按级别区分。
 *
 * 单 bot：2026-03-31 18:08:46 [INFO] [pipeline] session recovered chatId=c1
 * 多 bot：2026-03-31 18:08:46 [INFO] [NiuBot/pipeline] session recovered chatId=c1
 */

import { dateTimeInTimeZone } from "./tz.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
};

let minLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function formatTimestamp(): string {
  return dateTimeInTimeZone();
}

function formatData(data?: Record<string, unknown>): string {
  if (!data) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    const val = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${val}`);
  }
  return parts.length > 0 ? " " + parts.join(" ") : "";
}

function log(level: LogLevel, tag: string, msg: string, data?: Record<string, unknown>): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

  const line = `${formatTimestamp()} [${LEVEL_LABEL[level]}] [${tag}] ${msg}${formatData(data)}\n`;

  const output = level === "error" ? process.stderr : process.stdout;
  output.write(line);
}

/** 创建 logger。botName 可选，设置后输出 [botName/module] 格式 */
export function createLogger(module: string, botName?: string) {
  const tag = botName ? `${botName}/${module}` : module;
  return {
    debug: (msg: string, data?: Record<string, unknown>) => log("debug", tag, msg, data),
    info: (msg: string, data?: Record<string, unknown>) => log("info", tag, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => log("warn", tag, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => log("error", tag, msg, data),
  };
}
