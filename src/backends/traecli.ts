/**
 * Trae CLI backend plugin.
 * 通过 `traecli -p` 命令驱动 agent，JSON 输出。
 */

import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliAgentBackend, buildNiubotEnv, type BaseCliSession, type ParsedOutput } from "../agent/cli-base.js";
import type { SessionConfig } from "../agent/types.js";
import { DEFAULT_LITE_MODELS } from "../config.js";

interface TraeCliSession extends BaseCliSession {
  sessionLogPath?: string;
}

export default class TraeCliBackend extends CliAgentBackend<TraeCliSession> {
  readonly supportsSystemPrompt = false;

  constructor() {
    super("traecli");
  }

  command(): string {
    return "traecli";
  }

  buildSession(config: SessionConfig): TraeCliSession {
    return {
      workingDirectory: config.workingDirectory ?? process.cwd(),
      model: config.modelTier === "lite" ? (config.liteModel ?? DEFAULT_LITE_MODELS.traecli ?? config.model) : config.model,
      importantContext: config.importantContext,
      extraEnv: buildNiubotEnv(config),
      cumulativeBytes: 0,
      compactCount: 0,
      jsonlOffset: 0,
    };
  }

  buildInput(session: TraeCliSession, message: string): { args: string[]; stdin?: string } {
    const args = ["-p", "--json", "--yolo"];
    if (session.model) args.push("-c", `model.name=${session.model}`);
    if (session.agentSessionId) args.push(`--resume=${session.agentSessionId}`);
    args.push("--", message);
    return { args };
  }

  parseOutput(stdout: string, session: TraeCliSession): ParsedOutput {
    try {
      const data = JSON.parse(stdout) as {
        message?: {
          content?: string;
          response_meta?: {
            usage?: {
              total_tokens?: number;
              prompt_tokens?: number;
            };
          };
          extra?: {
            _source_model?: string;
          };
        };
        session_id?: string;
      };

      const result: ParsedOutput = {
        text: data.message?.content ?? "",
      };

      const resolvedSessionId = data.session_id ?? session.agentSessionId;
      if (resolvedSessionId) {
        result.agentSessionId = resolvedSessionId;
        session.agentSessionId = resolvedSessionId;
      }

      const usage = data.message?.response_meta?.usage;
      if (usage?.total_tokens !== undefined) {
        result.contextTokens = usage.total_tokens;
      } else if (usage?.prompt_tokens !== undefined) {
        result.contextTokens = usage.prompt_tokens;
      }

      if (data.message?.extra?._source_model) {
        result.model = data.message.extra._source_model;
      }

      const meta = this.scanJsonl(session);
      if (meta.model !== undefined) result.model = meta.model;
      if (meta.contextTokens !== undefined) result.contextTokens = meta.contextTokens;
      if (session.compactCount > 0) result.compactCount = session.compactCount;

      // Coco CLI bug workaround: exit 0 + empty content when LLM API errors.
      // The error is only in events.jsonl agent_end.error_message.
      if (!result.text && meta.errorMessage) {
        result.text = `（Coco 错误）${meta.errorMessage}`;
      }

      return result;
    } catch {
      return { text: stdout.trim() };
    }
  }

  protected probeSessionFileMtime(session: TraeCliSession): number | null {
    const jsonlPath = this.getJsonlPath(session);
    if (!jsonlPath) return null;
    try {
      return statSync(jsonlPath).mtimeMs;
    } catch {
      return null;
    }
  }

  protected probeSessionLastLine(session: TraeCliSession): string | null {
    const jsonlPath = this.getJsonlPath(session);
    if (!jsonlPath) return null;
    try {
      const stat = statSync(jsonlPath);
      const tailSize = Math.min(stat.size, 2048);
      if (tailSize === 0) return null;
      const fd = openSync(jsonlPath, "r");
      try {
        const buf = Buffer.alloc(tailSize);
        readSync(fd, buf, 0, tailSize, stat.size - tailSize);
        const lines = buf.toString("utf-8").split("\n").filter((l) => l.trim());
        return lines.length > 0 ? lines[lines.length - 1]! : null;
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  private scanJsonl(session: TraeCliSession): { model?: string; contextTokens?: number; errorMessage?: string } {
    const jsonlPath = this.getJsonlPath(session);
    if (!jsonlPath) return {};

    let model: string | undefined;
    let contextTokens: number | undefined;
    let errorMessage: string | undefined;

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
          if (!line) continue;
          try {
            const entry = JSON.parse(line) as {
              compaction_end?: unknown;
              agent_end?: {
                error_message?: string;
              };
              message?: {
                message?: {
                  role?: string;
                  response_meta?: {
                    usage?: {
                      total_tokens?: number;
                    };
                  };
                  extra?: {
                    _source_model?: string;
                  };
                };
              };
            };

            if (entry.compaction_end !== undefined) {
              session.compactCount++;
            }

            if (entry.agent_end?.error_message) {
              errorMessage = entry.agent_end.error_message;
            }

            const msg = entry.message?.message;
            if (msg?.role === "assistant" && msg.response_meta?.usage?.total_tokens !== undefined) {
              contextTokens = msg.response_meta.usage.total_tokens;
            }
            if (msg?.extra?._source_model) {
              model = msg.extra._source_model;
            }
          } catch { /* skip malformed lines */ }
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      return {};
    }

    return { model, contextTokens, errorMessage };
  }

  private getJsonlPath(session: TraeCliSession): string | null {
    if (session.sessionLogPath && existsSync(session.sessionLogPath)) {
      return session.sessionLogPath;
    }
    if (!session.agentSessionId) return null;

    const cacheBase = process.platform === "darwin"
      ? join(homedir(), "Library", "Caches", "coco")
      : join(process.env["XDG_CACHE_HOME"] || join(homedir(), ".cache"), "coco");

    const jsonlPath = join(cacheBase, "sessions", session.agentSessionId, "events.jsonl");
    if (existsSync(jsonlPath)) {
      session.sessionLogPath = jsonlPath;
      return jsonlPath;
    }
    return null;
  }
}
