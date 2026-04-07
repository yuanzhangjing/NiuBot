/**
 * Codex CLI backend — 通过 `codex exec` 命令驱动 agent。
 * 每个 session 一个独立子进程，JSON 事件流输出。
 */

import { CliAgentBackend, buildNiubotEnv, type BaseCliSession, type ParsedOutput } from "../cli-base.js";
import type { SessionConfig } from "../types.js";

const DEFAULT_LITE_MODEL = "gpt-4.1-mini";

interface CodexSession extends BaseCliSession {
  /** Codex 的 thread ID（首次调用后由 CLI 返回，用于 resume） */
  codexThreadId?: string;
  sandboxMode: string;
}

export class CodexCliBackend extends CliAgentBackend<CodexSession> {
  private sandboxMode: string;
  private liteModel: string;

  /** Codex 不支持 system prompt 注入 */
  readonly supportsSystemPrompt = false;

  constructor(sandboxMode = "danger-full-access", liteModel?: string) {
    super("codex");
    this.sandboxMode = sandboxMode;
    this.liteModel = liteModel ?? DEFAULT_LITE_MODEL;
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
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;

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

        // usage 在 turn.completed 事件中
        if (event.type === "turn.completed" && event.usage) {
          inputTokens += event.usage.input_tokens ?? 0;
          outputTokens += event.usage.output_tokens ?? 0;
          cachedTokens += event.usage.cached_input_tokens ?? 0;
        }
      } catch { /* skip non-JSON lines */ }
    }

    const totalTokens = inputTokens + outputTokens + cachedTokens;

    return {
      text: lastAgentText.trim(),
      agentSessionId: threadId,
      contextTokens: totalTokens > 0 ? totalTokens : undefined,
    };
  }

  updateSession(session: CodexSession, parsed: ParsedOutput): void {
    if (parsed.agentSessionId) {
      session.codexThreadId = parsed.agentSessionId;
    }
  }

  getAgentSessionId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.codexThreadId;
  }
}
