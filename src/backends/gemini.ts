/**
 * Gemini CLI backend plugin.
 * 通过 `gemini -p` 命令驱动 agent，stream-json 模式。
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
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
    // Gemini stores sessions at ~/.gemini/tmp/<project>/chats/session-*-<sid>.json
    const absWorkDir = resolve(session.workingDirectory);
    const projectKey = absWorkDir.split(sep).join("-");
    const chatsDir = resolve(homedir(), ".gemini", "tmp", projectKey, "chats");
    try {
      const match = readdirSync(chatsDir).find((name) => name.includes(session.agentSessionId!));
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

      // assistant message: accumulate text
      if (event["type"] === "message" && event["role"] === "assistant") {
        if (typeof event["content"] === "string") textParts.push(event["content"]);
        continue;
      }

      // result event: stats + error
      if (event["type"] === "result") {
        if (event["status"] === "error") {
          const err = event["error"] as Record<string, unknown> | undefined;
          errorMsg = (err?.["message"] as string) ?? JSON.stringify(err);
        }
        const stats = event["stats"] as Record<string, unknown> | undefined;
        if (stats) {
          const models = stats["models"] as Record<string, unknown> | undefined;
          if (models) {
            const modelNames = Object.keys(models);
            if (modelNames.length > 0) {
              model = modelNames[0];
              const ms = models[model] as Record<string, number> | undefined;
              if (ms) {
                contextTokens = (ms["input_tokens"] ?? 0) + (ms["output_tokens"] ?? 0);
              }
            }
          }
        }
      }
    }

    const text = textParts.join("");
    if (!text && errorMsg) {
      return { text: `（Gemini 错误）${errorMsg}`, agentSessionId: sessionId, model };
    }

    return {
      text: text.trim() || stdout.trim() || "（Gemini 无输出）",
      agentSessionId: sessionId,
      contextTokens,
      model,
    };
  }
}
