/**
 * 结构化日志。人类可读格式输出，按级别区分。
 *
 * 格式：2026-03-31 18:08:46 [INFO] [pipeline] session recovered chatId=c1 sessionKey=s_xxx
 */

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
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

function log(level: LogLevel, module: string, msg: string, data?: Record<string, unknown>): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

  const line = `${formatTimestamp()} [${LEVEL_LABEL[level]}] [${module}] ${msg}${formatData(data)}\n`;

  const output = level === "error" ? process.stderr : process.stdout;
  output.write(line);
}

export function createLogger(module: string) {
  return {
    debug: (msg: string, data?: Record<string, unknown>) => log("debug", module, msg, data),
    info: (msg: string, data?: Record<string, unknown>) => log("info", module, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => log("warn", module, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => log("error", module, msg, data),
  };
}
