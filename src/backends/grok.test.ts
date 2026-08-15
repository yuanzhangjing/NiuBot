import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import GrokBackend, { countGrokCompactionSegments, encodeGrokSessionDir, extractLastGrokAssistant, extractLastGrokAssistantText } from "./grok.js";

function setTestHome(home: string): void {
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("GROK_HOME", path.join(home, ".grok"));
}

const GROK_USAGE = {
  input_tokens: 4413,
  cache_read_input_tokens: 11520,
  cache_creation_input_tokens: 0,
  output_tokens: 34,
  reasoning_tokens: 29,
  total_tokens: 15967,
};

const GROK_MODEL_USAGE = {
  "grok-4.6-build": {
    inputTokens: 4413,
    outputTokens: 34,
    cacheReadInputTokens: 11520,
    cacheCreationInputTokens: 0,
    modelCalls: 1,
  },
};

function grokStream(events: Record<string, unknown>[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

function grokEnd(overrides: Record<string, unknown> = {}): string {
  const { text = "pong", ...endOverrides } = overrides;
  return grokStream([
    { type: "text", data: text },
    {
      type: "end",
      stopReason: "end_turn",
      sessionId: "019ffb94-1c5b-72f3-b3eb-42e766619372",
      requestId: "764fde96-8ab6-48d2-9ae5-c9aa5e6440de",
      usage: GROK_USAGE,
      modelUsage: GROK_MODEL_USAGE,
      ...endOverrides,
    },
  ]);
}

describe("GrokBackend", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds streaming-json args and preassigns session id for a new session", () => {
    const backend = new GrokBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp/workspace",
      model: "grok-4.6",
      importantContext: "You are NiuBot.",
    });

    const input = backend.buildInput(session, "hello");

    expect(session.agentSessionId).toBeUndefined();
    expect(session.clientSessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(input.args).toEqual([
      "-p", "hello",
      "--output-format", "streaming-json",
      "--always-approve",
      "--no-memory",
      "--verbatim",
      "--cwd", "/tmp/workspace",
      "--model", "grok-4.6",
      "--rules", "You are NiuBot.",
      "--session-id", session.clientSessionId,
    ]);
    expect(input.args).not.toContain("--resume");
    expect(input.stdin).toBeUndefined();
  });

  it("omits --model when NiuBot config does not set one", () => {
    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });
    const input = backend.buildInput(session, "hello");

    expect(input.args).toEqual([
      "-p", "hello",
      "--output-format", "streaming-json",
      "--always-approve",
      "--no-memory",
      "--verbatim",
      "--cwd", "/tmp",
      "--session-id", session.clientSessionId,
    ]);
  });

  it("passes reasoning effort as --reasoning-effort", () => {
    const backend = new GrokBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp",
      reasoningEffort: "high",
    });
    const input = backend.buildInput(session, "hello");

    expect(input.args).toContain("--reasoning-effort");
    expect(input.args).toContain("high");
  });

  it("resumes with --resume when agentSessionId is present", () => {
    const backend = new GrokBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp",
      model: "grok-4.6",
      agentSessionId: "019ffb94-1c5b-72f3-b3eb-42e766619372",
    });

    const input = backend.buildInput(session, "continue");

    expect(input.args).toContain("--resume");
    expect(input.args).toContain("019ffb94-1c5b-72f3-b3eb-42e766619372");
    expect(input.args).not.toContain("--session-id");
    expect(input.args).toContain("-p");
    expect(input.args).toContain("continue");
  });

  it("switches first-turn --session-id to --resume if the session dir already exists", () => {
    const sessionId = "019ffb94-eeee-72f3-b3eb-42e766619372";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(tempHome, "workspace");
    fs.mkdirSync(workingDirectory, { recursive: true });
    setTestHome(tempHome);
    fs.mkdirSync(path.join(
      tempHome,
      ".grok",
      "sessions",
      encodeGrokSessionDir(workingDirectory),
      sessionId,
    ), { recursive: true });

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory, agentSessionId: sessionId });
    session.isNewSession = true;
    const input = backend.buildInput(session, "hello");

    expect(session.isNewSession).toBe(false);
    expect(input.args).toContain("--resume");
    expect(input.args).not.toContain("--session-id");
  });

  it("completes a turn on streaming type=end and captures session id from the stream", () => {
    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });
    const hooks = (backend as any).getExecHooks(session);
    const endLine = JSON.stringify({ type: "end", sessionId: "stream-session" });

    hooks.onLine(endLine);
    expect(session.agentSessionId).toBe("stream-session");
    expect(session.isNewSession).toBe(false);
    expect(hooks.isComplete(endLine)).toBe(true);
    expect(hooks.isComplete(JSON.stringify({ type: "text", data: "hi" }))).toBe(false);
    expect(typeof hooks.pollComplete).toBe("function");
  });

  it("hides prompt and rules in log args", () => {
    const backend = new GrokBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp",
      importantContext: "secret system rules",
    });
    const { args } = backend.buildInput(session, "user secret");
    const logged = (backend as any).argsForLog(args) as string[];

    expect(logged).not.toContain("user secret");
    expect(logged).not.toContain("secret system rules");
    expect(logged).toContain("[-p]");
    expect(logged).toContain("[--rules]");
  });

  it("extracts the last no-tool assistant in the current turn", () => {
    const history = [
      JSON.stringify({ type: "user", content: "hi" }),
      JSON.stringify({ type: "assistant", content: "先确认当前场景。", tool_calls: [{ id: "c1", name: "read_file" }] }),
      JSON.stringify({ type: "tool_result", tool_call_id: "c1", content: "ok" }),
      JSON.stringify({ type: "assistant", content: "在。链路通了。" }),
    ].join("\n");

    expect(extractLastGrokAssistantText(history)).toBe("在。链路通了。");
  });

  it("does not leak the previous turn when scanning history", () => {
    const history = [
      JSON.stringify({ type: "user", content: "first" }),
      JSON.stringify({ type: "assistant", content: "上一轮最终答复" }),
      JSON.stringify({ type: "user", content: "second" }),
      JSON.stringify({ type: "assistant", content: "先查一下。", tool_calls: [{ id: "c1", name: "grep" }] }),
      JSON.stringify({ type: "assistant", content: "当前是 default。" }),
    ].join("\n");

    expect(extractLastGrokAssistantText(history)).toBe("当前是 default。");
  });

  it("skips empty assistant rows and falls back to last tool-call aside", () => {
    const history = [
      JSON.stringify({ type: "user", content: "hi" }),
      JSON.stringify({ type: "assistant", content: "只有旁白", tool_calls: [{ id: "c1", name: "read_file" }] }),
      JSON.stringify({ type: "assistant", content: "", tool_calls: [{ id: "c2", name: "grep" }] }),
    ].join("\n");

    expect(extractLastGrokAssistantText(history)).toBe("只有旁白");
  });

  it("extracts model_id from the last no-tool assistant in the current turn", () => {
    const history = [
      JSON.stringify({ type: "user", content: "hi" }),
      JSON.stringify({ type: "assistant", content: "先搜一下。", model_id: "grok-4.5-build", tool_calls: [{ id: "c1", name: "web_search" }] }),
      JSON.stringify({ type: "assistant", content: "额度比 Claude 紧。", model_id: "grok-4.6-build" }),
    ].join("\n");

    expect(extractLastGrokAssistant(history)).toEqual({
      text: "额度比 Claude 紧。",
      model: "grok-4.6-build",
    });
  });

  it("falls back to last tool-call model_id when the final assistant has none", () => {
    const history = [
      JSON.stringify({ type: "user", content: "hi" }),
      JSON.stringify({ type: "assistant", content: "先读文件。", model_id: "grok-4.6-build", tool_calls: [{ id: "c1", name: "read_file" }] }),
      JSON.stringify({ type: "assistant", content: "读完了。" }),
    ].join("\n");

    expect(extractLastGrokAssistant(history)).toEqual({
      text: "读完了。",
      model: "grok-4.6-build",
    });
  });

  it("prefers last assistant text over concatenated stdout text", () => {
    const sessionId = "019ffb94-cccc-72f3-b3eb-42e766619372";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(tempHome, "workspace");
    fs.mkdirSync(workingDirectory, { recursive: true });
    setTestHome(tempHome);

    const sessionDir = path.join(
      tempHome,
      ".grok",
      "sessions",
      encodeGrokSessionDir(workingDirectory),
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "chat_history.jsonl"), [
      JSON.stringify({ type: "user", content: "hi" }),
      JSON.stringify({ type: "assistant", content: "先确认当前场景和飞书回复规则，再回这句测试消息。", tool_calls: [{ id: "c1", name: "read_file" }] }),
      JSON.stringify({ type: "tool_result", tool_call_id: "c1", content: "ok" }),
      JSON.stringify({ type: "assistant", content: "在。grok 这条链路通了。\n\n要测完整一轮的话，丢个具体问题过来就行。" }),
    ].join("\n"));

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory });
    const parsed = backend.parseOutput(grokEnd({
      sessionId,
      text: "先确认当前场景和飞书回复规则，再回这句测试消息。在。grok 这条链路通了。\n\n要测完整一轮的话，丢个具体问题过来就行。",
    }), session);

    expect(parsed.text).toBe("在。grok 这条链路通了。\n\n要测完整一轮的话，丢个具体问题过来就行。");
    expect(parsed.text).not.toContain("先确认当前场景");
    expect(parsed.lastMessage).toBe(parsed.text);
  });

  it("falls back to stdout when history last assistant is not in this turn", () => {
    const sessionId = "019ffb94-dddd-72f3-b3eb-42e766619372";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(tempHome, "workspace");
    fs.mkdirSync(workingDirectory, { recursive: true });
    setTestHome(tempHome);

    const sessionDir = path.join(
      tempHome,
      ".grok",
      "sessions",
      encodeGrokSessionDir(workingDirectory),
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "chat_history.jsonl"),
      JSON.stringify({ type: "assistant", content: "上一轮最终答复" }),
    );

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory, agentSessionId: sessionId });
    backend.buildInput(session, "当前是什么模型");
    const parsed = backend.parseOutput(grokEnd({
      sessionId,
      text: "先查一下。当前是 default。",
    }), session);

    expect(parsed.text).toBe("先查一下。当前是 default。");
  });

  it("parses assistant text, session id, model, and usage from json result", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    setTestHome(tempHome);
    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory: path.join(tempHome, "workspace"), model: "grok-4.6" });

    const parsed = backend.parseOutput(grokEnd(), session);

    expect(parsed.text).toBe("pong");
    expect(parsed.turnCompleted).toBe(true);
    expect(parsed.agentSessionId).toBe("019ffb94-1c5b-72f3-b3eb-42e766619372");
    expect(parsed.model).toBe("grok-4.6-build");
    expect(parsed.contextTokens).toBe(15967);
    expect(session.agentSessionId).toBe("019ffb94-1c5b-72f3-b3eb-42e766619372");
  });

  it("parses a compact single-line end event", () => {
    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });
    const parsed = backend.parseOutput(JSON.stringify({
      type: "end",
      stopReason: "end_turn",
      sessionId: "s1",
    }), session);

    expect(parsed.text).toBe("");
    expect(parsed.turnCompleted).toBe(true);
    expect(parsed.agentSessionId).toBe("s1");
  });

  it("marks a missing end event as incomplete", () => {
    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const parsed = backend.parseOutput(JSON.stringify({ type: "text", data: "still thinking..." }), session);

    expect(parsed.turnCompleted).toBe(false);
    expect(parsed.incompleteReason).toBe("未收到 grok turn_ended / end");
    expect(parsed.text).toBe("still thinking...");
    expect(parsed.agentSessionId).toBeUndefined();
    expect(session.agentSessionId).toBeUndefined();
  });

  it("ignores leftover turn_ended and previous assistant after a new prompt", () => {
    const sessionId = "019ffb94-stale-72f3-b3eb-42e766619372";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(tempHome, "workspace");
    fs.mkdirSync(workingDirectory, { recursive: true });
    setTestHome(tempHome);

    const sessionDir = path.join(
      tempHome,
      ".grok",
      "sessions",
      encodeGrokSessionDir(workingDirectory),
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    const oldTs = new Date(Date.now() - 3_600_000).toISOString();
    fs.writeFileSync(
      path.join(sessionDir, "events.jsonl"),
      [
        JSON.stringify({ type: "turn_started", ts: oldTs, turn_number: 74 }),
        JSON.stringify({ type: "turn_ended", ts: oldTs, outcome: "completed" }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(sessionDir, "chat_history.jsonl"),
      [
        JSON.stringify({ type: "user", content: "重启了吗" }),
        JSON.stringify({ type: "assistant", content: "还是 dev，版本 0.2.29-dev.1。", model_id: "grok-4.6-build" }),
      ].join("\n"),
    );

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory, agentSessionId: sessionId });
    backend.buildInput(session, "coding 怎么默认派给指定 agent");
    const hooks = (backend as any).getExecHooks(session);

    expect(hooks.pollComplete()).toBe(false);
    const parsed = backend.parseOutput("", session);
    expect(parsed.turnCompleted).toBe(false);
    expect(parsed.text).toBe("");
  });

  it("completes a turn from this prompt's turn_ended without waiting for stdout end", () => {
    const sessionId = "019ffb94-eded-72f3-b3eb-42e766619372";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(tempHome, "workspace");
    fs.mkdirSync(workingDirectory, { recursive: true });
    setTestHome(tempHome);

    const sessionDir = path.join(
      tempHome,
      ".grok",
      "sessions",
      encodeGrokSessionDir(workingDirectory),
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    const oldTs = new Date(Date.now() - 3_600_000).toISOString();
    fs.writeFileSync(
      path.join(sessionDir, "events.jsonl"),
      JSON.stringify({ type: "turn_ended", ts: oldTs, outcome: "completed" }) + "\n",
    );
    fs.writeFileSync(
      path.join(sessionDir, "chat_history.jsonl"),
      [
        JSON.stringify({ type: "user", content: "重启了吗" }),
        JSON.stringify({ type: "assistant", content: "还是 dev，版本 0.2.29-dev.1。", model_id: "grok-4.6-build" }),
      ].join("\n"),
    );

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory, agentSessionId: sessionId });
    backend.buildInput(session, "coding 怎么默认派给指定 agent");
    const hooks = (backend as any).getExecHooks(session);
    expect(hooks.pollComplete()).toBe(false);

    const nowTs = new Date().toISOString();
    fs.appendFileSync(
      path.join(sessionDir, "events.jsonl"),
      [
        JSON.stringify({ type: "turn_started", ts: nowTs, turn_number: 75 }),
        JSON.stringify({ type: "turn_ended", ts: nowTs, outcome: "completed" }),
      ].join("\n") + "\n",
    );
    expect(hooks.pollComplete()).toBe(false);

    fs.appendFileSync(
      path.join(sessionDir, "chat_history.jsonl"),
      "\n" + [
        JSON.stringify({ type: "user", content: "coding 怎么默认派给指定 agent" }),
        JSON.stringify({ type: "assistant", content: "主会话写不了业务代码，写代码只派给指定那个。", model_id: "grok-4.6-build" }),
      ].join("\n"),
    );

    expect(hooks.pollComplete()).toBe(true);
    const parsed = backend.parseOutput(JSON.stringify({ type: "text", data: "主会话" }), session);
    expect(parsed.turnCompleted).toBe(true);
    expect(parsed.text).toBe("主会话写不了业务代码，写代码只派给指定那个。");
    expect(parsed.model).toBe("grok-4.6-build");
  });

  it("still completes when this turn's reply text matches the previous turn", () => {
    const sessionId = "019ffb94-same-72f3-b3eb-42e766619372";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(tempHome, "workspace");
    fs.mkdirSync(workingDirectory, { recursive: true });
    setTestHome(tempHome);

    const sessionDir = path.join(
      tempHome,
      ".grok",
      "sessions",
      encodeGrokSessionDir(workingDirectory),
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "events.jsonl"), "");
    fs.writeFileSync(
      path.join(sessionDir, "chat_history.jsonl"),
      [
        JSON.stringify({ type: "user", content: "在吗" }),
        JSON.stringify({ type: "assistant", content: "在。", model_id: "grok-4.6-build" }),
      ].join("\n"),
    );

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory, agentSessionId: sessionId });
    backend.buildInput(session, "还在吗");
    const nowTs = new Date().toISOString();
    fs.appendFileSync(
      path.join(sessionDir, "events.jsonl"),
      [
        JSON.stringify({ type: "turn_started", ts: nowTs, turn_number: 2 }),
        JSON.stringify({ type: "turn_ended", ts: nowTs, outcome: "completed" }),
      ].join("\n") + "\n",
    );
    fs.appendFileSync(
      path.join(sessionDir, "chat_history.jsonl"),
      "\n" + [
        JSON.stringify({ type: "user", content: "还在吗" }),
        JSON.stringify({ type: "assistant", content: "在。", model_id: "grok-4.6-build" }),
      ].join("\n"),
    );

    const hooks = (backend as any).getExecHooks(session);
    expect(hooks.pollComplete()).toBe(true);
    const parsed = backend.parseOutput("", session);
    expect(parsed.turnCompleted).toBe(true);
    expect(parsed.text).toBe("在。");
  });

  it("does not treat a cancelled turn_ended as sendable", () => {
    const sessionId = "019ffb94-ca11-72f3-b3eb-42e766619372";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(tempHome, "workspace");
    fs.mkdirSync(workingDirectory, { recursive: true });
    setTestHome(tempHome);
    const sessionDir = path.join(
      tempHome,
      ".grok",
      "sessions",
      encodeGrokSessionDir(workingDirectory),
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "events.jsonl"), "");
    fs.writeFileSync(path.join(sessionDir, "chat_history.jsonl"), "");

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory, agentSessionId: sessionId });
    backend.buildInput(session, "继续");
    const nowTs = new Date().toISOString();
    fs.appendFileSync(
      path.join(sessionDir, "events.jsonl"),
      [
        JSON.stringify({ type: "turn_started", ts: nowTs, turn_number: 1 }),
        JSON.stringify({ type: "turn_ended", ts: nowTs, outcome: "cancelled" }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(sessionDir, "chat_history.jsonl"),
      [
        JSON.stringify({ type: "user", content: "继续" }),
        JSON.stringify({ type: "assistant", content: "半截。" }),
      ].join("\n"),
    );

    const hooks = (backend as any).getExecHooks(session);
    expect(hooks.pollComplete()).toBe(false);
    expect(backend.parseOutput(JSON.stringify({ type: "text", data: "半截。" }), session).turnCompleted).toBe(false);
  });

  it("surfaces grok error objects", () => {
    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const parsed = backend.parseOutput(JSON.stringify({
      type: "error",
      message: "Couldn't start session: model not available",
    }), session);

    expect(parsed.text).toBe("");
    expect(parsed.turnCompleted).toBe(false);
    expect(parsed.error).toBe("Couldn't start session: model not available");
    expect(parsed.failed).toBe(true);
  });

  it("treats error followed by end as a failed turn", () => {
    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const parsed = backend.parseOutput([
      JSON.stringify({ type: "error", message: "model not available" }),
      JSON.stringify({ type: "end", stopReason: "error", sessionId: "s-err" }),
    ].join("\n"), session);

    expect(parsed.turnCompleted).toBe(true);
    expect(parsed.failed).toBe(true);
    expect(parsed.error).toBe("model not available");
    expect(parsed.text).toBe("");
    expect(parsed.agentSessionId).toBe("s-err");
  });

  it("hydrates model and compact count from grok session files", () => {
    const sessionId = "019ffb94-1c5b-72f3-b3eb-42e766619372";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(tempHome, "workspace");
    fs.mkdirSync(workingDirectory, { recursive: true });
    setTestHome(tempHome);

    const sessionDir = path.join(
      tempHome,
      ".grok",
      "sessions",
      encodeGrokSessionDir(workingDirectory),
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "summary.json"), JSON.stringify({
      current_model_id: "grok-4.6",
    }));
    fs.writeFileSync(path.join(sessionDir, "signals.json"), JSON.stringify({
      compactionCount: 2,
    }));
    fs.mkdirSync(path.join(sessionDir, "compaction"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "compaction", "INDEX.md"), "# index\n");
    fs.writeFileSync(path.join(sessionDir, "compaction", "segment_000.md"), "# segment\n");
    fs.writeFileSync(
      path.join(sessionDir, "chat_history.jsonl"),
      JSON.stringify({ type: "assistant", content: "done", model_id: "grok-4.6-build" }),
    );

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory, agentSessionId: sessionId });
    const parsed = backend.parseOutput(grokEnd({ sessionId }), session);

    expect(parsed.model).toBe("grok-4.6-build");
    expect(parsed.compactCount).toBe(1);
    expect(countGrokCompactionSegments(sessionDir)).toBe(1);
    expect(parsed.contextTokens).toBe(15967);
    expect(parsed.contextWindow).toBeUndefined();
    expect((backend as any).probeSessionFileMtime(session)).toBeGreaterThan(0);
  });

  it("prefers signals.json context window over spend total_tokens", () => {
    const sessionId = "019ffb94-1010-72f3-b3eb-42e766619372";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(tempHome, "workspace");
    fs.mkdirSync(workingDirectory, { recursive: true });
    setTestHome(tempHome);

    const sessionDir = path.join(
      tempHome,
      ".grok",
      "sessions",
      encodeGrokSessionDir(workingDirectory),
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "signals.json"), JSON.stringify({
      primaryModelId: "grok-4.5",
      contextTokensUsed: 184851,
      contextWindowTokens: 500000,
      compactionCount: 0,
    }));
    fs.writeFileSync(
      path.join(sessionDir, "chat_history.jsonl"),
      JSON.stringify({ type: "assistant", content: "pong", model_id: "grok-4.6-build" }),
    );

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory, agentSessionId: sessionId });
    const parsed = backend.parseOutput(grokEnd({
      sessionId,
      usage: { ...GROK_USAGE, total_tokens: 3_866_211 },
    }), session);

    expect(parsed.contextTokens).toBe(184851);
    expect(parsed.contextWindow).toBe(500000);
    expect(parsed.model).toBe("grok-4.6-build");
    expect(parsed.compactCount).toBeUndefined();
  });

  it("picks up a new compaction segment across turns", () => {
    const sessionId = "019ffb94-aaaa-72f3-b3eb-42e766619372";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(tempHome, "workspace");
    fs.mkdirSync(workingDirectory, { recursive: true });
    setTestHome(tempHome);

    const sessionDir = path.join(
      tempHome,
      ".grok",
      "sessions",
      encodeGrokSessionDir(workingDirectory),
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    const eventsPath = path.join(sessionDir, "events.jsonl");
    fs.writeFileSync(eventsPath, JSON.stringify({ type: "turn_started" }));
    const compactionDir = path.join(sessionDir, "compaction");

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory, agentSessionId: sessionId });
    const first = backend.parseOutput(grokEnd({ sessionId, text: "first" }), session);
    expect(first.compactCount).toBeUndefined();

    fs.mkdirSync(compactionDir, { recursive: true });
    fs.writeFileSync(path.join(compactionDir, "segment_000.md"), "# first compact\n");
    const second = backend.parseOutput(grokEnd({ sessionId, text: "second" }), session);
    expect(second.compactCount).toBe(1);
  });

  it("loads transcript from chat_history.jsonl", async () => {
    const sessionId = "019ffb94-bbbb-72f3-b3eb-42e766619372";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(tempHome, "workspace");
    fs.mkdirSync(workingDirectory, { recursive: true });
    setTestHome(tempHome);

    const sessionDir = path.join(
      tempHome,
      ".grok",
      "sessions",
      encodeGrokSessionDir(workingDirectory),
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    const history = path.join(sessionDir, "chat_history.jsonl");
    fs.writeFileSync(history, [
      JSON.stringify({ type: "user", content: "hello" }),
      JSON.stringify({ type: "assistant", content: "pong" }),
    ].join("\n"));

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory });
    session.agentSessionId = sessionId;
    const transcript = await (backend as any).loadSessionTranscript(session);

    expect(transcript.backend).toBe("grok");
    expect(transcript.agentSessionId).toBe(sessionId);
    expect(transcript.sources).toEqual([{ path: history, role: "history" }]);
  });

  it("encodes cwd into grok session directory slug", () => {
    const encoded = encodeGrokSessionDir(path.resolve(os.tmpdir(), "grok-session"));
    expect(encoded).toMatch(/%2F|%5C/i);
    expect(encoded).not.toMatch(/[\\/]/);
  });

  it("refreshActivity fills status recentLines from chat_history messages", () => {
    const sessionId = "019ffb94-ffff-72f3-b3eb-42e766619372";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(tempHome, "workspace");
    fs.mkdirSync(workingDirectory, { recursive: true });
    setTestHome(tempHome);

    const sessionDir = path.join(
      tempHome,
      ".grok",
      "sessions",
      encodeGrokSessionDir(workingDirectory),
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "events.jsonl"), [
      JSON.stringify({ ts: "2026-08-13T15:00:02.000Z", type: "tool_started", tool_name: "read_file" }),
      JSON.stringify({ ts: "2026-08-13T15:00:05.000Z", type: "tool_started", tool_name: "run_terminal_command" }),
    ].join("\n") + "\n");
    fs.writeFileSync(path.join(sessionDir, "chat_history.jsonl"), [
      JSON.stringify({ type: "user", content: "hi" }),
      JSON.stringify({ type: "assistant", content: "先看 chat_history。", tool_calls: [{ name: "read_file" }, { name: "run_terminal_command" }] }),
    ].join("\n"));

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory, agentSessionId: sessionId });
    const niubotSessionId = "niubot-session-1";
    (backend as any).sessions.set(niubotSessionId, session);
    const activity = {
      status: "running" as const,
      startedAt: Date.now(),
      lastActiveAt: 0,
      completionDetected: false,
      compacting: false,
      recentLines: [] as string[],
      notifyCount: 0,
    };

    (backend as any).refreshActivity(niubotSessionId, activity);

    expect(activity.recentLines).toEqual([
      JSON.stringify({ type: "user", content: "hi" }),
      JSON.stringify({ type: "assistant", content: "先看 chat_history。", tool_calls: [{ name: "read_file" }, { name: "run_terminal_command" }] }),
    ]);
    expect(activity.executingTool).toBe(true);
    expect(activity.lastActiveAt).toBe(Date.parse("2026-08-13T15:00:05.000Z"));
    expect((backend as any).probeSessionLastLine(session)).toContain("先看 chat_history");
  });

  it("refreshActivity records compact events once", () => {
    const sessionId = "019ffb94-2020-72f3-b3eb-42e766619372";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(tempHome, "workspace");
    fs.mkdirSync(workingDirectory, { recursive: true });
    setTestHome(tempHome);

    const sessionDir = path.join(
      tempHome,
      ".grok",
      "sessions",
      encodeGrokSessionDir(workingDirectory),
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "events.jsonl"), [
      JSON.stringify({ ts: "2026-08-13T15:00:00.000Z", type: "auto_compact_start" }),
      JSON.stringify({ ts: "2026-08-13T15:00:01.000Z", type: "auto_compact_end" }),
    ].join("\n") + "\n");
    fs.mkdirSync(path.join(sessionDir, "compaction"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "compaction", "segment_000.md"), "# compact\n");

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory, agentSessionId: sessionId });
    const niubotSessionId = "niubot-session-compact";
    (backend as any).sessions.set(niubotSessionId, session);
    const activity = {
      status: "running" as const,
      startedAt: Date.now(),
      lastActiveAt: 0,
      completionDetected: false,
      compacting: false,
      recentLines: [] as string[],
      notifyCount: 0,
    };

    (backend as any).refreshActivity(niubotSessionId, activity);

    expect(activity.compacting).toBe(false);
    expect(session.compactCount).toBe(1);
  });

  it("refreshActivity keeps existing recentLines when events file is missing", () => {
    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });
    const niubotSessionId = "niubot-session-empty";
    (backend as any).sessions.set(niubotSessionId, session);
    const activity = {
      status: "running" as const,
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      completionDetected: false,
      compacting: false,
      recentLines: ["tool_started: grep"],
      notifyCount: 0,
    };

    (backend as any).refreshActivity(niubotSessionId, activity);

    expect(activity.recentLines).toEqual(["tool_started: grep"]);
  });

  it("refreshActivity replaces stdout text chunks with chat_history messages", () => {
    const sessionId = "019ffb94-3030-72f3-b3eb-42e766619372";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(tempHome, "workspace");
    fs.mkdirSync(workingDirectory, { recursive: true });
    setTestHome(tempHome);

    const sessionDir = path.join(
      tempHome,
      ".grok",
      "sessions",
      encodeGrokSessionDir(workingDirectory),
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "chat_history.jsonl"), [
      JSON.stringify({ type: "user", content: "hi" }),
      JSON.stringify({ type: "assistant", content: "先看 chat_history。", tool_calls: [{ name: "read_file" }] }),
    ].join("\n"));

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory, agentSessionId: sessionId });
    const niubotSessionId = "niubot-session-stdout";
    (backend as any).sessions.set(niubotSessionId, session);
    const activity = {
      status: "running" as const,
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      completionDetected: false,
      compacting: false,
      recentLines: [
        '{"type":"text","data":"读取"}',
        '{"type":"text","data":"逻辑"}',
        '{"type":"text","data":"。"}',
      ],
      notifyCount: 0,
    };

    (backend as any).refreshActivity(niubotSessionId, activity);

    expect(activity.recentLines).toEqual([
      JSON.stringify({ type: "user", content: "hi" }),
      JSON.stringify({ type: "assistant", content: "先看 chat_history。", tool_calls: [{ name: "read_file" }] }),
    ]);
    expect(activity.recentLines.join("\n")).not.toContain('"type":"text"');
  });

  it("treats a missing transcript as session not started", async () => {
    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });
    await expect((backend as any).loadSessionTranscript(session)).rejects.toMatchObject({
      name: "AgentSessionNotStartedError",
    });
  });

  it("does not prefix stable context into the user message", () => {
    const backend = new GrokBackend();
    expect(backend.needsStableUserPrefix()).toBe(false);
  });
});
