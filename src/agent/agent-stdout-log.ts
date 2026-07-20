import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveHomePath } from "../config.js";
import { dateInTimeZone, dateTimeInTimeZone } from "../tz.js";

function resolveNiubotHome(): string {
  return resolveHomePath(process.env["NIUBOT_HOME"] ?? join(homedir(), ".niubot"));
}

export type AgentStdoutDumpReason = "complete" | "exit" | "fail";

export type AgentStdoutDumpInput = {
  backend: string;
  sessionId?: string;
  reason: AgentStdoutDumpReason;
  cmd: string;
  args: string[];
  cwd?: string;
  stdinLength?: number;
  stdinPreview?: string;
  stdout: string;
  stderr?: string;
  durationMs: number;
  exitCode?: number | null;
  signal?: string | null;
  linesCollected?: number;
};

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function isAgentStdoutDumpEnabled(): boolean {
  const raw = process.env["NIUBOT_DEBUG_AGENT_STDOUT"]?.trim().toLowerCase();
  return !!raw && TRUTHY.has(raw);
}

function formatTimestamp(): string {
  return dateTimeInTimeZone();
}

export function getAgentStdoutLogFilePath(niubotHome: string = resolveNiubotHome()): string {
  return join(niubotHome, "logs", `agent-stdout-${dateInTimeZone()}.log`);
}

function summarizeForLog(text: string | undefined, maxLen: number): string {
  if (text === undefined) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

/** 将一轮 agent 子进程的完整 stdout 追加到独立日志（需 NIUBOT_DEBUG_AGENT_STDOUT=1）。 */
export function dumpAgentStdout(input: AgentStdoutDumpInput): string | undefined {
  if (!isAgentStdoutDumpEnabled()) return undefined;

  const niubotHome = resolveNiubotHome();
  const logPath = getAgentStdoutLogFilePath(niubotHome);
  mkdirSync(join(niubotHome, "logs"), { recursive: true });

  const header = [
    "=".repeat(80),
    `${formatTimestamp()} backend=${input.backend} sessionId=${input.sessionId ?? "none"} reason=${input.reason}`,
    `cmd=${input.cmd} args=${JSON.stringify(input.args)}`,
    `cwd=${input.cwd ?? process.cwd()} durationMs=${input.durationMs} stdoutLength=${input.stdout.length}`,
    input.linesCollected != null ? `linesCollected=${input.linesCollected}` : undefined,
    input.stdinLength != null ? `stdinLength=${input.stdinLength} stdinPreview=${summarizeForLog(input.stdinPreview, 200)}` : undefined,
    input.exitCode != null || input.signal
      ? `exitCode=${input.exitCode ?? "null"} signal=${input.signal ?? "null"}`
      : undefined,
    input.stderr ? `stderrLength=${input.stderr.length}` : undefined,
    "-".repeat(80),
  ].filter((line): line is string => !!line);

  const body = [input.stdout];
  if (input.stderr?.trim()) {
    body.push("", "--- stderr ---", input.stderr);
  }
  body.push("=".repeat(80), "");

  appendFileSync(logPath, [...header, ...body].join("\n"), "utf8");
  return logPath;
}
