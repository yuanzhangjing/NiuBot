/**
 * Codex CLI backend plugin.
 * 通过 `codex exec` 命令驱动 agent，JSON 事件流输出。
 */

import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CliAgentBackend, buildNiubotEnv, type BaseCliSession, type ParsedOutput } from "../agent/cli-base.js";
import type { SessionConfig } from "../agent/types.js";

interface CodexSession extends BaseCliSession {
  sessionLogPath?: string;
  sandboxMode: string;
  modelTier: SessionConfig["modelTier"];
}

export interface CodexBackendOptions {
  liteModel?: string;
  sandboxMode?: string;
}

export default class CodexBackend extends CliAgentBackend<CodexSession> {
  private sandboxMode: string;
  private liteModel?: string;

  /** Codex 不支持 system prompt 注入 */
  readonly supportsSystemPrompt = false;

  constructor(options: CodexBackendOptions = {}) {
    super("codex");
    this.sandboxMode = options.sandboxMode ?? "danger-full-access";
    this.liteModel = options.liteModel;
  }

  command(): string {
    return "codex";
  }

  buildSession(config: SessionConfig): CodexSession {
    return {
      workingDirectory: config.workingDirectory ?? process.cwd(),
      model: config.modelTier === "lite" ? (config.liteModel ?? this.liteModel) : undefined,
      importantContext: config.importantContext,
      extraEnv: buildNiubotEnv(config),
      cumulativeBytes: 0,
      compactCount: 0,
      jsonlOffset: 0,
      sandboxMode: this.sandboxMode,
      modelTier: config.modelTier,
    };
  }

  buildInput(session: CodexSession, message: string): { args: string[]; input?: string } {
    // resume 走不同的子命令
    if (session.agentSessionId) {
      const args = [
        "exec", "resume",
        session.agentSessionId,
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
      ];
      if (session.model) {
        args.push("-m", session.model);
      }
      return { args };
    }

    const args = [
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-C", session.workingDirectory,
    ];

    if (session.model) {
      args.push("-m", session.model);
    }

    return { args, input: message };
  }

  parseOutput(stdout: string, session: CodexSession): ParsedOutput {
    let threadId: string | undefined;
    let lastAgentText = "";

    for (const line of stdout.split("\n")) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          thread_id?: string;
          item?: {
            type?: string;
            text?: string;
          };
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cached_input_tokens?: number;
          };
        };

        if (event.type === "thread.started" && event.thread_id) {
          threadId = event.thread_id;
        }

        // 取最后一条 agent_message 的 text 作为回复
        if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
          lastAgentText = event.item.text;
        }
      } catch { /* skip non-JSON lines */ }
    }

    // 增量扫描 JSONL，补充 model/token/compact 信息
    let model: string | undefined;
    let contextTokens: number | undefined;
    let contextWindow: number | undefined;
    if (threadId) {
      session.agentSessionId = threadId;
      const meta = this.scanJsonl(session);
      model = meta.model;
      contextTokens = meta.contextTokens;
      contextWindow = meta.contextWindow;
    }

    return {
      text: lastAgentText.trim(),
      agentSessionId: threadId,
      model,
      contextTokens,
      contextWindow,
      compactCount: session.compactCount > 0 ? session.compactCount : undefined,
    };
  }

  private scanJsonl(session: CodexSession): {
    model?: string;
    contextTokens?: number;
    contextWindow?: number;
  } {
    const jsonlPath = this.getJsonlPath(session);
    if (!jsonlPath) return {};

    let model: string | undefined;
    let contextTokens: number | undefined;
    let contextWindow: number | undefined;

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
              type?: string;
              payload?: {
                model?: string;
                collaboration_mode?: {
                  settings?: {
                    model?: string;
                  };
                };
                type?: string;
                info?: {
                  last_token_usage?: {
                    input_tokens?: number;
                    output_tokens?: number;
                  };
                  model_context_window?: number;
                };
              };
            };

            if (entry.type === "turn_context") {
              model = entry.payload?.model ?? entry.payload?.collaboration_mode?.settings?.model ?? model;
            } else if (entry.type === "compacted") {
              session.compactCount++;
            } else if (entry.type === "event_msg" && entry.payload?.type === "token_count") {
              const lastUsage = entry.payload.info?.last_token_usage;
              const visibleTokens = (lastUsage?.input_tokens ?? 0) + (lastUsage?.output_tokens ?? 0);
              if (visibleTokens > 0) {
                contextTokens = visibleTokens;
              }
              contextWindow = entry.payload.info?.model_context_window ?? contextWindow;
            }
          } catch { /* skip malformed lines */ }
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      return {};
    }

    return { model, contextTokens, contextWindow };
  }

  private getJsonlPath(session: CodexSession): string | null {
    if (session.sessionLogPath && existsSync(session.sessionLogPath)) {
      return session.sessionLogPath;
    }
    if (!session.agentSessionId) return null;

    const sessionsRoot = resolve(homedir(), ".codex", "sessions");
    if (!existsSync(sessionsRoot)) return null;

    for (const year of readdirSync(sessionsRoot)) {
      const yearDir = join(sessionsRoot, year);
      for (const month of readdirSync(yearDir)) {
        const monthDir = join(yearDir, month);
        for (const day of readdirSync(monthDir)) {
          const dayDir = join(monthDir, day);
          const match = readdirSync(dayDir).find((name) => name.endsWith(`${session.agentSessionId}.jsonl`));
          if (match) {
            session.sessionLogPath = join(dayDir, match);
            return session.sessionLogPath;
          }
        }
      }
    }

    return null;
  }
}
