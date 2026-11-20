import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentSessionNotStartedError } from "../agent/types.js";
import { readAgyTranscript } from "../session-archive/native-transcript.js";
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
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--model");
    expect(args).toContain("gemini-4-argon-high");
    expect(args).toContain("--effort");
    expect(args).toContain("high");
    expect(args).not.toContain("--conversation");
  });

  it("omits --dangerously-skip-permissions when skipPermissions is false", () => {
    const backend = new AgyBackend({ skipPermissions: false });
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const { args } = backend.buildInput(session, "hello");
    expect(args).not.toContain("--dangerously-skip-permissions");
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
    const backend = new AgyBackend({ agyHome: mkdtempSync(join(tmpdir(), "agy-home-")) });
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const parsed = backend.parseOutput([INIT, DELTA("final "), DELTA("answer"), RESULT()].join("\n"), session);

    expect(parsed.text).toBe("final answer");
    expect(parsed.turnCompleted).toBe(true);
    expect(parsed.failed).toBe(false);
    expect(parsed.agentSessionId).toBe("conv-1");
    expect(parsed.contextTokens).toBe(26259);
    expect(parsed.contextWindow).toBe(1_048_576);
  });

  it("reads the resolved default model from the brain transcript when init omits model", () => {
    const agyHome = mkdtempSync(join(tmpdir(), "agy-home-"));
    const logDir = join(agyHome, "brain", "conv-1", ".system_generated", "logs");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "transcript.jsonl"), [
      JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "hi" }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        model: "gemini-4-carbon-medium",
        input_tokens: 13678,
        cache_read_tokens: 0,
        output_tokens: 138,
        content: "hello",
      }),
    ].join("\n"));

    const backend = new AgyBackend({ agyHome });
    const session = backend.buildSession({ workingDirectory: "/tmp" });
    const parsed = backend.parseOutput([INIT, RESULT()].join("\n"), session);

    expect(parsed.model).toBe("gemini-4-carbon-medium");
  });

  it("prefers init.model over older transcript entries and uses final step usage for contextTokens", () => {
    const agyHome = mkdtempSync(join(tmpdir(), "agy-home-"));
    const logDir = join(agyHome, "brain", "conv-1", ".system_generated", "logs");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "transcript.jsonl"), JSON.stringify({
      step_index: 1,
      type: "PLANNER_RESPONSE",
      model: "gemini-4-carbon-medium",
      input_tokens: 1000,
      cache_read_tokens: 0,
      output_tokens: 10,
    }));

    const initWithModel = JSON.stringify({
      event: "init",
      conversation_id: "conv-1",
      init: { model: "gemini-4-argon-high", cwd: "/tmp", tools: [], permission_mode: "always-proceed" },
    });
    const step1Done = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-1",
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        usage: { input_tokens: 13678, output_tokens: 138, thinking_tokens: 94, cache_read_tokens: 0, total_tokens: 13816 },
      },
    });
    const step3Done = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-1",
        step_index: 3,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "done\n",
        usage: { input_tokens: 2459, output_tokens: 288, thinking_tokens: 272, cache_read_tokens: 11624, total_tokens: 2747 },
      },
    });
    const cumulativeResult = RESULT({
      response: "done",
      usage: { input_tokens: 16137, output_tokens: 426, thinking_tokens: 366, cache_read_tokens: 11624, total_tokens: 16563 },
    });

    const backend = new AgyBackend({ agyHome });
    const session = backend.buildSession({ workingDirectory: "/tmp", model: "gemini-4-argon-high" });
    const parsed = backend.parseOutput([initWithModel, step1Done, step3Done, cumulativeResult].join("\n"), session);

    expect(parsed.model).toBe("gemini-4-argon-high");
    expect(parsed.contextTokens).toBe(2459 + 11624 + 288);
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

  it("marks a non-success result as failed while keeping turnCompleted true", () => {
    const backend = new AgyBackend({ agyHome: mkdtempSync(join(tmpdir(), "agy-home-")) });
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const parsed = backend.parseOutput(
      [INIT, RESULT({ status: "ERROR", response: "", error: "quota exhausted" })].join("\n"),
      session,
    );
    expect(parsed.failed).toBe(true);
    expect(parsed.turnCompleted).toBe(true);
    expect(parsed.error).toBe("quota exhausted");
    expect(parsed.text).toBe("");
  });

  it("treats a mid-turn stream interruption as recovered when a later agent_response completes", () => {
    const backend = new AgyBackend({ agyHome: mkdtempSync(join(tmpdir(), "agy-home-")) });
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const interruptedStep = JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: "conv-1", step_index: 94, state: "DONE", step_type: "agent_response" },
    });
    const errorStep = JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: "conv-1", step_index: 95, state: "DONE", step_type: "error_message" },
    });
    const recoveredStep = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-1",
        step_index: 98,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "recovered final answer\n",
        usage: { input_tokens: 2360, output_tokens: 690, cache_read_tokens: 177696 },
      },
    });
    const stickyErrorResult = RESULT({
      status: "ERROR",
      response: "recovered final answer\n",
      error: "The stream was interrupted. Please continue the task you were working on.",
      finished_reason: "error",
    });

    const parsed = backend.parseOutput(
      [INIT, interruptedStep, errorStep, recoveredStep, stickyErrorResult].join("\n"),
      session,
    );
    expect(parsed.turnCompleted).toBe(true);
    expect(parsed.failed).toBe(false);
    expect(parsed.error).toBeUndefined();
    expect(parsed.text).toBe("recovered final answer");
  });

  it("ignores sticky conversation-level result ERROR on subsequent clean resumed turns", () => {
    const backend = new AgyBackend({ agyHome: mkdtempSync(join(tmpdir(), "agy-home-")) });
    const session = backend.buildSession({ workingDirectory: "/tmp" });
    session.agentSessionId = "conv-1";

    const userStep = JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: "conv-1", step_index: 177, state: "DONE", step_type: "user_input" },
    });
    const cleanDoneStep = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-1",
        step_index: 181,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "all good\n",
        usage: { input_tokens: 3361, output_tokens: 453, cache_read_tokens: 244958 },
      },
    });
    const trailingSystemStep = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-1",
        step_index: 182,
        state: "DONE",
        step_type: "system_message",
      },
    });
    const historicalStickyResult = RESULT({
      status: "ERROR",
      response: "all good\n",
      error: "The stream was interrupted. Please continue the task you were working on.",
      num_turns: 6,
      finished_reason: "error",
    });

    const parsed = backend.parseOutput(
      [INIT, userStep, cleanDoneStep, trailingSystemStep, historicalStickyResult].join("\n"),
      session,
    );
    expect(parsed.turnCompleted).toBe(true);
    expect(parsed.failed).toBe(false);
    expect(parsed.error).toBeUndefined();
    expect(parsed.text).toBe("all good");
    expect(parsed.contextTokens).toBe(3361 + 244958 + 453);
  });

  it("still fails when an error_message occurs after the last completed agent_response", () => {
    const backend = new AgyBackend({ agyHome: mkdtempSync(join(tmpdir(), "agy-home-")) });
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const earlierResponse = JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: "conv-1", step_index: 1, state: "DONE", step_type: "agent_response" },
    });
    const terminalErrorStep = JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: "conv-1", step_index: 2, state: "DONE", step_type: "error_message" },
    });
    const failedResult = RESULT({
      status: "ERROR",
      response: "partial",
      error: "The stream was interrupted.",
    });

    const parsed = backend.parseOutput([INIT, earlierResponse, terminalErrorStep, failedResult].join("\n"), session);
    expect(parsed.turnCompleted).toBe(true);
    expect(parsed.failed).toBe(true);
    expect(parsed.error).toBe("The stream was interrupted.");
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

  it("counts completed checkpoint/compaction steps once per step_index as per-turn compactDelta", () => {
    const backend = new AgyBackend({ agyHome: mkdtempSync(join(tmpdir(), "agy-home-")) });
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const compactActive = JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: "conv-1", step_index: 5, state: "ACTIVE", step_type: "checkpoint" },
    });
    const compactDone = JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: "conv-1", step_index: 5, state: "DONE", step_type: "checkpoint" },
    });

    const first = backend.parseOutput([INIT, compactActive, compactDone, compactDone, RESULT()].join("\n"), session);
    expect(first.compactDelta).toBe(1);
    expect(first.compactCount).toBeUndefined();

    // 同 session 下一轮没有新压缩时，compactDelta 为 undefined，避免重复累加
    const second = backend.parseOutput([INIT, RESULT()].join("\n"), session);
    expect(second.compactDelta).toBeUndefined();
    expect(second.compactCount).toBeUndefined();

    // 新的 step_index 再次压缩时上报增量 1
    const compact2Done = JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: "conv-1", step_index: 18, state: "DONE", step_type: "compaction" },
    });
    const third = backend.parseOutput([INIT, compact2Done, RESULT()].join("\n"), session);
    expect(third.compactDelta).toBe(1);
    expect(third.compactCount).toBeUndefined();
  });

  it("tracks parallel tool execution and compaction state in activity", () => {
    const backend = new AgyBackend({ agyHome: mkdtempSync(join(tmpdir(), "agy-home-")) });
    const session = backend.buildSession({ workingDirectory: "/tmp" });
    (backend as any).sessions.set("h1", session);
    const hooks = (backend as any).getExecHooks(session) as { onLine?: (line: string) => void };
    const activity = {
      status: "running" as const,
      startedAt: 0,
      lastActiveAt: 0,
      completionDetected: false,
      compacting: false,
      recentLines: [] as string[],
      notifyCount: 0,
      executingTool: false,
    };

    hooks.onLine?.(INIT);
    hooks.onLine?.(JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: "conv-1", step_index: 1, state: "ACTIVE", step_type: "tool" },
    }));
    hooks.onLine?.(JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: "conv-1", step_index: 2, state: "ACTIVE", step_type: "tool" },
    }));
    (backend as any).refreshActivity("h1", activity);
    expect(activity.executingTool).toBe(true);

    hooks.onLine?.(JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: "conv-1", step_index: 1, state: "DONE", step_type: "tool" },
    }));
    (backend as any).refreshActivity("h1", activity);
    expect(activity.executingTool).toBe(true);

    hooks.onLine?.(JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: "conv-1", step_index: 2, state: "DONE", step_type: "tool" },
    }));
    hooks.onLine?.(JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: "conv-1", step_index: 3, state: "ACTIVE", step_type: "checkpoint" },
    }));
    (backend as any).refreshActivity("h1", activity);
    expect(activity.executingTool).toBe(false);
    expect(activity.compacting).toBe(true);

    hooks.onLine?.(RESULT());
    (backend as any).refreshActivity("h1", activity);
    expect(activity.executingTool).toBe(false);
    expect(activity.compacting).toBe(false);
  });
});

describe("AgyBackend transcript", () => {
  it("requires a native session id before exporting a transcript", async () => {
    const backend = new AgyBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });
    await expect((backend as any).loadSessionTranscript(session)).rejects.toBeInstanceOf(AgentSessionNotStartedError);
  });

  it("strips prompt wrappers and drops system steps", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "agy-tr-")), "transcript_full.jsonl");
    writeFileSync(file, [
      JSON.stringify({
        step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT",
        created_at: "2026-11-16T15:32:52Z",
        content: "<USER_REQUEST>\nremember pineapple\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime 23:32\n</ADDITIONAL_METADATA>",
      }),
      JSON.stringify({
        step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE",
        created_at: "2026-11-16T15:32:53Z", content: "got it",
      }),
      JSON.stringify({
        step_index: 2, source: "SYSTEM", type: "SYSTEM_MESSAGE",
        created_at: "2026-11-16T15:32:54Z", content: "internal note",
      }),
    ].join("\n"));

    const collected: any[] = [];
    for await (const event of readAgyTranscript(file, "conv-1").events as AsyncIterable<any>) collected.push(event);
    expect(collected).toEqual([
      { timestamp: "2026-11-16T15:32:52Z", type: "user", content: "remember pineapple" },
      { timestamp: "2026-11-16T15:32:53Z", type: "assistant", content: "got it" },
    ]);
  });

  it("populates recentLines with latest tool calls, results, errors, and clean user previews", () => {
    const agyHome = mkdtempSync(join(tmpdir(), "agy-home-"));
    const logDir = join(agyHome, "brain", "conv-1", ".system_generated", "logs");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "transcript.jsonl"), [
      JSON.stringify({
        step_index: 0,
        type: "USER_INPUT",
        content: "<USER_REQUEST>\n<niubot-system-rules>\nrules\n</niubot-system-rules>\n<niubot-user-message id=\"u1\" length=\"4\">\nhi\n</niubot-user-message id=\"u1\">\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        content: "older reply",
      }),
      JSON.stringify({
        step_index: 2,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "run_command", args: { CommandLine: "\"npm test\"", toolSummary: "\"Run unit tests\"" } }],
      }),
      JSON.stringify({
        step_index: 3,
        type: "GENERIC",
        status: "DONE",
        content: "Created At: 2026-11-17T15:20:00+08:00\nCompleted At: 2026-11-17T15:20:05+08:00\nCreated At: 2026-11-17T15:20:00+08:00\nCompleted At: 2026-11-17T15:20:05+08:00\nCommand exited with code 0.\n\nCommand output:\nall passed",
      }),
      JSON.stringify({
        step_index: 4,
        type: "ERROR_MESSAGE",
        error: "The stream was interrupted.",
      }),
    ].join("\n"));

    const backend = new AgyBackend({ agyHome });
    const session = backend.buildSession({ workingDirectory: "/tmp" });
    session.agentSessionId = "conv-1";
    (backend as any).sessions.set("h1", session);

    const activity = {
      status: "running" as const,
      startedAt: 0,
      lastActiveAt: 0,
      completionDetected: false,
      compacting: false,
      recentLines: ['{"event":"step_update"}'],
      notifyCount: 0,
    };
    (backend as any).refreshActivity("h1", activity);

    expect(activity.recentLines).toEqual([
      "tool: run_command Run unit tests",
      "result: exit 0 · all passed",
      "error: The stream was interrupted.",
    ]);
  });

  it("finds latest steps past >40 skipped SYSTEM_MESSAGE entries and strips injected user rules", () => {
    const agyHome = mkdtempSync(join(tmpdir(), "agy-home-"));
    const logDir = join(agyHome, "brain", "conv-1", ".system_generated", "logs");
    mkdirSync(logDir, { recursive: true });
    const lines = [
      JSON.stringify({
        step_index: 0,
        type: "USER_INPUT",
        content: "<USER_REQUEST>\n<niubot-system-rules>\nsecret rules\n</niubot-system-rules>\n<niubot-user-message id=\"a1\" length=\"5\">\ncheck\n</niubot-user-message id=\"a1\">\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 1,
        type: "GENERIC",
        status: "RUNNING",
        content: "Created At: 2026-11-17T15:20:00+08:00\nTool is running as a background task with task id: task-1",
      }),
      ...Array.from({ length: 45 }, (_, idx) => JSON.stringify({
        step_index: idx + 2,
        type: "SYSTEM_MESSAGE",
        content: `system notice ${idx}`,
      })),
    ];
    writeFileSync(join(logDir, "transcript.jsonl"), lines.join("\n"));

    const backend = new AgyBackend({ agyHome });
    const session = backend.buildSession({ workingDirectory: "/tmp" });
    session.agentSessionId = "conv-1";
    (backend as any).sessions.set("h1", session);

    const activity = {
      status: "running" as const,
      startedAt: 0,
      lastActiveAt: 0,
      completionDetected: false,
      compacting: false,
      recentLines: ['{"event":"init"}'],
      notifyCount: 0,
    };
    (backend as any).refreshActivity("h1", activity);

    expect(activity.recentLines).toEqual([
      "user: check",
      "running: Tool is running as a background task with task id: task-1",
    ]);
  });
});
