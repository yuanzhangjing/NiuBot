/**
 * Codex CLI backend — 通过 `codex exec` 命令驱动 agent。
 * 每个 session 一个独立子进程，JSON 事件流输出。
 */

import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CliAgentBackend, buildNiubotEnv, type BaseCliSession, type ParsedOutput } from "../cli-base.js";
import type { SessionConfig } from "../types.js";

interface CodexSession extends BaseCliSession {
  /** Codex 的 thread ID（首次调用后由 CLI 返回，用于 resume） */
  codexThreadId?: string;
  sessionLogPath?: string;
  sandboxMode: string;
  modelTier: SessionConfig["modelTier"];
}

export class CodexCliBackend extends CliAgentBackend<CodexSession> {
  private sandboxMode: string;
  private liteModel?: string;

  /** Codex 不支持 system prompt 注入 */
  readonly supportsSystemPrompt = false;

  constructor(sandboxMode = "danger-full-access", liteModel?: string) {
    super("codex");
    this.sandboxMode = sandboxMode;
    this.liteModel = liteModel;
  }

  command(): string {
    return "codex";
  }

  async checkAvailable(): Promise<void> {
    try {
      await this.exec("codex", ["--version"]);
      this.log.info("codex CLI found");
    } catch {
      throw new Error("codex CLI not found in PATH");
    }
  }

  buildSession(config: SessionConfig): CodexSession {
    return {
      workingDirectory: config.workingDirectory ?? process.cwd(),
      model: config.modelTier === "lite" ? (config.liteModel ?? this.liteModel) : undefined,
      importantContext: config.importantContext,
      codexThreadId: config.agentSessionId,
      extraEnv: buildNiubotEnv(config),
      cumulativeBytes: 0,
      compactCount: 0,
      jsonlOffset: 0,
      sandboxMode: this.sandboxMode,
      modelTier: config.modelTier,
    };
  }

  buildArgs(session: CodexSession, message: string): string[] {
    // resume 走不同的子命令
    if (session.codexThreadId) {
      const args = [
        "exec", "resume",
        session.codexThreadId,
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
      ];
      if (session.model) {
        args.push("-m", session.model);
      }
      // prompt 通过 stdin 传入
      return args;
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

    // prompt 通过 stdin 传入
    return args;
  }

  /** Codex exec 从 stdin 读取 prompt（不需要特殊包装） */
  buildStdin(message: string): string {
    return message;
  }

  parseOutput(stdout: string): ParsedOutput {
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

    return {
      text: lastAgentText.trim(),
      agentSessionId: threadId,
    };
  }

  updateSession(session: CodexSession, parsed: ParsedOutput): void {
    if (parsed.agentSessionId) {
      session.codexThreadId = parsed.agentSessionId;
    }
    if (session.codexThreadId) {
      const meta = this.scanJsonl(session);
      if (meta.model) parsed.model = meta.model;
      if (meta.contextTokens) parsed.contextTokens = meta.contextTokens;
      if (meta.contextWindow) parsed.contextWindow = meta.contextWindow;
    }
  }

  getAgentSessionId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.codexThreadId;
  }

  private scanJsonl(session: CodexSession): { model?: string; contextTokens?: number; contextWindow?: number } {
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
    if (!session.codexThreadId) return null;

    const sessionsRoot = resolve(homedir(), ".codex", "sessions");
    if (!existsSync(sessionsRoot)) return null;

    for (const year of readdirSync(sessionsRoot)) {
      const yearDir = join(sessionsRoot, year);
      for (const month of readdirSync(yearDir)) {
        const monthDir = join(yearDir, month);
        for (const day of readdirSync(monthDir)) {
          const dayDir = join(monthDir, day);
          const match = readdirSync(dayDir).find((name) => name.endsWith(`${session.codexThreadId}.jsonl`));
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
