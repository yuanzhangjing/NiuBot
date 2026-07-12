import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import GrokBackend from "./grok.js";

const originalHome = process.env["HOME"];

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = originalHome;
  }
});

function grokSessionDir(home: string, workingDirectory: string, sessionId: string): string {
  return path.join(home, ".grok", "sessions", encodeURIComponent(path.resolve(workingDirectory)), sessionId);
}

describe("GrokBackend", () => {
  it("creates a named headless session with stable context on the first turn", () => {
    const backend = new GrokBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp/project",
      model: "grok-4.5",
      importantContext: "You are NiuBot.",
    });
    session.agentSessionId = "11111111-1111-4111-8111-111111111111";

    expect(backend.buildInput(session, "hello")).toEqual({
      args: [
        "--no-auto-update",
        "--always-approve",
        "--output-format", "streaming-json",
        "--session-id", "11111111-1111-4111-8111-111111111111",
        "--cwd", "/tmp/project",
        "--append-system-prompt", "You are NiuBot.",
        "-m", "grok-4.5",
        "-p", "hello",
      ],
    });
  });

  it("redacts user messages and stable context from diagnostic command args", () => {
    const backend = new GrokBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp/project",
      importantContext: "private stable context",
    });
    session.agentSessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    const args = backend.buildInput(session, "private user message").args;
    const loggedArgs = (backend as any).argsForLog(args) as string[];

    expect(args).toContain("private stable context");
    expect(args).toContain("private user message");
    expect(loggedArgs).not.toContain("private stable context");
    expect(loggedArgs).not.toContain("private user message");
    expect(loggedArgs.filter((arg) => arg === "[REDACTED]")).toHaveLength(2);
  });

  it("resumes a Grok session without duplicating stable context", () => {
    const backend = new GrokBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp/project",
      model: "grok-4.5",
      importantContext: "You are NiuBot.",
      agentSessionId: "22222222-2222-4222-8222-222222222222",
    });

    expect(backend.buildInput(session, "second turn")).toEqual({
      args: [
        "--no-auto-update",
        "--always-approve",
        "--output-format", "streaming-json",
        "--resume", "22222222-2222-4222-8222-222222222222",
        "--cwd", "/tmp/project",
        "-m", "grok-4.5",
        "-p", "second turn",
      ],
    });
  });

  it("resumes after the first turn created a session directory but did not emit end", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(home, "workspace");
    const sessionId = "88888888-8888-4888-8888-888888888888";
    process.env["HOME"] = home;

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory });
    session.agentSessionId = sessionId;

    expect(backend.buildInput(session, "first").args).toContain("--session-id");
    fs.mkdirSync(grokSessionDir(home, workingDirectory, sessionId), { recursive: true });

    const retryArgs = backend.buildInput(session, "retry").args;
    expect(retryArgs).toContain("--resume");
    expect(retryArgs).not.toContain("--session-id");
    expect(retryArgs).not.toContain("--append-system-prompt");
  });

  it("uses the final assistant history entry and hydrates session statistics", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(home, "workspace");
    const sessionId = "33333333-3333-4333-8333-333333333333";
    process.env["HOME"] = home;

    const dir = grokSessionDir(home, workingDirectory, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "chat_history.jsonl"), [
      JSON.stringify({ type: "assistant", content: "正在执行命令" }),
      JSON.stringify({ type: "assistant", content: "" }),
      JSON.stringify({ type: "assistant", content: "最终回复" }),
    ].join("\n"));
    fs.writeFileSync(path.join(dir, "signals.json"), JSON.stringify({
      primaryModelId: "grok-4.5",
      contextTokensUsed: 15977,
      contextWindowTokens: 500000,
      compactionCount: 2,
    }));

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory, agentSessionId: sessionId });
    const parsed = backend.parseOutput(JSON.stringify({
      type: "end",
      stopReason: "EndTurn",
      sessionId,
    }), session);

    expect(parsed).toMatchObject({
      text: "最终回复",
      agentSessionId: sessionId,
      model: "grok-4.5",
      contextTokens: 15977,
      contextWindow: 500000,
      compactCount: 2,
    });
  });

  it("does not reuse a previous assistant reply when the current turn fails", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(home, "workspace");
    const sessionId = "66666666-6666-4666-8666-666666666666";
    process.env["HOME"] = home;

    const dir = grokSessionDir(home, workingDirectory, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "chat_history.jsonl"), JSON.stringify({
      type: "assistant",
      content: "上一轮回复",
    }) + "\n");

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory, agentSessionId: sessionId });
    backend.buildInput(session, "会失败的本轮消息");
    const parsed = backend.parseOutput(JSON.stringify({
      type: "error",
      message: "model unavailable",
    }), session);

    expect(parsed.text).toBe("");
    expect(parsed.error).toBe("model unavailable");
    expect(parsed.failed).toBe(true);
  });

  it("does not treat an intermediate assistant entry as success after an error", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(home, "workspace");
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    process.env["HOME"] = home;

    const dir = grokSessionDir(home, workingDirectory, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const historyPath = path.join(dir, "chat_history.jsonl");
    fs.writeFileSync(historyPath, "");

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory, agentSessionId: sessionId });
    backend.buildInput(session, "run a tool");
    fs.appendFileSync(historyPath, JSON.stringify({
      type: "assistant",
      content: "正在执行命令",
    }) + "\n");

    const parsed = backend.parseOutput([
      JSON.stringify({ type: "error", message: "tool failed" }),
      JSON.stringify({ type: "end", sessionId }),
    ].join("\n"), session);

    expect(parsed.text).toBe("");
    expect(parsed.error).toBe("tool failed");
    expect(parsed.failed).toBe(true);
  });

  it("reads a new assistant reply after a UTF-8 history offset", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(home, "workspace");
    const sessionId = "77777777-7777-4777-8777-777777777777";
    process.env["HOME"] = home;

    const dir = grokSessionDir(home, workingDirectory, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const historyPath = path.join(dir, "chat_history.jsonl");
    fs.writeFileSync(historyPath, JSON.stringify({ type: "assistant", content: "上一轮中文回复" }) + "\n");

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory, agentSessionId: sessionId });
    backend.buildInput(session, "本轮消息");
    fs.appendFileSync(historyPath, JSON.stringify({ type: "assistant", content: "本轮最终回复" }) + "\n");

    const parsed = backend.parseOutput(JSON.stringify({ type: "end", sessionId }), session);

    expect(parsed.text).toBe("本轮最终回复");
  });

  it("uses the end event as completion signal and captures its session id", () => {
    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/project" });
    const hooks = (backend as any).getExecHooks(session) as {
      onLine?: (line: string) => void;
      isComplete?: (line: string) => boolean;
    };
    const line = JSON.stringify({
      type: "end",
      stopReason: "EndTurn",
      sessionId: "44444444-4444-4444-8444-444444444444",
    });

    hooks.onLine?.(line);

    expect(session.agentSessionId).toBe("44444444-4444-4444-8444-444444444444");
    expect(hooks.isComplete?.(line)).toBe(true);
  });

  it("tracks an active Grok tool invocation from incremental event logs", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(home, "workspace");
    const sessionId = "55555555-5555-4555-8555-555555555555";
    process.env["HOME"] = home;

    const dir = grokSessionDir(home, workingDirectory, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const eventsPath = path.join(dir, "events.jsonl");
    fs.writeFileSync(eventsPath, JSON.stringify({
      type: "tool_started",
      ts: "2026-07-11T12:53:09.514Z",
      tool_name: "运行命令",
    }) + "\n");

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory, agentSessionId: sessionId });
    (backend as any).sessions.set("local-session", session);
    const activity: any = {
      status: "running",
      startedAt: Date.now(),
      lastActiveAt: 0,
      compacting: false,
      recentLines: [],
      notifyCount: 0,
    };

    (backend as any).refreshActivity("local-session", activity);

    expect(activity.executingTool).toBe(true);
    expect(activity.recentLines).toContain("tool_started: 运行命令");

    fs.appendFileSync(eventsPath, JSON.stringify({
      type: "tool_completed",
      ts: "2026-07-11T12:53:21.872Z",
      tool_name: "运行命令",
    }) + "\n");
    (backend as any).refreshActivity("local-session", activity);

    expect(activity.executingTool).toBe(false);
  });

  it("ignores stale tool state and clears the current tool when the turn ends", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    const workingDirectory = path.join(home, "workspace");
    const sessionId = "99999999-9999-4999-8999-999999999999";
    process.env["HOME"] = home;

    const dir = grokSessionDir(home, workingDirectory, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const eventsPath = path.join(dir, "events.jsonl");
    fs.writeFileSync(eventsPath, [
      JSON.stringify({ type: "turn_started" }),
      JSON.stringify({ type: "tool_started", tool_name: "stale_tool" }),
    ].join("\n") + "\n");

    const backend = new GrokBackend();
    const session = backend.buildSession({ workingDirectory, agentSessionId: sessionId });
    backend.buildInput(session, "new turn");
    (backend as any).sessions.set("local-session", session);
    const activity: any = {
      status: "running",
      startedAt: Date.now(),
      lastActiveAt: 0,
      compacting: false,
      recentLines: [],
      notifyCount: 0,
    };

    fs.appendFileSync(eventsPath, [
      JSON.stringify({ type: "turn_started" }),
      JSON.stringify({ type: "tool_started", tool_name: "current_tool" }),
    ].join("\n") + "\n");
    (backend as any).refreshActivity("local-session", activity);
    expect(activity.executingTool).toBe(true);

    fs.appendFileSync(eventsPath, JSON.stringify({ type: "turn_ended" }) + "\n");
    (backend as any).refreshActivity("local-session", activity);
    expect(activity.executingTool).toBe(false);
  });
});
