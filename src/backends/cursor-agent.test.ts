import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { CURSOR_ENGINE_RULE_BASENAME, CURSOR_RULES_DIR } from "./cursor-workspace-rules.js";
import CursorAgentBackend from "./cursor-agent.js";

describe("CursorAgentBackend", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tmpRoots.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not prefix stable into user messages", () => {
    const backend = new CursorAgentBackend();
    expect(backend.needsStableUserPrefix()).toBe(false);
    expect(backend.needsCompactRecoveryReminder()).toBe(false);
  });

  it("syncs stable context to .cursor/rules on createSession", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "niubot-cursor-session-"));
    tmpRoots.push(workDir);
    const backend = new CursorAgentBackend();
    const stable = "<niubot-system-rules>\ncursor stable\n</niubot-system-rules>";

    await backend.createSession({
      workingDirectory: workDir,
      importantContext: stable,
    });

    const enginePath = join(workDir, CURSOR_RULES_DIR, CURSOR_ENGINE_RULE_BASENAME);
    expect(existsSync(enginePath)).toBe(true);
    expect(readFileSync(enginePath, "utf8")).toContain("cursor stable");
  });

  it("builds a headless trusted stream-json request and reads prompt from stdin", () => {
    const backend = new CursorAgentBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });

    expect(backend.buildInput(session, "hello")).toEqual({
      args: [
        "--yolo",
        "--trust",
        "-p",
        "--output-format",
        "stream-json",
        "--workspace",
        "/tmp/workspace",
      ],
      stdin: "hello",
    });
  });

  it("resumes an existing Cursor Agent session", () => {
    const backend = new CursorAgentBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });
    session.agentSessionId = "chat-123";

    expect(backend.buildInput(session, "next")).toEqual({
      args: [
        "--yolo",
        "--trust",
        "-p",
        "--output-format",
        "stream-json",
        "--workspace",
        "/tmp/workspace",
        "--resume",
        "chat-123",
      ],
      stdin: "next",
    });
  });

  it("parses stream-json result, session id, configured model, and token usage", () => {
    const backend = new CursorAgentBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp/workspace",
      model: "composer-2.5",
    });

    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "session-1",
        model: "Composer 2.5",
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "hello from cursor",
        session_id: "session-1",
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
        },
      }),
    ].join("\n");

    const parsed = backend.parseOutput(stdout, session);

    expect(parsed).toEqual({
      text: "hello from cursor",
      agentSessionId: "session-1",
      model: "composer-2.5",
      contextTokens: 19,
    });
  });

  it("uses last pre-result stream usage for context window, not cumulative result.usage", () => {
    const backend = new CursorAgentBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });

    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "session-1",
        model: "Composer 2.5",
      }),
      JSON.stringify({
        type: "assistant",
        usage: {
          inputTokens: 500,
          cacheReadTokens: 78_000,
          outputTokens: 1_200,
          cacheWriteTokens: 0,
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "session-1",
        usage: {
          inputTokens: 200_000,
          cacheReadTokens: 150_000,
          outputTokens: 50_000,
          cacheWriteTokens: 0,
        },
      }),
    ].join("\n");

    const parsed = backend.parseOutput(stdout, session);

    expect(parsed.contextTokens).toBe(79_700);
  });

  it("sums result.usage as-is when cacheRead is large", () => {
    const backend = new CursorAgentBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });

    const stdout = [
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "ok",
        session_id: "session-1",
        usage: {
          inputTokens: 612,
          cacheReadTokens: 303_409,
          outputTokens: 2_488,
          cacheWriteTokens: 0,
        },
      }),
    ].join("\n");

    const parsed = backend.parseOutput(stdout, session);

    expect(parsed.contextTokens).toBe(306_509);
  });

  it("uses init model from stream when session model is not configured", () => {
    const backend = new CursorAgentBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });

    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "session-1",
        model: "Composer 2.5",
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "ok",
        session_id: "session-1",
      }),
    ].join("\n");

    const parsed = backend.parseOutput(stdout, session);

    expect(parsed.model).toBe("Composer 2.5");
    expect(parsed.agentSessionId).toBe("session-1");
  });

  it("captures session id early from stream hooks", () => {
    const backend = new CursorAgentBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });
    const hooks = (backend as any).getExecHooks(session) as {
      onLine?: (line: string) => void;
      isComplete?: (line: string) => boolean;
    };

    hooks.onLine?.(JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "session-early",
      model: "Composer 2.5",
    }));

    expect(session.agentSessionId).toBe("session-early");
    expect(session.resolvedModel).toBe("Composer 2.5");
    expect(hooks.isComplete?.(JSON.stringify({ type: "result", subtype: "success" }))).toBe(true);
    expect(hooks.isComplete?.(JSON.stringify({ type: "assistant" }))).toBe(false);
  });

  it("prefers last assistant text over concatenated result.result after tool calls", () => {
    const backend = new CursorAgentBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });

    const preamble = "我去 stdout log 里抓几轮真实的 usage 分项。\n";
    const finalAnswer = "从你刚发的 log 里，两轮真实 result.usage 是这样的：\n\n结论：cacheRead 是累计值。";

    const stdout = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: preamble }],
        },
      }),
      JSON.stringify({ type: "tool_call", subtype: "started" }),
      JSON.stringify({ type: "tool_call", subtype: "completed" }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: finalAnswer }],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: `${preamble}${finalAnswer}`,
        session_id: "session-1",
      }),
    ].join("\n");

    const parsed = backend.parseOutput(stdout, session);

    expect(parsed.text).toBe(finalAnswer);
    expect(parsed.text).not.toContain("我去 stdout log");
  });

  it("falls back to result.result when stream has no assistant events", () => {
    const backend = new CursorAgentBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });

    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "only result field",
      session_id: "session-1",
    });

    expect(backend.parseOutput(stdout, session).text).toBe("only result field");
  });

  it("surfaces Cursor Agent errors from JSON output", () => {
    const backend = new CursorAgentBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });

    const parsed = backend.parseOutput(JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "model unavailable",
      session_id: "session-1",
    }), session);

    expect(parsed.text).toBe("");
    expect(parsed.error).toBe("model unavailable");
    expect(parsed.failed).toBe(true);
  });

  it("finds Cursor Agent transcript JSONL from workspace and session id", () => {
    const backend = new CursorAgentBackend();
    const homeDir = join(tmpdir(), `cursor-home-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const workDir = join(tmpdir(), `cursor-work-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tmpRoots.push(homeDir, workDir);
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    vi.stubEnv("HOME", homeDir);

    const session = backend.buildSession({ workingDirectory: workDir });
    session.agentSessionId = "session-123";

    const projectKey = resolve(workDir).replace(/^[/\\]+/, "").replace(/[/\\]+/g, "-");
    const transcriptPath = join(
      homeDir,
      ".cursor",
      "projects",
      projectKey,
      "agent-transcripts",
      "session-123",
      "session-123.jsonl",
    );
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "hello" }] } }),
        JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "world" }] } }),
        "",
      ].join("\n"),
    );

    expect((backend as any).probeSessionFileMtime(session)).toBeGreaterThan(0);
    expect((backend as any).probeSessionLastLine(session)).toContain('"assistant"');
  });

  it("finds flat Cursor Agent transcript JSONL layout", () => {
    const backend = new CursorAgentBackend();
    const homeDir = join(tmpdir(), `cursor-home-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const workDir = join(tmpdir(), `cursor-work-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tmpRoots.push(homeDir, workDir);
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    vi.stubEnv("HOME", homeDir);

    const session = backend.buildSession({ workingDirectory: workDir });
    session.agentSessionId = "session-flat";

    const projectKey = resolve(workDir).replace(/^[/\\]+/, "").replace(/[/\\]+/g, "-");
    const transcriptPath = join(
      homeDir,
      ".cursor",
      "projects",
      projectKey,
      "agent-transcripts",
      "session-flat.jsonl",
    );
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(transcriptPath, `${JSON.stringify({ role: "assistant" })}\n`);

    expect((backend as any).probeSessionLastLine(session)).toContain('"assistant"');
  });

  it("scans other project slugs when workspace key does not match", () => {
    const backend = new CursorAgentBackend();
    const homeDir = join(tmpdir(), `cursor-home-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const workDir = join(tmpdir(), `cursor-work-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tmpRoots.push(homeDir, workDir);
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    vi.stubEnv("HOME", homeDir);

    const session = backend.buildSession({ workingDirectory: workDir });
    session.agentSessionId = "session-scan";

    const transcriptPath = join(
      homeDir,
      ".cursor",
      "projects",
      "legacy-project-slug",
      "agent-transcripts",
      "session-scan",
      "session-scan.jsonl",
    );
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(transcriptPath, `${JSON.stringify({ role: "assistant", text: "found" })}\n`);

    expect((backend as any).probeSessionLastLine(session)).toContain('"found"');
  });

  it("refreshActivity keeps stdout recentLines when jsonl is still empty", () => {
    const backend = new CursorAgentBackend();
    const homeDir = join(tmpdir(), `cursor-home-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const workDir = join(tmpdir(), `cursor-work-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tmpRoots.push(homeDir, workDir);
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    vi.stubEnv("HOME", homeDir);

    const session = backend.buildSession({ workingDirectory: workDir });
    session.agentSessionId = "session-empty-jsonl";
    const sessionId = "niubot-session-1";
    (backend as any).sessions.set(sessionId, session);

    const projectKey = resolve(workDir).replace(/^[/\\]+/, "").replace(/[/\\]+/g, "-");
    const transcriptPath = join(
      homeDir,
      ".cursor",
      "projects",
      projectKey,
      "agent-transcripts",
      "session-empty-jsonl",
      "session-empty-jsonl.jsonl",
    );
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(transcriptPath, "");

    const activity = {
      status: "running" as const,
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      completionDetected: false,
      compacting: false,
      recentLines: ['{"type":"assistant","message":"from stdout"}'],
      notifyCount: 0,
    };
    (backend as any).activityMap.set(sessionId, activity);

    (backend as any).refreshActivity(sessionId, activity);

    expect(activity.recentLines).toEqual(['{"type":"assistant","message":"from stdout"}']);
  });
});
