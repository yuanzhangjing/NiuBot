import type { AgentBackend, AgentResponse, AgentSession } from "../agent/types.js";
import { createLogger } from "../logger.js";
import { RuntimeStateStore, type RunStage } from "./runtime-state.js";
import { ResponseSender, type SendResult } from "./response-sender.js";

const EMPTY_RESPONSE_FALLBACK = "（处理完成，但未生成回复。如果没收到预期结果，请重试）";
/** 单个 agent run 的最大运行时长：超过即视为挂起，强制中止（防止进程挂起时队列永久卡死） */
export const AGENT_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 小时
const log = createLogger("run-manager");
/** 已确认超时并主动中止的 runId（用于与用户主动 stop 区分） */
const timedOutRunIds = new Set<string>();

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
        AGENT_RUN_TIMEOUT_MS,
        () => {
          timedOutRunIds.add(input.runId);
          log.warn("agent run timed out, aborting", {
            runId: input.runId,
            chatId: input.chatId,
            agentSessionId: input.session.id,
            timeoutMs: AGENT_RUN_TIMEOUT_MS,
            elapsedMs: Date.now() - startedAt,
          });
          // 超时后终止底层进程，避免进程残留（sendMessage 的 promise 被 race 丢弃，但进程还在跑）
          input.signal?.dispatchEvent(new Event("abort"));
          void this.agent.cancelSession(input.session).catch(() => {});
        },
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
      // 超时中止：abortable 会先 abort signal，这里与主动 stop 区分开，标记为 failed
      const timedOut = timedOutRunIds.delete(input.runId);
      if (timedOut) {
        this.markRun(input.runId, "failed", String(err));
        log.error("agent run timed out and was aborted", {
          runId: input.runId,
          chatId: input.chatId,
          error: String(err),
          elapsedMs: Date.now() - startedAt,
        });
        throw err;
      }
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

async function abortable<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  timeoutMs?: number,
  onTimeout?: () => void,
): Promise<T> {
  if (signal?.aborted) throw getAbortReason(signal);

  let abortHandler: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_, reject) => {
        abortHandler = () => reject(getAbortReason(signal));
        signal.addEventListener("abort", abortHandler, { once: true });
      })
    : undefined;

  // 超时兜底：agent 进程挂起（不退出也不输出）时 sendMessage 永不 settle，
  // 队列会永久 busy。超时后 reject，让 run 退出、队列恢复。
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOutPromise: Promise<never> | undefined;
  if (timeoutMs) {
    timedOutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(`agent run timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  try {
    return await Promise.race([operation, aborted, timedOutPromise].filter((p): p is Promise<T | never> => !!p));
  } finally {
    if (timer) clearTimeout(timer);
    if (abortHandler && signal) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}

function getAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("aborted");
}
