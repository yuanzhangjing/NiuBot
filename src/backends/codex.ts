/**
 * Codex CLI backend plugin.
 * 通过 `codex exec` 命令驱动 agent，JSON 事件流输出。
 */

import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CliAgentBackend, buildNiubotEnv, type BaseCliSession, type ParsedOutput } from "../agent/cli-base.js";
import type { SessionConfig, ExecHooks } from "../agent/types.js";
import { readCodexTranscript } from "../session-archive/native-transcript.js";

interface CodexSession extends BaseCliSession {
  sessionLogPath?: string;
  sandboxMode: string;
}

export interface CodexBackendOptions {
  sandboxMode?: string;
}

export default class CodexBackend extends CliAgentBackend<CodexSession> {
  private sandboxMode: string;

  constructor(options: CodexBackendOptions = {}) {
    super("codex");
    this.sandboxMode = options.sandboxMode ?? "danger-full-access";
  }

  command(): string {
    return "codex";
  }

  buildSession(config: SessionConfig): CodexSession {
    return {
      workingDirectory: config.workingDirectory ?? process.cwd(),
      model: config.model,
      importantContext: config.importantContext,
      extraEnv: buildNiubotEnv(config),
      cumulativeBytes: 0,
      compactCount: 0,
      jsonlOffset: 0,
      sandboxMode: this.sandboxMode,
    };
  }

  buildInput(session: CodexSession, message: string): { args: string[]; stdin?: string } {
    // resume 走不同的子命令
    if (session.agentSessionId) {
      const args = [
        "exec", "resume",
        session.agentSessionId,
        "-",  // read prompt from stdin
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
      ];
      if (session.model) {
        args.push("-m", session.model);
      }
      return { args, stdin: message };
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

    return { args, stdin: message };
  }

  parseOutput(stdout: string, session: CodexSession): ParsedOutput {
    let threadId: string | undefined;
    let lastAgentText = "";
    let genericErrorMsg: string | undefined;
    let sawError = false;
    let stdoutContextTokens: number | undefined;

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
          error?: { message?: string };
          message?: string;
        };

        if (event.type === "thread.started" && event.thread_id) {
          threadId = event.thread_id;
        }

        if (event.type === "error" || event.type === "turn.failed") {
          sawError = true;
          const eventMessage = event.error?.message ?? event.message;
          genericErrorMsg ??= eventMessage;
        }

        if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
          lastAgentText = event.item.text;
        }

        if (event.usage) {
          const total = (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0);
          if (total > 0) stdoutContextTokens = total;
        }
      } catch { /* skip non-JSON lines */ }
    }

    // stdout 优先，JSONL 兜底
    let model: string | undefined;
    let contextTokens: number | undefined;
    let contextWindow: number | undefined;
    const resolvedThreadId = threadId ?? session.agentSessionId;
    if (resolvedThreadId) {
      session.agentSessionId = resolvedThreadId;
      const meta = this.scanJsonl(session);
      model = meta.model;
      contextTokens = meta.contextTokens ?? stdoutContextTokens;
      contextWindow = meta.contextWindow;
      const tokensSource = meta.contextTokens ? "jsonl" : stdoutContextTokens ? "stdout" : "none";
      this.log.info("parseOutput: done", {
        agentSessionId: resolvedThreadId, model, contextTokens,
        modelSource: meta.model ? "jsonl" : "none",
        tokensSource,
        stdoutContextTokens: stdoutContextTokens ?? null,
      });
    }

    return {
      text: lastAgentText.trim(),
      agentSessionId: resolvedThreadId,
      model,
      contextTokens,
      contextWindow,
      compactCount: session.compactCount > 0 ? session.compactCount : undefined,
      error: lastAgentText ? undefined : genericErrorMsg,
      failed: !lastAgentText && sawError,
    };
  }

  protected async loadSessionTranscript(session: CodexSession) {
    const file = this.getJsonlPath(session);
    if (!file || !session.agentSessionId) throw new Error("Codex session transcript not found");
    return { ...readCodexTranscript(file, session.agentSessionId), sources: [{ path: file, role: "session" }] };
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
                    total_tokens?: number;
                  };
                  model_context_window?: number;
                };
              };
            };

            if (entry.type === "turn_context") {
              model = entry.payload?.model ?? entry.payload?.collaboration_mode?.settings?.model ?? model;
            } else if (entry.type === "event_msg" && entry.payload?.type === "context_compacted") {
              session.compactCount++;
            } else if (entry.type === "event_msg" && entry.payload?.type === "token_count") {
              const lastUsage = entry.payload.info?.last_token_usage;
              const visibleTokens = lastUsage?.total_tokens
                ?? ((lastUsage?.input_tokens ?? 0) + (lastUsage?.output_tokens ?? 0));
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

  protected getExecHooks(session: CodexSession): ExecHooks {
    return {
      onLine: (line) => {
        try {
          const e = JSON.parse(line);
          if (e.type === "thread.started" && e.thread_id && !session.agentSessionId) {
            session.agentSessionId = e.thread_id;
          }
        } catch { /* non-JSON line */ }
      },
      isComplete: (line) => {
        try {
          const e = JSON.parse(line);
          // 一轮里可能先后出现 commentary 和 final 两条 agent_message。
          // 必须等 turn.completed，再由 parseOutput 取最后一条 agent_message。
          return e.type === "turn.completed";
        } catch { return false; }
      },
    };
  }

  protected probeSessionFileMtime(session: CodexSession): number | null {
    const jsonlPath = this.getJsonlPath(session);
    if (!jsonlPath) return null;
    try {
      return statSync(jsonlPath).mtimeMs;
    } catch {
      return null;
    }
  }

  private getJsonlPath(session: CodexSession): string | null {
    if (session.sessionLogPath && existsSync(session.sessionLogPath)) {
      return session.sessionLogPath;
    }
    if (!session.agentSessionId) return null;

    const codexHome = process.env["CODEX_HOME"]?.trim()
      ? resolve(process.env["CODEX_HOME"]!)
      : resolve(homedir(), ".codex");
    const sessionsRoot = join(codexHome, "sessions");
    if (!existsSync(sessionsRoot)) return null;

    for (const year of this.readDirectoryNames(sessionsRoot)) {
      const yearDir = join(sessionsRoot, year);
      for (const month of this.readDirectoryNames(yearDir)) {
        const monthDir = join(yearDir, month);
        for (const day of this.readDirectoryNames(monthDir)) {
          const dayDir = join(monthDir, day);
          const match = this.readFileNames(dayDir).find((name) => name.endsWith(`${session.agentSessionId}.jsonl`));
          if (match) {
            session.sessionLogPath = join(dayDir, match);
            return session.sessionLogPath;
          }
        }
      }
    }

    return null;
  }

  private readDirectoryNames(dir: string): string[] {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (err) {
      this.log.warn("getJsonlPath: directory scan failed", { dir, error: String(err) });
      return [];
    }
  }

  private readFileNames(dir: string): string[] {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() || entry.isSymbolicLink())
        .map((entry) => entry.name);
    } catch (err) {
      this.log.warn("getJsonlPath: file scan failed", { dir, error: String(err) });
      return [];
    }
  }
}
