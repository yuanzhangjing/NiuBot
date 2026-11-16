/**
 * Antigravity CLI (`agy`) backend.
 *
 * Drives one turn with `agy -p <message> --output-format stream-json` and reads
 * the NDJSON event stream. The conversation id arrives in the `init` event, so
 * resume uses `--conversation <id>` from the second turn on.
 *
 * agy has no flag to append a system prompt, so identity and workspace rules are
 * delivered as a user prefix by the pipeline (`needsStableUserPrefix`).
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliAgentBackend, buildNiubotEnv, type BaseCliSession, type ParsedOutput } from "../agent/cli-base.js";
import { ERROR_DISPLAY_MAX_LEN } from "../agent/types.js";
import type { ExecHooks, SessionConfig } from "../agent/types.js";

interface AgySession extends BaseCliSession {}

interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

interface AgyEvent {
  event?: string;
  conversation_id?: string;
  step_update?: {
    conversation_id?: string;
    step_index?: number;
    state?: string;
    step_type?: string;
    text_delta?: string;
    usage?: AgyUsage;
  };
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    error?: string;
    finished_reason?: string;
    usage?: AgyUsage;
  };
}

/** Gemini 4 family runs with a 1M window; other routes fall back to the same value. */
const DEFAULT_CONTEXT_WINDOW = 1_048_576;

export default class AgyBackend extends CliAgentBackend<AgySession> {
  constructor() {
    super("agy");
  }

  command(): string {
    return "agy";
  }

  /** 没有 append-system-prompt，身份与规则只能拼进首条 user */
  needsStableUserPrefix(): boolean {
    return true;
  }

  buildSession(config: SessionConfig): AgySession {
    return {
      workingDirectory: config.workingDirectory ?? process.cwd(),
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      importantContext: config.importantContext,
      extraEnv: buildNiubotEnv(config),
      cumulativeBytes: 0,
      compactCount: 0,
      jsonlOffset: 0,
    };
  }

  buildInput(session: AgySession, message: string): { args: string[] } {
    // agy only accepts the prompt as an argument; this is the documented CLI
    // difference (message is visible in the process list, like other `-p` CLIs).
    const args = ["-p", message, "--output-format", "stream-json"];
    if (session.model) args.push("--model", session.model);
    if (session.reasoningEffort) args.push("--effort", session.reasoningEffort);
    if (session.agentSessionId) args.push("--conversation", session.agentSessionId);
    return { args };
  }

  /** 进程列表里不能出现用户消息 */
  protected argsForLog(args: string[]): string[] {
    const redacted = [...args];
    const index = redacted.indexOf("-p");
    if (index >= 0 && index + 1 < redacted.length) redacted[index + 1] = "<message>";
    return redacted;
  }

  protected getExecHooks(session: AgySession): ExecHooks {
    return {
      onLine: (line) => {
        const event = parseEvent(line);
        if (event?.event === "init" && event.conversation_id && !session.agentSessionId) {
          session.agentSessionId = event.conversation_id;
        }
      },
      isComplete: (line) => parseEvent(line)?.event === "result",
    };
  }

  /** agy 把每个会话写成独立 SQLite；mtime 用来证明长任务还活着。 */
  protected probeSessionFileMtime(session: AgySession): number | null {
    if (!session.agentSessionId) return null;
    const file = join(homedir(), ".gemini", "antigravity-cli", "conversations", `${session.agentSessionId}.db`);
    try {
      return statSync(file).mtimeMs;
    } catch {
      return null;
    }
  }

  parseOutput(stdout: string, session: AgySession): ParsedOutput {
    let agentSessionId = session.agentSessionId;
    let streamed = "";
    let finalText = "";
    let sawResult = false;
    let status: string | undefined;
    let errorMessage: string | undefined;
    let contextTokens: number | undefined;

    for (const line of stdout.split("\n")) {
      const event = parseEvent(line);
      if (!event) continue;

      const conversationId = event.conversation_id ?? event.step_update?.conversation_id
        ?? event.result?.conversation_id;
      if (conversationId) agentSessionId = conversationId;

      if (event.event === "step_update" && event.step_update?.step_type === "agent_response") {
        if (event.step_update.text_delta) streamed += event.step_update.text_delta;
      }

      if (event.event === "result") {
        sawResult = true;
        status = event.result?.status;
        finalText = event.result?.response ?? "";
        if (event.result?.error) errorMessage = event.result.error.slice(0, ERROR_DISPLAY_MAX_LEN);
        const usage = event.result?.usage;
        if (usage && typeof usage.input_tokens === "number" && usage.input_tokens > 0) {
          contextTokens = usage.input_tokens;
        }
      }
    }

    // result.response 是本轮最终回复；流式片段只在没有终态时用于诊断
    const text = (finalText || streamed).trim();
    const failed = sawResult && status !== "SUCCESS";
    if (!failed && !sawResult) {
      errorMessage = errorMessage ?? "未收到 result 事件";
    }
    if (failed && !errorMessage) {
      errorMessage = `agy 回合失败（status=${status ?? "unknown"}）`;
    }

    return {
      text,
      turnCompleted: sawResult && status === "SUCCESS",
      lastMessage: text,
      incompleteReason: sawResult ? undefined : "未收到 result 事件",
      agentSessionId,
      contextTokens,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      model: session.model,
      error: errorMessage,
      failed,
    };
  }
}

function parseEvent(line: string): AgyEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as AgyEvent;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
