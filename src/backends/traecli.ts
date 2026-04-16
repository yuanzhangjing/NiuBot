/**
 * Trae CLI backend plugin.
 * 通过 `traecli -p` 命令驱动 agent，JSON 输出。
 */

import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliAgentBackend, buildNiubotEnv, type BaseCliSession, type ParsedOutput } from "../agent/cli-base.js";
import type { SessionConfig } from "../agent/types.js";

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
      model: config.modelTier === "lite" ? (config.liteModel ?? config.model) : config.model,
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
    args.push(message);
    if (session.agentSessionId) args.push("--resume", session.agentSessionId);
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

      return result;
    } catch {
      return { text: stdout.trim() };
    }
  }

  private scanJsonl(session: TraeCliSession): { model?: string; contextTokens?: number } {
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
          if (!line) continue;
          try {
            const entry = JSON.parse(line) as {
              compaction_end?: unknown;
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

    return { model, contextTokens };
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
