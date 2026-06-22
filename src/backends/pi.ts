/**
 * Pi coding agent backend plugin.
 * 通过 `pi --mode json -p` 驱动 agent，JSON 事件流输出。
 */

import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CliAgentBackend, buildNiubotEnv, type BaseCliSession, type ParsedOutput } from "../agent/cli-base.js";
import type { AgentSessionActivity, SessionConfig, ExecHooks } from "../agent/types.js";
import { DEFAULT_LITE_MODELS } from "../config.js";

interface PiSession extends BaseCliSession {
  sessionLogPath?: string;
}

interface PiMessageContent {
  type?: string;
  text?: string;
}

interface PiAgentMessage {
  role?: string;
  content?: PiMessageContent[] | string;
  text?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export default class PiBackend extends CliAgentBackend<PiSession> {
  constructor() {
    super("pi");
  }

  command(): string {
    return "pi";
  }

  needsStableUserPrefix(): boolean {
    return false;
  }

  buildSession(config: SessionConfig): PiSession {
    const model = config.modelTier === "lite"
      ? (config.liteModel ?? DEFAULT_LITE_MODELS.pi ?? config.model)
      : config.model;

    return {
      workingDirectory: config.workingDirectory ?? process.cwd(),
      model,
      importantContext: config.importantContext,
      extraEnv: buildNiubotEnv(config),
      cumulativeBytes: 0,
      compactCount: 0,
      jsonlOffset: 0,
    };
  }

  buildInput(session: PiSession, message: string): { args: string[]; stdin?: string } {
    const args = [
      "--mode", "json",
      "-a",
      "-p",
    ];

    if (session.model) {
      args.push("--model", session.model);
    }
    if (session.importantContext) {
      args.push("--append-system-prompt", session.importantContext);
    }
    if (session.agentSessionId) {
      args.push("--session", session.agentSessionId);
    }

    args.push(message);
    return { args };
  }

  protected isProbeError(err: any): boolean {
    const stderr = err.stderr as string | undefined;
    return !!(stderr?.includes("model") || stderr?.includes("Model") || stderr?.includes("provider"));
  }

  protected getExecHooks(session: PiSession): ExecHooks {
    return {
      onLine: (line) => {
        try {
          const event = JSON.parse(line) as { type?: string; id?: string };
          if (event.type === "session" && event.id && !session.agentSessionId) {
            session.agentSessionId = event.id;
            session.sessionLogPath = undefined;
          }
        } catch { /* non-JSON line */ }
      },
      isComplete: (line) => {
        try {
          const event = JSON.parse(line) as { type?: string };
          return event.type === "agent_end";
        } catch {
          return false;
        }
      },
    };
  }

  parseOutput(stdout: string, session: PiSession): ParsedOutput {
    let agentSessionId = session.agentSessionId;
    let lastAssistantText = "";
    let model: string | undefined = session.model;
    let contextTokens: number | undefined;
    let genericErrorMsg: string | undefined;
    let sawError = false;

    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          id?: string;
          message?: PiAgentMessage;
          messages?: PiAgentMessage[];
          errorMessage?: string;
          finalError?: string;
          success?: boolean;
        };

        if (event.type === "session" && event.id) {
          agentSessionId = event.id;
        }

        if (event.type === "message_end" || event.type === "turn_end") {
          const msg = event.message;
          if (msg?.role === "assistant") {
            const text = extractPiMessageText(msg);
            if (text) lastAssistantText = text;
            if (msg.model) model = msg.model;
            const tokens = estimatePiContextTokens(msg.usage);
            if (tokens > 0) contextTokens = tokens;
            const assistantError = extractPiAssistantError(msg);
            if (assistantError) {
              sawError = true;
              genericErrorMsg ??= assistantError;
            }
          }
        }

        if (event.type === "agent_end") {
          const messages = event.messages ?? [];
          for (const msg of messages) {
            if (msg.role !== "assistant") continue;
            const text = extractPiMessageText(msg);
            if (text) lastAssistantText = text;
            if (msg.model) model = msg.model;
            const tokens = estimatePiContextTokens(msg.usage);
            if (tokens > 0) contextTokens = tokens;
            const assistantError = extractPiAssistantError(msg);
            if (assistantError) {
              sawError = true;
              genericErrorMsg ??= assistantError;
            }
          }
        }

        if (event.type === "compaction_end" && event.errorMessage) {
          sawError = true;
          genericErrorMsg ??= event.errorMessage;
        }

        if (event.type === "auto_retry_end" && event.success === false && event.finalError) {
          sawError = true;
          genericErrorMsg ??= event.finalError;
        }
      } catch { /* skip malformed lines */ }
    }

    if (agentSessionId) {
      session.agentSessionId = agentSessionId;
      const meta = this.scanJsonl(session);
      if (meta.model) model = meta.model;
      if (meta.contextTokens !== undefined) contextTokens = meta.contextTokens;
    }

    return {
      text: lastAssistantText.trim(),
      agentSessionId,
      model,
      contextTokens,
      compactCount: session.compactCount > 0 ? session.compactCount : undefined,
      error: lastAssistantText ? undefined : genericErrorMsg,
      failed: !lastAssistantText && sawError,
    };
  }

  protected refreshActivity(sessionId: string, activity: AgentSessionActivity): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const jsonlPath = this.getJsonlPath(session);
    if (!jsonlPath) return;
    try {
      const size = statSync(jsonlPath).size;
      if (size === 0) return;
      const lines = this.readLastLines(jsonlPath, size, 3);
      if (lines.length > 0) {
        activity.recentLines = lines;
      }
    } catch { /* ignore */ }
  }

  protected probeSessionFileMtime(session: PiSession): number | null {
    const jsonlPath = this.getJsonlPath(session);
    if (!jsonlPath) return null;
    try {
      return statSync(jsonlPath).mtimeMs;
    } catch {
      return null;
    }
  }

  private scanJsonl(session: PiSession): { model?: string; contextTokens?: number } {
    const jsonlPath = this.getJsonlPath(session);
    if (!jsonlPath) return {};

    let model: string | undefined;
    let contextTokens: number | undefined;

    try {
      const stat = statSync(jsonlPath);
      const fileSize = stat.size;
      if (fileSize <= session.jsonlOffset) return {};

      const fd = openSync(jsonlPath, "r");
      try {
        const readLen = fileSize - session.jsonlOffset;
        const buf = Buffer.alloc(readLen);
        readSync(fd, buf, 0, readLen, session.jsonlOffset);
        session.jsonlOffset = fileSize;

        for (const line of buf.toString("utf-8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as {
              type?: string;
              message?: PiAgentMessage;
            };

            if (entry.type === "compaction") {
              session.compactCount++;
            }

            const msg = entry.message;
            if (entry.type === "message" && msg?.role === "assistant") {
              if (msg.model) model = msg.model;
              const tokens = estimatePiContextTokens(msg.usage);
              if (tokens > 0) contextTokens = tokens;
            }
          } catch { /* skip malformed lines */ }
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      return {};
    }

    return { model, contextTokens };
  }

  private getJsonlPath(session: PiSession): string | null {
    if (session.sessionLogPath && existsSync(session.sessionLogPath)) {
      return session.sessionLogPath;
    }
    if (!session.agentSessionId) return null;

    const sessionsRoot = join(
      homedir(),
      ".pi",
      "agent",
      "sessions",
      encodePiSessionDir(session.workingDirectory),
    );
    if (!existsSync(sessionsRoot)) return null;

    try {
      const match = readdirSync(sessionsRoot)
        .filter((name) => name.endsWith(".jsonl"))
        .find((name) => name.endsWith(`_${session.agentSessionId}.jsonl`) || name.includes(session.agentSessionId!));
      if (!match) return null;
      session.sessionLogPath = join(sessionsRoot, match);
      return session.sessionLogPath;
    } catch (err) {
      this.log.warn("getJsonlPath: directory scan failed", { sessionsRoot, error: String(err) });
      return null;
    }
  }

  private readLastLines(filePath: string, fileSize: number, count: number): string[] {
    const CHUNK = 65536;
    const fd = openSync(filePath, "r");
    try {
      let offset = fileSize;
      let collected = "";
      while (offset > 0) {
        const readSize = Math.min(CHUNK, offset);
        offset -= readSize;
        const buf = Buffer.alloc(readSize);
        readSync(fd, buf, 0, readSize, offset);
        collected = buf.toString("utf-8") + collected;
        const lines = collected.split("\n").filter((l) => l.trim());
        if (lines.length > count) return lines.slice(-count);
      }
      return collected.split("\n").filter((l) => l.trim()).slice(-count);
    } finally {
      closeSync(fd);
    }
  }
}

export function encodePiSessionDir(cwd: string): string {
  const resolved = resolve(cwd);
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function extractPiMessageText(message: PiAgentMessage): string {
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!)
    .join("");
}

function estimatePiContextTokens(usage?: PiAgentMessage["usage"]): number {
  if (!usage) return 0;
  return (usage.input ?? 0) + (usage.output ?? 0);
}

function extractPiAssistantError(message: PiAgentMessage): string | undefined {
  if (message.stopReason !== "error" && !message.errorMessage) return undefined;
  const raw = message.errorMessage?.trim();
  if (!raw) return message.stopReason === "error" ? "Pi agent 执行失败" : undefined;
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const payload = JSON.parse(raw.slice(jsonStart)) as {
        error?: { message?: string };
        message?: string;
      };
      const detail = payload.error?.message ?? payload.message;
      if (detail) return detail;
    } catch { /* use raw below */ }
  }
  return raw.replace(/^\d+\s+/, "");
}
