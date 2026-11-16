import { describe, expect, it } from "vitest";
import AgyBackend from "./agy.js";

const INIT = JSON.stringify({
  event: "init",
  conversation_id: "conv-1",
  init: { cwd: "/tmp", tools: [], permission_mode: "always-proceed" },
});

const DELTA = (text: string) => JSON.stringify({
  event: "step_update",
  step_update: {
    conversation_id: "conv-1",
    step_index: 1,
    state: "ACTIVE",
    step_type: "agent_response",
    text_delta: text,
  },
});

const RESULT = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  event: "result",
  result: {
    conversation_id: "conv-1",
    status: "SUCCESS",
    response: "final answer",
    duration_seconds: 2,
    num_turns: 1,
    usage: { input_tokens: 26247, output_tokens: 12, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 26259 },
    ...overrides,
  },
});

describe("AgyBackend", () => {
  it("starts a new conversation with message, model and effort", () => {
    const backend = new AgyBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp", model: "gemini-4-argon-high", reasoningEffort: "high" });

    const { args } = backend.buildInput(session, "hello");
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("hello");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--model");
    expect(args).toContain("gemini-4-argon-high");
    expect(args).toContain("--effort");
    expect(args).toContain("high");
    expect(args).not.toContain("--conversation");
  });

  it("resumes with --conversation once a native id exists", () => {
    const backend = new AgyBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });
    session.agentSessionId = "conv-1";

    const { args } = backend.buildInput(session, "again");
    expect(args).toContain("--conversation");
    expect(args[args.indexOf("--conversation") + 1]).toBe("conv-1");
  });

  it("redacts the message in logged args", () => {
    const backend = new AgyBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });
    const { args } = backend.buildInput(session, "secret prompt");

    const logged = (backend as any).argsForLog(args) as string[];
    expect(logged).not.toContain("secret prompt");
    expect(logged[logged.indexOf("-p") + 1]).toBe("<message>");
  });

  it("parses a successful turn", () => {
    const backend = new AgyBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const parsed = backend.parseOutput([INIT, DELTA("final "), DELTA("answer"), RESULT()].join("\n"), session);

    expect(parsed.text).toBe("final answer");
    expect(parsed.turnCompleted).toBe(true);
    expect(parsed.failed).toBe(false);
    expect(parsed.agentSessionId).toBe("conv-1");
    expect(parsed.contextTokens).toBe(26247);
    expect(parsed.contextWindow).toBe(1_048_576);
  });

  it("prefers the final response over streamed fragments", () => {
    const backend = new AgyBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const parsed = backend.parseOutput(
      [INIT, DELTA("partial"), RESULT({ response: "authoritative" })].join("\n"),
      session,
    );
    expect(parsed.text).toBe("authoritative");
  });

  it("keeps streamed text when no terminal event arrives", () => {
    const backend = new AgyBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const parsed = backend.parseOutput([INIT, DELTA("工作")].join("\n"), session);
    expect(parsed.turnCompleted).toBe(false);
    expect(parsed.incompleteReason).toContain("result");
    expect(parsed.lastMessage).toBe("工作");
  });

  it("marks a non-success result as failed", () => {
    const backend = new AgyBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const parsed = backend.parseOutput(
      [INIT, RESULT({ status: "ERROR", response: "", error: "quota exhausted" })].join("\n"),
      session,
    );
    expect(parsed.failed).toBe(true);
    expect(parsed.turnCompleted).toBe(false);
    expect(parsed.error).toBe("quota exhausted");
  });

  it("captures the conversation id as soon as init arrives", () => {
    const backend = new AgyBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });
    const hooks = (backend as any).getExecHooks(session) as {
      onLine?: (line: string) => void;
      isComplete?: (line: string) => boolean;
    };

    hooks.onLine?.(INIT);
    expect(session.agentSessionId).toBe("conv-1");

    expect(hooks.isComplete?.(INIT)).toBe(false);
    expect(hooks.isComplete?.(DELTA("x"))).toBe(false);
    expect(hooks.isComplete?.(RESULT())).toBe(true);
  });
});
