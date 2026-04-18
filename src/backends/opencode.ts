/**
 * Opencode CLI backend plugin.
 * 通过 `opencode run` 命令驱动 agent，JSON 事件流输出。
 */

import { CliAgentBackend, buildNiubotEnv, type BaseCliSession, type ParsedOutput } from "../agent/cli-base.js";
import type { SessionConfig } from "../agent/types.js";

interface OpencodeSession extends BaseCliSession {}

export default class OpencodeBackend extends CliAgentBackend<OpencodeSession> {
  readonly supportsSystemPrompt = false;

  constructor() {
    super("opencode");
  }

  command(): string {
    return "opencode";
  }

  buildSession(config: SessionConfig): OpencodeSession {
    return {
      workingDirectory: config.workingDirectory ?? process.cwd(),
      model: config.model,
      importantContext: config.importantContext,
      extraEnv: buildNiubotEnv(config),
      cumulativeBytes: 0,
      compactCount: 0,
      jsonlOffset: 0,
    };
  }

  buildInput(session: OpencodeSession, message: string): { args: string[]; stdin?: string } {
    const args = [
      "run",
      "--format", "json",
      "--dangerously-skip-permissions",
      "--dir", session.workingDirectory,
    ];
    if (session.model) args.push("-m", session.model);
    if (session.agentSessionId) args.push("-s", session.agentSessionId);
    args.push(message);
    return { args };
  }

  parseOutput(stdout: string, _session: OpencodeSession): ParsedOutput {
    let text = "";
    let sessionId: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;

    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          sessionID?: string;
          part?: {
            type?: string;
            text?: string;
            tokens?: {
              total?: number;
              input?: number;
              output?: number;
            };
          };
        };

        if (event.sessionID) sessionId = event.sessionID;

        if (event.type === "text" && event.part?.text) {
          text += event.part.text;
        }

        if (event.type === "step_finish" && event.part?.tokens) {
          inputTokens += event.part.tokens.input ?? 0;
          outputTokens += event.part.tokens.output ?? 0;
        }
      } catch { /* skip non-JSON lines */ }
    }

    const contextTokens = inputTokens + outputTokens;

    return {
      text: text.trim() || stdout.trim(),
      agentSessionId: sessionId,
      contextTokens: contextTokens > 0 ? contextTokens : undefined,
    };
  }
}
