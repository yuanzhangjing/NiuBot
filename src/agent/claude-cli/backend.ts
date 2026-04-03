/**
 * Claude Code CLI backend — 通过 `claude` 命令驱动 agent。
 * 每个 session 一个独立子进程，env 天然隔离。
 */

import { CliAgentBackend, buildNiubotEnv, type BaseCliSession, type ParsedOutput } from "../cli-base.js";
import type { SessionConfig } from "../types.js";

const DEFAULT_LITE_MODEL = "claude-haiku-4-5-20251001";

interface ClaudeSession extends BaseCliSession {
  /** Claude Code 的 session ID（首次调用后由 CLI 返回，用于 resume） */
  claudeSessionId?: string;
  permissionMode: string;
}

export class ClaudeCliBackend extends CliAgentBackend<ClaudeSession> {
  private permissionMode: string;
  private liteModel: string;

  readonly supportsSystemPrompt = true;

  constructor(permissionMode = "bypassPermissions", liteModel?: string) {
    super("claude-cli");
    this.permissionMode = permissionMode;
    this.liteModel = liteModel ?? DEFAULT_LITE_MODEL;
  }

  command(): string {
    return "claude";
  }

  async checkAvailable(): Promise<void> {
    try {
      await this.exec("claude", ["--version"]);
      this.log.info("claude CLI found");
    } catch {
      throw new Error("claude CLI not found in PATH");
    }
  }

  buildSession(config: SessionConfig): ClaudeSession {
    return {
      workingDirectory: config.workingDirectory ?? process.cwd(),
      model: config.modelTier === "lite" ? (config.liteModel ?? this.liteModel) : undefined,
      importantContext: config.importantContext,
      extraEnv: buildNiubotEnv(config),
      cumulativeBytes: 0,
      permissionMode: this.permissionMode,
    };
  }

  buildArgs(session: ClaudeSession, message: string): string[] {
    const args = [
      "-p", message,
      "--output-format", "json",
      "--permission-mode", session.permissionMode,
    ];

    if (session.model) {
      args.push("--model", session.model);
    }
    if (session.importantContext) {
      args.push("--append-system-prompt", session.importantContext);
    }
    if (session.claudeSessionId) {
      args.push("--resume", session.claudeSessionId);
    }

    return args;
  }

  parseOutput(stdout: string): ParsedOutput {
    try {
      const parsed = JSON.parse(stdout) as {
        result?: string;
        session_id?: string;
        is_error?: boolean;
      };
      return {
        text: (parsed.result ?? stdout).trim(),
        agentSessionId: parsed.session_id,
      };
    } catch {
      return { text: stdout.trim() };
    }
  }

  updateSession(session: ClaudeSession, parsed: ParsedOutput): void {
    if (parsed.agentSessionId) {
      session.claudeSessionId = parsed.agentSessionId;
    }
  }

  protected agentEnv(): Record<string, string> {
    return { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
  }
}
