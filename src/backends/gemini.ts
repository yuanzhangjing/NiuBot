/**
 * Gemini CLI backend plugin.
 * 通过 `gemini -p` 命令驱动 agent，JSON 输出。
 */

import { CliAgentBackend, buildNiubotEnv, type BaseCliSession, type ParsedOutput } from "../agent/cli-base.js";
import type { SessionConfig } from "../agent/types.js";
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
    const args = ["-p", "", "-o", "json", "-y"];
    if (session.model) args.push("-m", session.model);
    if (session.agentSessionId) args.push("-r", session.agentSessionId);
    return { args, stdin: message };
  }

  parseOutput(stdout: string, _session: GeminiSession): ParsedOutput {
    // Gemini CLI with `-o json` outputs a single formatted JSON object (not JSONL).
    // Try parsing the entire stdout as one JSON object first.
    let event: Record<string, unknown> | undefined;
    try {
      event = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      // Fallback: try line-by-line JSONL parsing
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
          break; // use first valid JSON line
        } catch { /* skip non-JSON lines */ }
      }
    }

    if (!event) {
      return { text: stdout.trim() || "（Gemini 无输出）" };
    }

    // Error handling
    if (event["error"]) {
      const err = event["error"] as Record<string, unknown>;
      const errMsg = (typeof err === "string" ? err : (err["message"] as string)) ?? JSON.stringify(err);
      const response = typeof event["response"] === "string" ? event["response"] : "";
      if (!response) return { text: `（Gemini 错误）${errMsg}` };
    }

    // Extract response text
    const text = typeof event["response"] === "string" ? event["response"]
               : typeof event["result"] === "string" ? event["result"]
               : typeof event["text"] === "string" ? event["text"]
               : "";

    // Extract session ID
    const sessionId = typeof event["session_id"] === "string" ? event["session_id"] : undefined;

    // Extract token stats and model from stats object
    let contextTokens: number | undefined;
    let model: string | undefined;
    const stats = event["stats"] as Record<string, unknown> | undefined;
    if (stats) {
      const models = stats["models"] as Record<string, unknown> | undefined;
      if (models) {
        // stats.models is keyed by model name — grab the first one
        const modelNames = Object.keys(models);
        if (modelNames.length > 0) {
          model = modelNames[0];
          const modelStats = models[model] as Record<string, unknown> | undefined;
          const tokens = modelStats?.["tokens"] as Record<string, number> | undefined;
          if (tokens) {
            contextTokens = tokens["total"] ?? ((tokens["input"] ?? 0) + (tokens["candidates"] ?? 0) + (tokens["thoughts"] ?? 0));
          }
        }
      }
    }

    return {
      text: text.trim() || stdout.trim(),
      agentSessionId: sessionId,
      contextTokens,
      model,
    };
  }
}
