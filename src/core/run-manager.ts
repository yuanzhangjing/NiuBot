import type { AgentBackend, AgentResponse, AgentSession } from "../agent/types.js";
import { createLogger } from "../logger.js";
import { RuntimeStateStore, type RunStage } from "./runtime-state.js";
import { ResponseSender, type SendResult } from "./response-sender.js";

const EMPTY_RESPONSE_FALLBACK = "（处理完成，但未生成回复。如果没收到预期结果，请重试）";
const log = createLogger("run-manager");

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
  constructor(
    private readonly agent: AgentBackend,
    private readonly runtimeState: RuntimeStateStore,
    private readonly responseSender: ResponseSender,
  ) {}

  async runAgent(input: RunAgentInput): Promise<RunAgentResult> {
    if (input.signal?.aborted) {
      this.markRun(input.runId, "stopped");
      log.info("agent run skipped, signal already aborted", {
        runId: input.runId,
        chatId: input.chatId,
        agentSessionId: input.session.id,
      });
      return { status: "stopped" };
    }

    this.markRun(input.runId, "agent_running");
    const startedAt = Date.now();
    log.info("agent run started", {
      runId: input.runId,
      chatId: input.chatId,
      agentSessionId: input.session.id,
      messageLength: input.message.length,
    });

    try {
      const response = await abortable(
        this.agent.sendMessage(input.session, input.message),
        input.signal,
      );

      if (response.cancelled && !response.text.trim()) {
        this.markRun(input.runId, "stopped");
        log.info("agent run stopped without response", {
          runId: input.runId,
          chatId: input.chatId,
          elapsedMs: Date.now() - startedAt,
        });
        return { status: "stopped" };
      }

      if (!response.text.trim()) {
        response.text = EMPTY_RESPONSE_FALLBACK;
      }

      log.info("agent run completed", {
        runId: input.runId,
        chatId: input.chatId,
        responseLength: response.text.length,
        cancelled: !!response.cancelled,
        elapsedMs: Date.now() - startedAt,
      });
      return { status: "response", response };
    } catch (err) {
      if (input.signal?.aborted) {
        this.markRun(input.runId, "stopped");
        log.info("agent run stopped by abort", {
          runId: input.runId,
          chatId: input.chatId,
          elapsedMs: Date.now() - startedAt,
        });
        return { status: "stopped" };
      }
      this.markRun(input.runId, "failed", String(err));
      log.error("agent run failed", {
        runId: input.runId,
        chatId: input.chatId,
        error: String(err),
        elapsedMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  async sendFinalResponse(input: SendFinalResponseInput): Promise<SendResult> {
    if (input.signal?.aborted) {
      this.markRun(input.runId, "stopped");
      log.info("final response skipped, signal already aborted", {
        runId: input.runId,
        chatId: input.chatId,
      });
      return { ok: false, error: "aborted", methodsTried: [] };
    }

    this.markRun(input.runId, "sending_response");
    const startedAt = Date.now();
    log.info("final response send started", {
      runId: input.runId,
      chatId: input.chatId,
      contentLength: input.content.length,
      hasReply: !!input.replyToMsgId,
    });
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
      log.info("final response sent", {
        runId: input.runId,
        chatId: input.chatId,
        method: result.method,
        platformMsgId: result.platformMsgId,
        elapsedMs: Date.now() - startedAt,
      });
    } else {
      if (isTimeoutErrorMessage(result.error)) {
        this.recordRunEvent(input.runId, "timeout", result.error);
      }
      this.markRun(input.runId, input.signal?.aborted ? "stopped" : "failed", result.error);
      log.error("final response send failed", {
        runId: input.runId,
        chatId: input.chatId,
        error: result.error,
        methodsTried: result.methodsTried,
        elapsedMs: Date.now() - startedAt,
      });
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

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) throw getAbortReason(signal);

  let abortHandler: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abortHandler = () => reject(getAbortReason(signal));
    signal.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}

function getAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("aborted");
}
