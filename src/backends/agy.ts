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

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliAgentBackend, buildNiubotEnv, type BaseCliSession, type ParsedOutput } from "../agent/cli-base.js";
import { AgentSessionNotStartedError, ERROR_DISPLAY_MAX_LEN, type AgentSessionActivity } from "../agent/types.js";
import { readAgyTranscript } from "../session-archive/native-transcript.js";
import type { ExecHooks, SessionConfig } from "../agent/types.js";

interface AgySession extends BaseCliSession {}

export interface AgyBackendOptions {
  agyHome?: string;
}

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
  init?: {
    model?: string;
  };
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
const TRANSCRIPT_TAIL_BYTES = 262_144;

export default class AgyBackend extends CliAgentBackend<AgySession> {
  private readonly agyHome: string;

  constructor(options: AgyBackendOptions = {}) {
    super("agy");
    this.agyHome = options.agyHome ?? join(homedir(), ".gemini", "antigravity-cli");
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

  /** 可读的会话记录在 brain/<id>/.system_generated/logs/ 下，SQLite 只是 protobuf 存档。 */
  private transcriptPath(agentSessionId: string): string {
    return join(this.agyHome, "brain", agentSessionId,
      ".system_generated", "logs", "transcript_full.jsonl");
  }

  private compactTranscriptPath(agentSessionId: string): string {
    return join(this.agyHome, "brain", agentSessionId,
      ".system_generated", "logs", "transcript.jsonl");
  }

  protected async loadSessionTranscript(session: AgySession) {
    if (!session.agentSessionId) throw new AgentSessionNotStartedError("unknown");
    return readAgyTranscript(this.transcriptPath(session.agentSessionId), session.agentSessionId);
  }

  /** /status 用最近两条可读步骤，盖掉 stdout 的 JSON 碎片 */
  protected refreshActivity(sessionId: string, activity: AgentSessionActivity): void {
    const session = this.sessions.get(sessionId);
    if (!session?.agentSessionId) return;
    const lines = readTailLines(this.compactTranscriptPath(session.agentSessionId), TRANSCRIPT_TAIL_BYTES)
      ?? readTailLines(this.transcriptPath(session.agentSessionId), TRANSCRIPT_TAIL_BYTES);
    if (!lines) return;
    const recent: string[] = [];
    for (const line of lines.slice(-40)) {
      try {
        const parsed = JSON.parse(line) as { type?: string; source?: string; content?: string };
        if (!parsed.content) continue;
        const who = parsed.type === "USER_INPUT" ? "user" : parsed.type === "PLANNER_RESPONSE" ? "assistant" : undefined;
        if (!who) continue;
        const text = who === "user" ? agyPreview(parsed.content) : parsed.content.replace(/\s+/g, " ").trim();
        if (text) recent.push(`${who}: ${text.slice(0, ERROR_DISPLAY_MAX_LEN)}`);
      } catch { /* 跳过损坏行 */ }
    }
    if (recent.length > 0) activity.recentLines = recent.slice(-3);
  }

  /** agy 把每个会话写成独立 SQLite；mtime 用来证明长任务还活着。 */
  protected probeSessionFileMtime(session: AgySession): number | null {
    if (!session.agentSessionId) return null;
    const file = join(this.agyHome, "conversations", `${session.agentSessionId}.db`);
    try {
      return statSync(file).mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * 默认模型下 stdout 的 init 不含 model，只有 brain transcript 的 PLANNER_RESPONSE 带实际模型名。
   * 优先读紧凑版 transcript.jsonl，避免长会话整读大体积 transcript_full.jsonl。
   */
  private readTranscriptMeta(agentSessionId: string): {
    model?: string;
    contextTokens?: number;
    lastStepHasToolCalls?: boolean;
  } {
    for (const file of [this.compactTranscriptPath(agentSessionId), this.transcriptPath(agentSessionId)]) {
      const lines = readTailLines(file, TRANSCRIPT_TAIL_BYTES);
      if (!lines) continue;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const step = JSON.parse(lines[i]!) as {
            type?: string;
            model?: string;
            input_tokens?: number;
            cache_read_tokens?: number;
            output_tokens?: number;
            tool_calls?: unknown[];
          };
          if (step.type !== "PLANNER_RESPONSE") continue;
          const model = typeof step.model === "string" && step.model.trim() ? step.model.trim() : undefined;
          const contextTokens = estimateAgyContextTokens(step);
          const lastStepHasToolCalls = Array.isArray(step.tool_calls) && step.tool_calls.length > 0;
          if (model || contextTokens !== undefined || lastStepHasToolCalls) {
            return { model, contextTokens, lastStepHasToolCalls };
          }
        } catch { /* 跳过半行或损坏行 */ }
      }
    }
    return {};
  }

  parseOutput(stdout: string, session: AgySession): ParsedOutput {
    let agentSessionId = session.agentSessionId;
    let initModel: string | undefined;
    let streamed = "";
    let finalText = "";
    let sawResult = false;
    let status: string | undefined;
    let errorMessage: string | undefined;
    let lastErrorStep: number | undefined;
    let lastAgentDoneStep: number | undefined;
    let lastStepType: string | undefined;
    let lastStepState: string | undefined;
    let lastStepTokens: number | undefined;
    let resultTokens: number | undefined;

    for (const line of stdout.split("\n")) {
      const event = parseEvent(line);
      if (!event) continue;

      const conversationId = event.conversation_id ?? event.step_update?.conversation_id
        ?? event.result?.conversation_id;
      if (conversationId) agentSessionId = conversationId;

      if (event.event === "init" && event.init?.model?.trim()) {
        initModel = event.init.model.trim();
      }

      if (event.event === "step_update" && event.step_update) {
        const step = event.step_update;
        // 忽略尾部可能插入的 system_message，避免覆盖最终 agent_response 状态
        if (step.step_type && step.step_type !== "system_message") {
          lastStepType = step.step_type;
          lastStepState = step.state;
        }
        if (step.step_type === "error_message" && typeof step.step_index === "number") {
          lastErrorStep = step.step_index;
        }
        if (step.step_type === "agent_response") {
          if (step.text_delta) streamed += step.text_delta;
          if (step.state === "DONE" && typeof step.step_index === "number") {
            lastAgentDoneStep = step.step_index;
          }
          // result.usage 会把多步未命中缓存增量累加；最后一条 agent_response 步才是当前上下文窗口占用
          const stepTokens = estimateAgyContextTokens(step.usage);
          if (stepTokens !== undefined) lastStepTokens = stepTokens;
        }
      }

      if (event.event === "result") {
        sawResult = true;
        status = event.result?.status;
        finalText = event.result?.response ?? "";
        if (event.result?.error) errorMessage = event.result.error.slice(0, ERROR_DISPLAY_MAX_LEN);
        resultTokens = estimateAgyContextTokens(event.result?.usage);
      }
    }

    const transcriptMeta = agentSessionId ? this.readTranscriptMeta(agentSessionId) : {};
    const contextTokens = lastStepTokens ?? transcriptMeta.contextTokens ?? resultTokens;
    const model = initModel ?? transcriptMeta.model ?? session.model;

    // result.response 是本轮最终回复；流式片段只在没有终态时用于诊断
    const text = (finalText || streamed).trim();
    // agy 的 result.status / result.error 按整个会话累计：只要历史任意一轮出过一次
    // error_message，同会话后续每一轮 resume 完结时 result 仍会带 status=ERROR 和旧错误文案。
    // 只要本轮最后一步是正常 DONE 的最终 agent_response（之后无新 error_message、无待执行 tool_calls），即视为本轮成功。
    const completedCleanlyAfterStickyError = sawResult
      && status !== "SUCCESS"
      && lastAgentDoneStep !== undefined
      && (lastErrorStep === undefined || lastAgentDoneStep > lastErrorStep)
      && lastStepType === "agent_response"
      && lastStepState === "DONE"
      && !transcriptMeta.lastStepHasToolCalls
      && finalText.trim().length > 0;
    const succeeded = sawResult && (status === "SUCCESS" || completedCleanlyAfterStickyError);
    if (completedCleanlyAfterStickyError) {
      this.log.info("ignoring sticky agy result error", {
        agentSessionId: agentSessionId ?? null,
        status: status ?? null,
        error: errorMessage ?? null,
      });
    }
    const failed = sawResult && !succeeded;
    if (failed && !errorMessage) {
      errorMessage = `agy 回合失败（status=${status ?? "unknown"}）`;
    }

    return {
      text: failed ? "" : text,
      turnCompleted: sawResult,
      lastMessage: text,
      incompleteReason: sawResult ? undefined : "未收到 result 事件",
      agentSessionId,
      contextTokens,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      model,
      error: failed ? errorMessage : undefined,
      failed,
    };
  }
}

function estimateAgyContextTokens(usage: AgyUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const total = (usage.input_tokens ?? 0) + (usage.cache_read_tokens ?? 0) + (usage.output_tokens ?? 0);
  return total > 0 ? total : undefined;
}

function readTailLines(file: string, maxBytes: number): string[] | null {
  try {
    const size = statSync(file).size;
    if (size === 0) return null;
    const offset = Math.max(0, size - maxBytes);
    const length = size - offset;
    const buf = Buffer.alloc(length);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, length, offset);
    } finally {
      closeSync(fd);
    }
    const lines = buf.toString("utf-8").split("\n");
    if (offset > 0) lines.shift();
    return lines.filter((line) => line.trim().length > 0);
  } catch {
    return null;
  }
}

/** 预览前先剥掉 prompt 包装，避免 /status 里出现 <USER_REQUEST> */
function agyPreview(content: string): string {
  const match = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  return (match ? match[1]! : content).replace(/\s+/g, " ").trim();
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
