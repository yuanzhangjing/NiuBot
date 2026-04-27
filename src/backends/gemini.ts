/**
 * Gemini CLI backend plugin.
 * 通过 `gemini -p` 命令驱动 agent，stream-json 模式。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, basename } from "node:path";
import { CliAgentBackend, buildNiubotEnv, type BaseCliSession, type ParsedOutput } from "../agent/cli-base.js";
import type { SessionConfig, ExecHooks } from "../agent/types.js";
import { DEFAULT_LITE_MODELS } from "../config.js";

interface GeminiSession extends BaseCliSession {}

export default class GeminiBackend extends CliAgentBackend<GeminiSession> {
  readonly supportsSystemPrompt = false;

  constructor() {
    super("gemini");
  }

  command(): string {
    return "gemini";
  }

  buildSession(config: SessionConfig): GeminiSession {
    return {
      workingDirectory: config.workingDirectory ?? process.cwd(),
      model: config.modelTier === "lite" ? (config.liteModel ?? DEFAULT_LITE_MODELS.gemini ?? config.model) : config.model,
      importantContext: config.importantContext,
      extraEnv: buildNiubotEnv(config),
      cumulativeBytes: 0,
      compactCount: 0,
      jsonlOffset: 0,
    };
  }

  buildInput(session: GeminiSession, message: string): { args: string[]; stdin?: string } {
    const args = ["-p", "", "-o", "stream-json", "-y"];
    if (session.model) args.push("-m", session.model);
    if (session.agentSessionId) args.push("-r", session.agentSessionId);
    return { args, stdin: message };
  }

  protected probeSessionFileMtime(session: GeminiSession): number | null {
    if (!session.agentSessionId) return null;
    const chatsDir = this.getChatsDir(session);
    const shortId = session.agentSessionId.split("-")[0]!;
    try {
      const match = readdirSync(chatsDir).find((name) => name.includes(shortId));
      if (match) return statSync(resolve(chatsDir, match)).mtimeMs;
    } catch { /* directory may not exist */ }
    return null;
  }

  protected getExecHooks(session: GeminiSession): ExecHooks {
    return {
      onLine: (line) => {
        try {
          const e = JSON.parse(line);
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

  parseOutput(stdout: string, _session: GeminiSession): ParsedOutput {
    // stream-json: JSONL event stream
    // init → message(user) → message(assistant, delta) → result
    let sessionId: string | undefined;
    let contextTokens: number | undefined;
    let model: string | undefined;
    let errorMsg: string | undefined;
    const textParts: string[] = [];

    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch { continue; }

      // init event: session_id + model
      if (event["type"] === "init") {
        if (typeof event["session_id"] === "string") sessionId = event["session_id"];
        if (typeof event["model"] === "string") model = event["model"];
        continue;
      }

      // tool_use: clear accumulated text — previous assistant messages are intermediate thoughts
      if (event["type"] === "tool_use") {
        textParts.length = 0;
        continue;
      }

      // assistant message: accumulate text (delta chunks of the current turn)
      if (event["type"] === "message" && event["role"] === "assistant") {
        if (typeof event["content"] === "string") textParts.push(event["content"]);
        continue;
      }

      // result event: error + model
      if (event["type"] === "result") {
        if (event["status"] === "error") {
          const err = event["error"] as Record<string, unknown> | undefined;
          errorMsg = (err?.["message"] as string) ?? JSON.stringify(err);
        }
        // model 从 stats 里取（result.stats.models 的第一个 key）
        const stats = event["stats"] as Record<string, unknown> | undefined;
        if (stats) {
          const models = stats["models"] as Record<string, unknown> | undefined;
          if (models) {
            const modelNames = Object.keys(models);
            if (modelNames.length > 0) model = modelNames[0];
          }
        }
        // token 数不从 result.stats 取——有 tool call 时是累加值，不可靠。
        // 统一从 session file 读取。
      }
    }

    const text = textParts.join("");
    if (!text && errorMsg) {
      return { text: `（Gemini 错误）${errorMsg}`, agentSessionId: sessionId, model, error: errorMsg };
    }

    // token 数从 session file 取（精确值），不依赖 result.stats
    if (sessionId) {
      contextTokens = this.scanSessionFile(sessionId, _session);
    }
    this.log.info("parseOutput", {
      sessionId: sessionId ?? null,
      contextTokens: contextTokens ?? null,
      model: model ?? null,
    });

    return {
      text: text.trim() || stdout.trim() || "（Gemini 无输出）",
      agentSessionId: sessionId,
      contextTokens,
      model,
      error: errorMsg,
    };
  }

  /** Gemini session file 所在目录：~/.gemini/tmp/<dirname>/chats/ */
  private getChatsDir(session: GeminiSession): string {
    // Gemini CLI 用 cwd 的目录名（basename）作为 project key，不是完整路径
    const projectKey = basename(resolve(session.workingDirectory));
    return resolve(homedir(), ".gemini", "tmp", projectKey, "chats");
  }

  /**
   * 从 Gemini session file 读取最后一条 gemini message 的 token 数据。
   * 返回 input + output（不含 thoughts），即真实的上下文大小。
   */
  private scanSessionFile(sessionId: string, session: GeminiSession): number | undefined {
    const chatsDir = this.getChatsDir(session);
    const shortId = sessionId.split("-")[0]!;
    try {
      const match = readdirSync(chatsDir).find((name) => name.includes(shortId));
      if (!match) return undefined;
      const data = JSON.parse(readFileSync(resolve(chatsDir, match), "utf-8")) as {
        messages?: Array<{
          type?: string;
          tokens?: { input?: number; output?: number };
        }>;
      };
      if (!data.messages) return undefined;
      // 取最后一条 gemini type message 的 tokens
      for (let i = data.messages.length - 1; i >= 0; i--) {
        const msg = data.messages[i]!;
        if (msg.type === "gemini" && msg.tokens) {
          const input = msg.tokens.input ?? 0;
          const output = msg.tokens.output ?? 0;
          return input + output;
        }
      }
    } catch { /* file not found or parse error */ }
    return undefined;
  }
}
