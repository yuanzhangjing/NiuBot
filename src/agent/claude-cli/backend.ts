/**
 * Claude Code CLI backend — 通过 `claude` 命令驱动 agent。
 * 每个 session 一个独立子进程，env 天然隔离。
 */

import { statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
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
      claudeSessionId: config.agentSessionId,
      extraEnv: buildNiubotEnv(config),
      cumulativeBytes: 0,
      compactCount: 0,
      jsonlOffset: 0,
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
        usage?: {
          input_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
          output_tokens?: number;
        };
        modelUsage?: Record<string, unknown>;
      };

      // context tokens = input + cache_creation + cache_read + output
      let contextTokens: number | undefined;
      if (parsed.usage) {
        const u = parsed.usage;
        const total = (u.input_tokens ?? 0)
          + (u.cache_creation_input_tokens ?? 0)
          + (u.cache_read_input_tokens ?? 0)
          + (u.output_tokens ?? 0);
        if (total > 0) contextTokens = total;
      }

      // model name from modelUsage keys
      const model = parsed.modelUsage ? Object.keys(parsed.modelUsage)[0] : undefined;

      return {
        text: (parsed.result ?? stdout).trim(),
        agentSessionId: parsed.session_id,
        contextTokens,
        model,
      };
    } catch {
      return { text: stdout.trim() };
    }
  }

  updateSession(session: ClaudeSession, parsed: ParsedOutput): void {
    if (parsed.agentSessionId) {
      session.claudeSessionId = parsed.agentSessionId;
    }
    // 增量扫描 JSONL，更新 compactCount
    if (session.claudeSessionId) {
      this.scanCompactCount(session);
    }
  }

  /**
   * 增量扫描 Claude Code session JSONL，统计新增的 compact_boundary 事件。
   * 从 session.jsonlOffset 开始读到文件末尾，只扫描增量部分。
   */
  private scanCompactCount(session: ClaudeSession): void {
    const jsonlPath = this.getJsonlPath(session);
    if (!jsonlPath) return;

    try {
      const stat = statSync(jsonlPath);
      const fileSize = stat.size;
      if (fileSize <= session.jsonlOffset) return;

      const fd = openSync(jsonlPath, "r");
      try {
        const readLen = fileSize - session.jsonlOffset;
        const buf = Buffer.alloc(readLen);
        readSync(fd, buf, 0, readLen, session.jsonlOffset);
        session.jsonlOffset = fileSize;

        const chunk = buf.toString("utf-8");
        for (const line of chunk.split("\n")) {
          if (!line.includes("compact_boundary")) continue;
          try {
            const entry = JSON.parse(line) as { type?: string; subtype?: string };
            if (entry.type === "system" && entry.subtype === "compact_boundary") {
              session.compactCount++;
            }
          } catch { /* skip malformed lines */ }
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      // JSONL file not found or not readable — skip silently
    }
  }

  /** 构造 Claude Code session JSONL 文件路径 */
  private getJsonlPath(session: ClaudeSession): string | null {
    if (!session.claudeSessionId) return null;
    const home = homedir();
    const absWorkDir = resolve(session.workingDirectory);
    const projectKey = absWorkDir.split(sep).join("-");
    const dir = resolve(home, ".claude", "projects", projectKey);
    return resolve(dir, `${session.claudeSessionId}.jsonl`);
  }

  getAgentSessionId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.claudeSessionId;
  }

  protected agentEnv(): Record<string, string> {
    return { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
  }
}
