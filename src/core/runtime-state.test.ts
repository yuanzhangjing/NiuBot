import { describe, expect, test } from "vitest";
import { RuntimeStateStore, type RuntimeStateEvent } from "./runtime-state.js";

describe("RuntimeStateStore", () => {
  test("returns a stable idle state for a chat without runs", () => {
    const store = new RuntimeStateStore({ now: () => 1000 });

    expect(store.getChatState("c1")).toEqual({
      chatId: "c1",
      state: "idle",
      activeRunId: null,
      bufferMessageIds: [],
      pendingRunIds: [],
      updatedAt: 1000,
    });
  });

  test("creates a queued run and exposes it as the active run", () => {
    let now = 1000;
    const store = new RuntimeStateStore({
      now: () => now,
      createRunId: () => "run-1",
    });

    const run = store.createRun({
      chatId: "c1",
      triggerMessageIds: [1, 2],
      triggerPlatformMsgIds: ["m1", "m2"],
      replyToPlatformMsgId: "m2",
      mergedText: "hello",
    });

    expect(run).toEqual({
      runId: "run-1",
      chatId: "c1",
      triggerMessageIds: [1, 2],
      triggerPlatformMsgIds: ["m1", "m2"],
      replyToPlatformMsgId: "m2",
      mergedText: "hello",
      stage: "queued",
      startedAt: 1000,
      updatedAt: 1000,
    });
    expect(store.getActiveRun("c1")?.runId).toBe("run-1");
    expect(store.getChatState("c1").activeRunId).toBe("run-1");

    now = 1200;
    store.markRunStage("run-1", "agent_running");

    expect(store.getRun("run-1")?.stage).toBe("agent_running");
    expect(store.getChatState("c1").state).toBe("busy");
    expect(store.getChatState("c1").updatedAt).toBe(1200);
  });

  test("rejects invalid run stage transitions", () => {
    const store = new RuntimeStateStore({ createRunId: () => "run-1" });
    store.createRun({
      chatId: "c1",
      triggerMessageIds: [1],
      triggerPlatformMsgIds: ["m1"],
      mergedText: "hello",
    });

    expect(() => store.markRunStage("run-1", "sending_response")).toThrow("Invalid run stage transition");
    expect(store.getRun("run-1")?.stage).toBe("queued");
    expect(store.getChatState("c1").lastError).toContain("Invalid run stage transition");
  });

  test("does not allow terminal runs to return to running", () => {
    const store = new RuntimeStateStore({ createRunId: () => "run-1" });
    store.createRun({
      chatId: "c1",
      triggerMessageIds: [1],
      triggerPlatformMsgIds: ["m1"],
      mergedText: "hello",
    });
    store.markRunStage("run-1", "agent_running");
    store.markRunStage("run-1", "sending_response");
    store.markRunStage("run-1", "done");

    expect(store.getActiveRun("c1")).toBeNull();
    expect(store.getChatState("c1").state).toBe("idle");
    expect(() => store.markRunStage("run-1", "agent_running")).toThrow("Invalid run stage transition");
    expect(store.getRun("run-1")?.stage).toBe("done");
  });

  test("keeps pipeline health in sync with inflight runs", () => {
    const store = new RuntimeStateStore({ createRunId: () => "run-1" });

    store.createRun({
      chatId: "c1",
      triggerMessageIds: [1],
      triggerPlatformMsgIds: ["m1"],
      mergedText: "hello",
    });

    expect(store.getPipelineHealth().inflightRunIds).toEqual(["run-1"]);

    store.markRunStage("run-1", "failed", "agent failed");

    expect(store.getPipelineHealth().inflightRunIds).toEqual([]);
    expect(store.getPipelineHealth().lastError).toBe("agent failed");
    expect(store.getChatState("c1").lastError).toBe("agent failed");
  });

  test("lists runs for a chat in creation order", () => {
    const store = new RuntimeStateStore({
      createRunId: (() => {
        const ids = ["run-1", "run-2"];
        return () => ids.shift()!;
      })(),
    });

    store.createRun({
      chatId: "c1",
      triggerMessageIds: [1],
      triggerPlatformMsgIds: ["m1"],
      mergedText: "first",
    });
    store.createRun({
      chatId: "c1",
      triggerMessageIds: [2],
      triggerPlatformMsgIds: ["m2"],
      mergedText: "second",
    });

    expect(store.getRunsForChat("c1").map((run) => run.runId)).toEqual(["run-1", "run-2"]);
    expect(store.getRunsForChat("missing")).toEqual([]);
  });

  test("emits lifecycle events for run creation and stage changes", () => {
    const events: RuntimeStateEvent[] = [];
    let now = 1000;
    const store = new RuntimeStateStore({
      now: () => now,
      createRunId: () => "run-1",
      onEvent: (event) => events.push(event),
    });

    store.createRun({
      chatId: "c1",
      triggerMessageIds: [1, 2],
      triggerPlatformMsgIds: ["m1", "m2"],
      mergedText: "hello",
    });
    now = 1100;
    store.markRunStage("run-1", "agent_running");
    now = 1300;
    store.markRunStage("run-1", "sending_response");
    now = 1600;
    store.markRunStage("run-1", "done");

    expect(events).toEqual([
      {
        chatId: "c1",
        runId: "run-1",
        messageIds: [1, 2],
        stage: "queued",
        event: "started",
        elapsedMs: 0,
      },
      {
        chatId: "c1",
        runId: "run-1",
        messageIds: [1, 2],
        stage: "agent_running",
        event: "stage_changed",
        elapsedMs: 100,
      },
      {
        chatId: "c1",
        runId: "run-1",
        messageIds: [1, 2],
        stage: "sending_response",
        event: "stage_changed",
        elapsedMs: 300,
      },
      {
        chatId: "c1",
        runId: "run-1",
        messageIds: [1, 2],
        stage: "done",
        event: "done",
        elapsedMs: 600,
      },
    ]);
  });

  test("event listener failures do not break run state changes", () => {
    const store = new RuntimeStateStore({
      createRunId: () => "run-1",
      onEvent: () => { throw new Error("event write failed"); },
    });

    const run = store.createRun({
      chatId: "c1",
      triggerMessageIds: [1],
      triggerPlatformMsgIds: ["m1"],
      mergedText: "hello",
    });
    store.markRunStage(run.runId, "agent_running");

    expect(store.getRun(run.runId)?.stage).toBe("agent_running");
  });
});
