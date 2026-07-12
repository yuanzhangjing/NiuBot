/**
 * Grok Build CLI backend.
 *
 * Grok 的 headless stdout 会混入中间回复，因此最终文本从本地 session
 * 的 chat_history.jsonl 获取；context 与 compact 统计来自 signals.json。
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CliAgentBackend, buildNiubotEnv, type BaseCliSession, type ParsedOutput } from "../agent/cli-base.js";
import type { AgentSessionActivity, ExecHooks, SessionConfig } from "../agent/types.js";

interface GrokSession extends BaseCliSession {
  /** 首轮使用 --session-id，后续使用 --resume。 */
  isNewSession: boolean;
  /** events.jsonl 的增量读取位置。 */
  eventsOffset: number;
  /** 文件写入到半行或半个 UTF-8 字符时保留到下次解析。 */
  eventsRemainder: Buffer;
  /** 尚未结束的工具调用数量。 */
  activeToolCount: number;
  /** 本轮发出前 chat_history.jsonl 的字节位置。 */
  historyOffset: number;
}

type GrokSignals = {
  primaryModelId?: unknown;
  contextTokensUsed?: unknown;
  contextWindowTokens?: unknown;
  compactionCount?: unknown;
};

export default class GrokBackend extends CliAgentBackend<GrokSession> {
  constructor() {
    super("grok");
  }

  needsStableUserPrefix(): boolean {
    return false;
  }

  command(): string {
    return "grok";
  }

  protected argsForLog(args: string[]): string[] {
    const result = [...args];
    for (let index = 0; index < result.length - 1; index++) {
      if (result[index] === "-p" || result[index] === "--append-system-prompt") {
        result[index + 1] = "[REDACTED]";
        index++;
      }
    }
    return result;
  }

  buildSession(config: SessionConfig): GrokSession {
    return {
      workingDirectory: config.workingDirectory ?? process.cwd(),
      model: config.modelTier === "lite" ? (config.liteModel ?? config.model) : config.model,
      importantContext: config.importantContext,
      agentSessionId: config.agentSessionId ?? randomUUID(),
      isNewSession: !config.agentSessionId,
      extraEnv: buildNiubotEnv(config),
      cumulativeBytes: 0,
      compactCount: 0,
      jsonlOffset: 0,
      eventsOffset: 0,
      eventsRemainder: Buffer.alloc(0),
      activeToolCount: 0,
      historyOffset: 0,
    };
  }

  buildInput(session: GrokSession, message: string): { args: string[]; stdin?: string } {
    session.historyOffset = this.getHistorySize(session);
    session.eventsOffset = this.getEventsSize(session);
    session.eventsRemainder = Buffer.alloc(0);
    session.activeToolCount = 0;

    // 首轮可能在 Grok 创建 session 后中断，没有来得及收到 end 事件。
    // 目录已经存在时必须 resume，否则重复 --session-id 会直接失败。
    if (session.isNewSession && this.sessionExists(session)) {
      session.isNewSession = false;
    }

    const args = [
      "--no-auto-update",
      "--always-approve",
      "--output-format", "streaming-json",
    ];

    if (session.isNewSession) {
      args.push("--session-id", session.agentSessionId!);
    } else {
      args.push("--resume", session.agentSessionId!);
    }

    args.push("--cwd", session.workingDirectory);
    if (session.isNewSession && session.importantContext) {
      args.push("--append-system-prompt", session.importantContext);
    }
    if (session.model) {
      args.push("-m", session.model);
    }
    args.push("-p", message);

    return { args };
  }

  parseOutput(stdout: string, session: GrokSession): ParsedOutput {
    let lastText = "";
    let error: string | undefined;
    let completed = false;

    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          data?: string;
          sessionId?: string;
          error?: { message?: string } | string;
          message?: string;
        };
        if (event.type === "end" && event.sessionId) {
          session.agentSessionId = event.sessionId;
          session.isNewSession = false;
          completed = true;
        } else if (event.type === "text" && typeof event.data === "string") {
          lastText += event.data;
        } else if (event.type === "error") {
          error ??= typeof event.error === "string"
            ? event.error
            : event.error?.message ?? event.message;
        }
      } catch { /* skip non-JSON output */ }
    }

    const historyText = this.readLastAssistantText(session);
    const signals = this.readSignals(session);
    const model = stringValue(signals?.primaryModelId) ?? session.model;
    const contextTokens = numberValue(signals?.contextTokensUsed);
    const contextWindow = numberValue(signals?.contextWindowTokens);
    const compactCount = numberValue(signals?.compactionCount);
    if (compactCount !== undefined) session.compactCount = compactCount;

    const responseSource = error ? "error" : historyText ? "chat_history" : lastText ? "stdout" : "none";
    this.log.info("Grok parseOutput: done", {
      agentSessionId: session.agentSessionId ?? null,
      completed,
      responseSource,
      model: model ?? null,
      contextTokens: contextTokens ?? null,
      contextWindow: contextWindow ?? null,
      compactCount: session.compactCount || 0,
      signalsLoaded: Boolean(signals),
    });
    if (completed && !signals) {
      this.log.warn("Grok signals unavailable after completion", {
        agentSessionId: session.agentSessionId ?? null,
      });
    }

    return {
      text: error ? "" : historyText ?? lastText.trim(),
      agentSessionId: session.agentSessionId,
      model,
      contextTokens,
      contextWindow,
      compactCount: session.compactCount || undefined,
      error,
      failed: Boolean(error),
    };
  }

  protected getExecHooks(session: GrokSession): ExecHooks {
    return {
      onLine: (line) => {
        try {
          const event = JSON.parse(line) as { type?: string; sessionId?: string };
          if (event.type === "end" && event.sessionId) {
            session.agentSessionId = event.sessionId;
            session.isNewSession = false;
          }
        } catch { /* non-JSON line */ }
      },
      isComplete: (line) => {
        try { return (JSON.parse(line) as { type?: string }).type === "end"; }
        catch { return false; }
      },
    };
  }

  protected refreshActivity(sessionId: string, activity: AgentSessionActivity): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const eventsPath = this.getSessionFile(session, "events.jsonl");
    if (!eventsPath) return;

    try {
      const stat = statSync(eventsPath);
      if (stat.size < session.eventsOffset) {
        session.eventsOffset = 0;
        session.eventsRemainder = Buffer.alloc(0);
        session.activeToolCount = 0;
        activity.executingTool = false;
      }
      if (stat.size === session.eventsOffset) return;

      const chunk = readFileRangeSync(eventsPath, session.eventsOffset, stat.size);
      const bytesRead = chunk.length;
      session.eventsOffset += bytesRead;
      const content = Buffer.concat([session.eventsRemainder, chunk]);
      const lines: string[] = [];
      let lineStart = 0;
      let newline = content.indexOf(0x0a, lineStart);
      while (newline !== -1) {
        lines.push(content.subarray(lineStart, newline).toString("utf-8"));
        lineStart = newline + 1;
        newline = content.indexOf(0x0a, lineStart);
      }
      session.eventsRemainder = Buffer.from(content.subarray(lineStart));

      for (const line of lines) {
        if (!line) continue;
        try {
          const event = JSON.parse(line) as { type?: string; ts?: string; tool_name?: string; phase?: string };
          const eventTime = event.ts ? Date.parse(event.ts) : Number.NaN;
          if (Number.isFinite(eventTime)) {
            activity.lastActiveAt = Math.max(activity.lastActiveAt, eventTime);
          }

          if (event.type === "turn_started") {
            session.activeToolCount = 0;
            activity.executingTool = false;
          } else if (event.type === "turn_ended") {
            session.activeToolCount = 0;
            activity.executingTool = false;
            activity.compacting = false;
          } else if (event.type === "tool_started") {
            session.activeToolCount++;
            this.pushRecentLine(activity, `tool_started: ${event.tool_name ?? "unknown"}`);
          } else if (event.type === "tool_completed") {
            session.activeToolCount = Math.max(0, session.activeToolCount - 1);
            this.pushRecentLine(activity, `tool_completed: ${event.tool_name ?? "unknown"}`);
          } else if (event.type === "phase_changed" && event.phase) {
            this.pushRecentLine(activity, `phase: ${event.phase}`);
            if (event.phase === "compacting") activity.compacting = true;
            if (event.phase === "streaming_text" || event.phase === "waiting_for_model") activity.compacting = false;
          }
        } catch { /* skip malformed event */ }
      }
      activity.executingTool = session.activeToolCount > 0;
    } catch (err) {
      this.log.warn("Grok event scan failed", { sessionId, error: String(err) });
    }
  }

  protected probeSessionFileMtime(session: GrokSession): number | null {
    const paths = ["events.jsonl", "updates.jsonl", "chat_history.jsonl", "signals.json"]
      .map((name) => this.getSessionFile(session, name))
      .filter((file): file is string => file !== null);
    let latest: number | null = null;
    for (const file of paths) {
      try {
        const mtime = statSync(file).mtimeMs;
        latest = latest === null ? mtime : Math.max(latest, mtime);
      } catch { /* file may not have been created yet */ }
    }
    return latest;
  }

  private getSessionDir(session: GrokSession): string | null {
    if (!session.agentSessionId) return null;
    return join(
      homedir(),
      ".grok",
      "sessions",
      encodeURIComponent(resolve(session.workingDirectory)),
      session.agentSessionId,
    );
  }

  private getSessionFile(session: GrokSession, name: string): string | null {
    const dir = this.getSessionDir(session);
    if (!dir) return null;
    const file = join(dir, name);
    return existsSync(file) ? file : null;
  }

  private sessionExists(session: GrokSession): boolean {
    const dir = this.getSessionDir(session);
    return dir !== null && existsSync(dir);
  }

  private readLastAssistantText(session: GrokSession): string | undefined {
    const historyPath = this.getSessionFile(session, "chat_history.jsonl");
    if (!historyPath) return undefined;
    try {
      const size = statSync(historyPath).size;
      const start = session.historyOffset <= size ? session.historyOffset : 0;
      const content = readFileRangeSync(historyPath, start, size).toString("utf-8");
      const lines = content.split("\n");
      for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index];
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as { type?: string; content?: unknown };
          if (entry.type === "assistant" && typeof entry.content === "string" && entry.content.trim()) {
            return entry.content.trim();
          }
        } catch { /* skip malformed entry */ }
      }
    } catch (err) {
      this.log.warn("Grok chat history scan failed", { error: String(err) });
    }
    return undefined;
  }

  private getHistorySize(session: GrokSession): number {
    const historyPath = this.getSessionFile(session, "chat_history.jsonl");
    if (!historyPath) return 0;
    try {
      return statSync(historyPath).size;
    } catch {
      return 0;
    }
  }

  private getEventsSize(session: GrokSession): number {
    const eventsPath = this.getSessionFile(session, "events.jsonl");
    if (!eventsPath) return 0;
    try {
      return statSync(eventsPath).size;
    } catch {
      return 0;
    }
  }

  private readSignals(session: GrokSession): GrokSignals | undefined {
    const signalsPath = this.getSessionFile(session, "signals.json");
    if (!signalsPath) return undefined;
    try {
      return JSON.parse(readFileSync(signalsPath, "utf-8")) as GrokSignals;
    } catch (err) {
      this.log.warn("Grok signals read failed", { error: String(err) });
      return undefined;
    }
  }

  private pushRecentLine(activity: AgentSessionActivity, line: string): void {
    activity.recentLines.push(line);
    if (activity.recentLines.length > 3) activity.recentLines.shift();
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readFileRangeSync(file: string, start: number, end: number): Buffer {
  const length = Math.max(0, end - start);
  if (length === 0) return Buffer.alloc(0);

  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(file, "r");
  let total = 0;
  try {
    while (total < length) {
      const bytesRead = readSync(fd, buffer, total, length - total, start + total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
  } finally {
    closeSync(fd);
  }
  return buffer.subarray(0, total);
}
