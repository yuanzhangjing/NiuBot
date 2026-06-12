import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentBackend, AgentResponse, AgentSession, SessionConfig } from "../agent/types.js";
import { RuntimeStateStore, type RuntimeStateEvent } from "./runtime-state.js";
import { ResponseSender } from "./response-sender.js";
import { RunManager } from "./run-manager.js";

const EMPTY_RESPONSE_FALLBACK = "（处理完成，但未生成回复。如果没收到预期结果，请重试）";

class RecordingAgent implements AgentBackend {
  readonly sendMessageCalls: string[] = [];

  constructor(private readonly handler: (message: string) => Promise<AgentResponse>) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async createSession(_config: SessionConfig): Promise<AgentSession> { return { id: "agent-1" }; }
  async sendMessage(_session: AgentSession, message: string): Promise<AgentResponse> {
    this.sendMessageCalls.push(message);
    return this.handler(message);
  }
  async cancelSession(): Promise<void> {}
  async closeSession(): Promise<void> {}
  needsStableUserPrefix() { return false; }
  needsCompactRecoveryReminder() { return true; }
  async validateModel(): Promise<{ valid: boolean }> { return { valid: true }; }
}

function createStore(onEvent?: (event: RuntimeStateEvent) => void): { store: RuntimeStateStore; runId: string } {
  const store = new RuntimeStateStore({
    now: (() => {
      let now = 1_000;
      return () => now++;
    })(),
    createRunId: () => "run-1",
    onEvent,
  });
  const run = store.createRun({
    chatId: "c1",
    triggerMessageIds: [1],
    triggerPlatformMsgIds: ["m1"],
    replyToPlatformMsgId: "m1",
    mergedText: "hello",
  });
  return { store, runId: run.runId };
}

function createSender(overrides: Partial<ResponseSender> = {}): ResponseSender {
  return {
    async sendFinalResponse() {
      return { ok: true, platformMsgId: "pmid", method: "card" };
    },
    ...overrides,
  } as ResponseSender;
}

describe("RunManager", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function captureStdout(): string[] {
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array, ...args: unknown[]) => {
      lines.push(String(chunk));
      const callback = args.find((arg): arg is () => void => typeof arg === "function");
      callback?.();
      return true;
    });
    return lines;
  }

  test("marks a successful agent call and final send as done", async () => {
    const { store, runId } = createStore();
    const agent = new RecordingAgent(async () => ({ text: "reply" }));
    const manager = new RunManager(agent, store, createSender());

    const agentResult = await manager.runAgent({
      runId,
      chatId: "c1",
      session: { id: "agent-1" },
      message: "hello",
    });
    const sendResult = await manager.sendFinalResponse({
      runId,
      chatId: "chat-open-id",
      header: "",
      content: agentResult.response.text,
      replyToMsgId: "m1",
    });

    expect(sendResult.ok).toBe(true);
    expect(store.getRun(runId)?.stage).toBe("done");
    expect(agent.sendMessageCalls).toEqual(["hello"]);
  });

  test("logs agent lifecycle without prompt content", async () => {
    const logs = captureStdout();
    const { store, runId } = createStore();
    const agent = new RecordingAgent(async () => ({ text: "reply" }));
    const manager = new RunManager(agent, store, createSender());

    await manager.runAgent({
      runId,
      chatId: "c1",
      session: { id: "agent-1" },
      message: "secret prompt",
    });

    const output = logs.join("");
    expect(output).toContain("[run-manager] agent run started runId=run-1 chatId=c1 agentSessionId=agent-1 messageLength=13");
    expect(output).toContain("[run-manager] agent run completed runId=run-1 chatId=c1 responseLength=5");
    expect(output).not.toContain("secret prompt");
  });

  test("marks the run failed when the agent throws", async () => {
    const { store, runId } = createStore();
    const manager = new RunManager(
      new RecordingAgent(async () => { throw new Error("agent failed"); }),
      store,
      createSender(),
    );

    await expect(manager.runAgent({
      runId,
      chatId: "c1",
      session: { id: "agent-1" },
      message: "hello",
    })).rejects.toThrow("agent failed");

    expect(store.getRun(runId)).toMatchObject({
      stage: "failed",
      lastError: "Error: agent failed",
    });
  });

  test("does not fail an active agent call because of a fixed wall-clock timeout", async () => {
    vi.useFakeTimers();
    const events: RuntimeStateEvent[] = [];
    const { store, runId } = createStore((event) => events.push(event));
    let resolveAgent: ((response: AgentResponse) => void) | undefined;
    const manager = new RunManager(
      new RecordingAgent(() => new Promise<AgentResponse>((resolve) => { resolveAgent = resolve; })),
      store,
      createSender(),
    );

    const pending = manager.runAgent({
      runId,
      chatId: "c1",
      session: { id: "agent-1" },
      message: "hello",
    });
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(store.getRun(runId)?.stage).toBe("agent_running");
    resolveAgent?.({ text: "late reply" });

    await expect(pending).resolves.toMatchObject({
      status: "response",
      response: { text: "late reply" },
    });
    expect(events.map((event) => event.event)).toEqual(["started", "stage_changed"]);
  });

  test("marks the run failed when final response cannot be sent", async () => {
    const { store, runId } = createStore();
    store.markRunStage(runId, "agent_running");
    const manager = new RunManager(new RecordingAgent(async () => ({ text: "reply" })), store, createSender({
      async sendFinalResponse() {
        return { ok: false, error: "all failed", methodsTried: ["card:create", "text:create", "file:create"] };
      },
    }));

    const result = await manager.sendFinalResponse({
      runId,
      chatId: "chat-open-id",
      header: "",
      content: "reply",
    });

    expect(result.ok).toBe(false);
    expect(store.getRun(runId)).toMatchObject({
      stage: "failed",
      lastError: "all failed",
    });
  });

  test("records timeout before failed when final response sending times out", async () => {
    const events: RuntimeStateEvent[] = [];
    const { store, runId } = createStore((event) => events.push(event));
    store.markRunStage(runId, "agent_running");
    const manager = new RunManager(new RecordingAgent(async () => ({ text: "reply" })), store, createSender({
      async sendFinalResponse() {
        return { ok: false, error: "im.sendCard timed out after 30ms", methodsTried: ["card:create"] };
      },
    }));

    const result = await manager.sendFinalResponse({
      runId,
      chatId: "chat-open-id",
      header: "",
      content: "reply",
    });

    expect(result.ok).toBe(false);
    expect(store.getRun(runId)?.stage).toBe("failed");
    expect(events.map((event) => event.event)).toEqual([
      "started",
      "stage_changed",
      "stage_changed",
      "timeout",
      "failed",
    ]);
  });

  test("marks the run stopped when the signal is aborted", async () => {
    const { store, runId } = createStore();
    const controller = new AbortController();
    controller.abort();
    const manager = new RunManager(new RecordingAgent(async () => ({ text: "reply" })), store, createSender());

    const result = await manager.runAgent({
      runId,
      chatId: "c1",
      session: { id: "agent-1" },
      message: "hello",
      signal: controller.signal,
    });

    expect(result.status).toBe("stopped");
    expect(store.getRun(runId)?.stage).toBe("stopped");
  });

  test("releases the run when the signal aborts during an agent call", async () => {
    const { store, runId } = createStore();
    const controller = new AbortController();
    let agentResolved = false;
    const manager = new RunManager(
      new RecordingAgent(() => new Promise<AgentResponse>(() => { agentResolved = true; })),
      store,
      createSender(),
    );

    const pending = manager.runAgent({
      runId,
      chatId: "c1",
      session: { id: "agent-1" },
      message: "hello",
      signal: controller.signal,
    });
    await Promise.resolve();

    controller.abort(new Error("stopped"));

    await expect(pending).resolves.toEqual({ status: "stopped" });
    expect(agentResolved).toBe(true);
    expect(store.getRun(runId)?.stage).toBe("stopped");
  });

  test("uses the standard empty response fallback", async () => {
    const { store, runId } = createStore();
    const manager = new RunManager(new RecordingAgent(async () => ({ text: "" })), store, createSender());

    const result = await manager.runAgent({
      runId,
      chatId: "c1",
      session: { id: "agent-1" },
      message: "hello",
    });

    expect(result.status).toBe("response");
    expect(result.response.text).toBe(EMPTY_RESPONSE_FALLBACK);
  });
});
