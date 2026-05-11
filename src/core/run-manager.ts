import type { AgentBackend, AgentResponse, AgentSession } from "../agent/types.js";
import { RuntimeStateStore, type RunStage } from "./runtime-state.js";
import { ResponseSender, type SendResult } from "./response-sender.js";
import { TimeoutError, withTimeout } from "./timeout.js";

const EMPTY_RESPONSE_FALLBACK = "（处理完成，但未生成回复。如果没收到预期结果，请重试）";

type RunManagerOptions = {
  agentTimeoutMs?: number;
};

type RunAgentInput = {
  runId: string;
  chatId: string;
  session: AgentSession;
  message: string;
  signal?: AbortSignal;
};

export type RunAgentResult =
  | { status: "response"; response: AgentResponse }
  | { status: "stopped" };

type SendFinalResponseInput = {
  runId: string;
  chatId: string;
  header: string;
  content: string;
  footer?: string;
  replyToMsgId?: string;
  signal?: AbortSignal;
};

export class RunManager {
  private readonly agentTimeoutMs: number;

  constructor(
    private readonly agent: AgentBackend,
    private readonly runtimeState: RuntimeStateStore,
    private readonly responseSender: ResponseSender,
    options: RunManagerOptions = {},
  ) {
    this.agentTimeoutMs = options.agentTimeoutMs ?? 30 * 60_000;
  }

  async runAgent(input: RunAgentInput): Promise<RunAgentResult> {
    if (input.signal?.aborted) {
      this.markRun(input.runId, "stopped");
      return { status: "stopped" };
    }

    this.markRun(input.runId, "agent_running");

    try {
      const response = await withTimeout({
        label: "agent.sendMessage",
        timeoutMs: this.agentTimeoutMs,
        signal: input.signal,
        fn: () => this.agent.sendMessage(input.session, input.message),
      });

      if (response.cancelled && !response.text.trim()) {
        this.markRun(input.runId, "stopped");
        return { status: "stopped" };
      }

      if (!response.text.trim()) {
        response.text = EMPTY_RESPONSE_FALLBACK;
      }

      return { status: "response", response };
    } catch (err) {
      if (input.signal?.aborted) {
        this.markRun(input.runId, "stopped");
        return { status: "stopped" };
      }
      if (err instanceof TimeoutError) {
        this.recordRunEvent(input.runId, "timeout", err.message);
      }
      this.markRun(input.runId, "failed", String(err));
      throw err;
    }
  }

  async sendFinalResponse(input: SendFinalResponseInput): Promise<SendResult> {
    if (input.signal?.aborted) {
      this.markRun(input.runId, "stopped");
      return { ok: false, error: "aborted", methodsTried: [] };
    }

    this.markRun(input.runId, "sending_response");
    const result = await this.responseSender.sendFinalResponse({
      chatId: input.chatId,
      header: input.header,
      content: input.content,
      footer: input.footer,
      replyToMsgId: input.replyToMsgId,
      signal: input.signal,
    });

    if (result.ok) {
      this.markRun(input.runId, "done");
    } else {
      if (isTimeoutErrorMessage(result.error)) {
        this.recordRunEvent(input.runId, "timeout", result.error);
      }
      this.markRun(input.runId, input.signal?.aborted ? "stopped" : "failed", result.error);
    }
    return result;
  }

  private markRun(runId: string, stage: RunStage, lastError?: string): void {
    const run = this.runtimeState.getRun(runId);
    if (!run || isTerminalRunStage(run.stage)) return;
    if (run.stage === stage) return;
    this.runtimeState.markRunStage(runId, stage, lastError);
  }

  private recordRunEvent(runId: string, event: "timeout", error: string): void {
    try {
      this.runtimeState.recordRunEvent(runId, event, error);
    } catch {
      // Diagnostic event writes must not affect the run lifecycle.
    }
  }
}

function isTerminalRunStage(stage: RunStage): boolean {
  return stage === "done" || stage === "failed" || stage === "stopped";
}

function isTimeoutErrorMessage(error: string): boolean {
  return error.includes(" timed out after ");
}
