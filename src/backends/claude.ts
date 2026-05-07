/**
 * Claude Code CLI backend plugin.
 * 通过 `claude` 命令驱动 agent，stream-json 模式。
 */

import { statSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { CliAgentBackend, buildNiubotEnv, type BaseCliSession, type ParsedOutput } from "../agent/cli-base.js";
import type { SessionConfig, ExecHooks } from "../agent/types.js";
import { DEFAULT_LITE_MODELS } from "../config.js";

interface ClaudeSession extends BaseCliSession {
  permissionMode: string;
}

export interface ClaudeBackendOptions {
  permissionMode?: string;
}

export default class ClaudeBackend extends CliAgentBackend<ClaudeSession> {
  private permissionMode: string;

  readonly supportsSystemPrompt = true;

  constructor(options: ClaudeBackendOptions = {}) {
    super("claude");
    this.permissionMode = options.permissionMode ?? "bypassPermissions";
  }

  command(): string {
    return "claude";
  }

  buildSession(config: SessionConfig): ClaudeSession {
    return {
      workingDirectory: config.workingDirectory ?? process.cwd(),
      model: config.modelTier === "lite" ? (config.liteModel ?? DEFAULT_LITE_MODELS.claude ?? config.model) : config.model,
      importantContext: config.importantContext,
      extraEnv: buildNiubotEnv(config),
      cumulativeBytes: 0,
      compactCount: 0,
      jsonlOffset: 0,
      permissionMode: this.permissionMode,
    };
  }

  buildInput(session: ClaudeSession, message: string): { args: string[]; stdin?: string } {
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

    // 禁用 Claude Code 云端定时任务，避免与 nbt cron 冲突
    args.push("--disallowedTools", "RemoteTrigger");

    const stdin = JSON.stringify({
      type: "user",
      message: { role: "user", content: message },
    }) + "\n";

    return { args, stdin };
  }

  parseOutput(stdout: string, session: ClaudeSession): ParsedOutput {
    // stream-json 模式：stdout 是多行 JSONL 事件流
    // 同时从 result 和 assistant 事件提取信息（assistant 作为 JSONL 的 fallback）
    let resultEvent: {
      result?: string;
      session_id?: string;
      is_error?: boolean;
    } | undefined;
    let stdoutModel: string | undefined;
    let stdoutContextTokens: number | undefined;

    for (const line of stdout.split("\n")) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as { type?: string; message?: { model?: string; usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number } }; [k: string]: unknown };
        if (event.type === "result") {
          resultEvent = event as typeof resultEvent;
        } else if (event.type === "assistant" && event.message) {
          if (event.message.model) stdoutModel = event.message.model;
          if (event.message.usage) {
            const total = estimateVisibleContextTokens(event.message.usage);
            if (total > 0) stdoutContextTokens = total;
          }
        }
      } catch { /* skip non-JSON lines */ }
    }

    if (!resultEvent) {
      return { text: "（Claude 无输出）" };
    }

    let contextTokens: number | undefined;
    let model: string | undefined;

    const agentSessionId = resultEvent.session_id;
    if (agentSessionId) {
      session.agentSessionId = agentSessionId;
      const meta = this.scanJsonl(session);
      model = meta.model ?? stdoutModel;
      contextTokens = meta.contextTokens ?? stdoutContextTokens;
      const modelSource = meta.model ? "jsonl" : stdoutModel ? "stdout" : "none";
      const tokensSource = meta.contextTokens ? "jsonl" : stdoutContextTokens ? "stdout" : "none";
      this.log.info("parseOutput: done", {
        agentSessionId, model, contextTokens,
        modelSource, tokensSource,
        stdoutModel: stdoutModel ?? null,
        stdoutContextTokens: stdoutContextTokens ?? null,
      });
    } else {
      model = stdoutModel;
      contextTokens = stdoutContextTokens;
      this.log.info("parseOutput: no session_id, stdout only", { model, contextTokens });
    }

    return {
      text: (resultEvent.result ?? "").trim(),
      agentSessionId,
      contextTokens,
      model,
      error: resultEvent.is_error ? "模型不存在或无权限" : undefined,
    };
  }

  /**
   * 增量扫描 Claude Code session JSONL，提取主 agent 信息。
   * model 从 system/init 事件获取，usage 从最后一条 assistant message 获取。
   */
  private scanJsonl(session: ClaudeSession): { model?: string; contextTokens?: number } {
    const jsonlPath = this.getJsonlPath(session);
    if (!jsonlPath) {
      this.log.info("scanJsonl: skip, no agentSessionId");
      return {};
    }

    this.log.info("scanJsonl: start", {
      jsonlPath,
      workingDirectory: session.workingDirectory,
      agentSessionId: session.agentSessionId,
      currentOffset: session.jsonlOffset,
    });

    let model: string | undefined;
    let contextTokens: number | undefined;

    try {
      const stat = statSync(jsonlPath);
      const fileSize = stat.size;
      if (fileSize <= session.jsonlOffset) {
        this.log.info("scanJsonl: no new data", { fileSize, offset: session.jsonlOffset });
        return {};
      }

      const fd = openSync(jsonlPath, "r");
      try {
        const readLen = fileSize - session.jsonlOffset;
        const buf = Buffer.alloc(readLen);
        readSync(fd, buf, 0, readLen, session.jsonlOffset);
        session.jsonlOffset = fileSize;

        const chunk = buf.toString("utf-8");
        let lineCount = 0;
        let assistantCount = 0;
        let lastAssistantHasUsage = false;
        for (const line of chunk.split("\n")) {
          if (!line) continue;
          lineCount++;
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
              assistantCount++;
              if (entry.message?.model) {
                model = entry.message.model;
              }
              if (entry.message?.usage) {
                const total = estimateVisibleContextTokens(entry.message.usage);
                lastAssistantHasUsage = true;
                if (total > 0) contextTokens = total;
              } else {
                lastAssistantHasUsage = false;
              }
            }
          } catch { /* skip malformed lines */ }
        }
        this.log.info("scanJsonl: read done", {
          readLen, lineCount, assistantCount, lastAssistantHasUsage,
          model: model ?? null, contextTokens: contextTokens ?? null,
          newOffset: session.jsonlOffset,
        });
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      this.log.warn("scanJsonl: read error", { jsonlPath, error: String(err) });
    }

    return { model, contextTokens };
  }

  /** 构造 Claude Code session JSONL 文件路径（需与 Claude Code 的 project key 算法一致） */
  private getJsonlPath(session: ClaudeSession): string | null {
    if (!session.agentSessionId) return null;
    const home = homedir();
    let absWorkDir: string;
    try {
      absWorkDir = realpathSync(resolve(session.workingDirectory));
    } catch {
      absWorkDir = resolve(session.workingDirectory);
    }
    const projectKey = absWorkDir.replace(/[/\\_]/g, "-");
    const dir = resolve(home, ".claude", "projects", projectKey);
    return resolve(dir, `${session.agentSessionId}.jsonl`);
  }

  protected getExecHooks(session: ClaudeSession): ExecHooks {
    return {
      onLine: (line) => {
        try {
          const e = JSON.parse(line);
          // 早期捕获 session ID
          if (e.session_id && !session.agentSessionId) {
            session.agentSessionId = e.session_id;
          }
        } catch { /* non-JSON line */ }
      },
      isComplete: (line) => {
        try { return JSON.parse(line).type === "result"; }
        catch { return false; }
      },
    };
  }

  protected probeSessionFileMtime(session: ClaudeSession): number | null {
    const jsonlPath = this.getJsonlPath(session);
    if (!jsonlPath) return null;
    try {
      return statSync(jsonlPath).mtimeMs;
    } catch {
      return null;
    }
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
