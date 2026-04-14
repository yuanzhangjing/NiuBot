/**
 * Claude Code CLI backend plugin.
 * 通过 `claude` 命令驱动 agent，stream-json 模式。
 */

import { statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { CliAgentBackend, buildNiubotEnv, type BaseCliSession, type ParsedOutput } from "../agent/cli-base.js";
import type { SessionConfig } from "../agent/types.js";

const DEFAULT_LITE_MODEL = "claude-haiku-4-5-20251001";

interface ClaudeSession extends BaseCliSession {
  permissionMode: string;
}

export interface ClaudeBackendOptions {
  liteModel?: string;
  permissionMode?: string;
}

export default class ClaudeBackend extends CliAgentBackend<ClaudeSession> {
  private permissionMode: string;
  private liteModel: string;

  readonly supportsSystemPrompt = true;

  constructor(options: ClaudeBackendOptions = {}) {
    super("claude");
    this.permissionMode = options.permissionMode ?? "bypassPermissions";
    this.liteModel = options.liteModel ?? DEFAULT_LITE_MODEL;
  }

  command(): string {
    return "claude";
  }

  buildSession(config: SessionConfig): ClaudeSession {
    return {
      workingDirectory: config.workingDirectory ?? process.cwd(),
      model: config.modelTier === "lite" ? (config.liteModel ?? this.liteModel) : undefined,
      importantContext: config.importantContext,
      extraEnv: buildNiubotEnv(config),
      cumulativeBytes: 0,
      compactCount: 0,
      jsonlOffset: 0,
      permissionMode: this.permissionMode,
    };
  }

  buildInput(session: ClaudeSession, message: string): { args: string[]; input?: string } {
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", session.permissionMode,
    ];

    if (session.model) {
      args.push("--model", session.model);
    }
    if (session.importantContext) {
      args.push("--append-system-prompt", session.importantContext);
    }
    if (session.agentSessionId) {
      args.push("--resume", session.agentSessionId);
    }

    // 禁用 Claude Code 云端定时任务，避免与 niubot cron 冲突
    args.push("--disallowedTools", "RemoteTrigger");

    const input = JSON.stringify({
      type: "user",
      message: { role: "user", content: message },
    }) + "\n";

    return { args, input };
  }

  parseOutput(stdout: string, session: ClaudeSession): ParsedOutput {
    // stream-json 模式：stdout 是多行 JSONL 事件流，找 type=result 那行
    let resultEvent: {
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
    } | undefined;

    for (const line of stdout.split("\n")) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as { type?: string; [k: string]: unknown };
        if (event.type === "result") {
          resultEvent = event as typeof resultEvent;
        }
      } catch { /* skip non-JSON lines */ }
    }

    if (!resultEvent) {
      return { text: stdout.trim() };
    }

    let contextTokens: number | undefined;
    if (resultEvent.usage) {
      const total = estimateVisibleContextTokens(resultEvent.usage);
      if (total > 0) contextTokens = total;
    }

    let model = resultEvent.modelUsage ? Object.keys(resultEvent.modelUsage)[0] : undefined;

    // 增量扫描 JSONL，用更精确的 model/token 信息覆盖 stdout 的摘要值
    const agentSessionId = resultEvent.session_id;
    if (agentSessionId) {
      session.agentSessionId = agentSessionId;
      const meta = this.scanJsonl(session);
      if (meta.model) model = meta.model;
      if (meta.contextTokens) contextTokens = meta.contextTokens;
    }

    return {
      text: (resultEvent.result ?? "").trim(),
      agentSessionId,
      contextTokens,
      model,
    };
  }

  /**
   * 增量扫描 Claude Code session JSONL，提取主 agent 信息。
   * model 从 system/init 事件获取，usage 从最后一条 assistant message 获取。
   */
  private scanJsonl(session: ClaudeSession): { model?: string; contextTokens?: number } {
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

        const chunk = buf.toString("utf-8");
        for (const line of chunk.split("\n")) {
          if (!line) continue;
          try {
            const entry = JSON.parse(line) as {
              type?: string;
              subtype?: string;
              model?: string;
              message?: {
                model?: string;
                usage?: {
                  input_tokens?: number;
                  cache_creation_input_tokens?: number;
                  cache_read_input_tokens?: number;
                  output_tokens?: number;
                };
              };
            };

            if (entry.type === "system") {
              if (entry.subtype === "compact_boundary") {
                session.compactCount++;
              } else if (entry.subtype === "init" && entry.model) {
                model = entry.model;
              }
            } else if (entry.type === "assistant") {
              if (entry.message?.model) {
                model = entry.message.model;
              }
              if (entry.message?.usage) {
                const total = estimateVisibleContextTokens(entry.message.usage);
                if (total > 0) contextTokens = total;
              }
            }
          } catch { /* skip malformed lines */ }
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      // JSONL file not found or not readable — skip silently
    }

    return { model, contextTokens };
  }

  /** 构造 Claude Code session JSONL 文件路径 */
  private getJsonlPath(session: ClaudeSession): string | null {
    if (!session.agentSessionId) return null;
    const home = homedir();
    const absWorkDir = resolve(session.workingDirectory);
    const projectKey = absWorkDir.split(sep).join("-");
    const dir = resolve(home, ".claude", "projects", projectKey);
    return resolve(dir, `${session.agentSessionId}.jsonl`);
  }

  protected agentEnv(): Record<string, string> {
    return {
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_CRON: "1",
    };
  }
}

function estimateVisibleContextTokens(usage: {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}): number {
  return (usage.input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)
    + (usage.output_tokens ?? 0);
}
