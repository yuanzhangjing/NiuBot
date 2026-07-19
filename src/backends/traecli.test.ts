import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import TraeCliBackend from "./traecli.js";

const originalHome = process.env["HOME"];

function setTestHome(home: string): void {
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
}

describe("TraeCliBackend", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
  });

  it("hydrates model and current context usage from the session log", () => {
    const threadId = "019f02c8-43c8-7da1-b78c-d7c2c81e544b";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "trae-home-"));
    setTestHome(tempHome);

    const logDir = path.join(tempHome, ".trae", "cli", "sessions", "2026", "06", "26");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, `rollout-2026-06-26T15-15-06-${threadId}.jsonl`),
      [
        JSON.stringify({
          type: "turn_context",
          payload: {
            model: "Test-O-New-Thinking",
            collaboration_mode: {
              settings: { reasoning_effort: "max" },
            },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              model_context_window: 950000,
              last_token_usage: {
                input_tokens: 24624,
                cached_input_tokens: 0,
                output_tokens: 36,
                total_tokens: 24660,
              },
            },
          },
        }),
      ].join("\n"),
    );

    const backend = new TraeCliBackend();
    const session = backend.buildSession({ workingDirectory: tempHome });
    const parsed = backend.parseOutput([
      JSON.stringify({ type: "thread.started", thread_id: threadId }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "pong" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 24624, output_tokens: 36 },
      }),
    ].join("\n"), session);

    expect(parsed.text).toBe("pong");
    expect(parsed.model).toBe("Test-O-New-Thinking");
    expect(parsed.contextWindow).toBe(950000);
    expect(parsed.contextTokens).toBe(24660);
  });

  it("counts context_compacted events from the session log", () => {
    const threadId = "019f02c8-1111-7da1-b78c-d7c2c81e544b";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "trae-home-"));
    setTestHome(tempHome);

    const logDir = path.join(tempHome, ".trae", "cli", "sessions", "2026", "06", "26");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, `rollout-2026-06-26T10-00-00-${threadId}.jsonl`),
      [
        JSON.stringify({ type: "event_msg", payload: { type: "context_compacted" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "context_compacted" } }),
      ].join("\n"),
    );

    const backend = new TraeCliBackend();
    const session = backend.buildSession({ workingDirectory: tempHome });
    const parsed = backend.parseOutput([
      JSON.stringify({ type: "thread.started", thread_id: threadId }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "ok" },
      }),
    ].join("\n"), session);

    expect(parsed.compactCount).toBe(2);
  });

  it("resumes scanning incrementally across turns", () => {
    const threadId = "019f02c8-2222-7da1-b78c-d7c2c81e544b";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "trae-home-"));
    setTestHome(tempHome);

    const logDir = path.join(tempHome, ".trae", "cli", "sessions", "2026", "06", "26");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `rollout-2026-06-26T10-00-00-${threadId}.jsonl`);
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              model_context_window: 950000,
              last_token_usage: {
                input_tokens: 241890,
                output_tokens: 409,
                total_tokens: 242299,
              },
            },
          },
        }),
      ].join("\n"),
    );

    const backend = new TraeCliBackend();
    const session = backend.buildSession({ workingDirectory: tempHome });
    const first = backend.parseOutput([
      JSON.stringify({ type: "thread.started", thread_id: threadId }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "first" },
      }),
    ].join("\n"), session);

    expect(first.contextTokens).toBe(242299);
    expect(first.compactCount).toBeUndefined();

    fs.appendFileSync(
      logPath,
      "\n" + [
        JSON.stringify({ type: "event_msg", payload: { type: "context_compacted" } }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              model_context_window: 950000,
              last_token_usage: {
                input_tokens: 27056,
                output_tokens: 443,
                total_tokens: 27499,
              },
            },
          },
        }),
      ].join("\n"),
    );

    const second = backend.parseOutput([
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "second" },
      }),
    ].join("\n"), session);

    expect(second.contextTokens).toBe(27499);
    expect(second.compactCount).toBe(1);
  });

  it("builds correct args for a new session", () => {
    const backend = new TraeCliBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp/project",
      model: "Test-O-New-Thinking",
    });

    expect(backend.buildInput(session, "hello")).toEqual({
      args: [
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "-C",
        "/tmp/project",
        "-m",
        "Test-O-New-Thinking",
      ],
      stdin: "hello",
    });
  });

  it("builds correct args when resuming an existing session", () => {
    const backend = new TraeCliBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp/project",
      model: "Test-O-New-Thinking",
    });
    session.agentSessionId = "019f02c8-43c8-7da1-b78c-d7c2c81e544b";

    expect(backend.buildInput(session, "second turn")).toEqual({
      args: [
        "exec", "resume",
        "019f02c8-43c8-7da1-b78c-d7c2c81e544b",
        "-",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "-m",
        "Test-O-New-Thinking",
      ],
      stdin: "second turn",
    });
  });

  it("returns the last agent message when multiple appear in one turn", () => {
    const backend = new TraeCliBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const parsed = backend.parseOutput([
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "commentary" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "final answer" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
    ].join("\n"), session);

    expect(parsed.text).toBe("final answer");
  });

  it("returns the original error message when no agent message is available", () => {
    const backend = new TraeCliBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const parsed = backend.parseOutput(JSON.stringify({
      type: "error",
      message: "model not available",
    }), session);

    expect(parsed.text).toBe("");
    expect(parsed.error).toBe("model not available");
    expect(parsed.failed).toBe(true);
  });

  it("keeps a completed agent message when an error event also appears", () => {
    const backend = new TraeCliBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const parsed = backend.parseOutput([
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "already generated reply" },
      }),
      JSON.stringify({
        type: "error",
        message: "stream disconnected",
      }),
    ].join("\n"), session);

    expect(parsed.text).toBe("already generated reply");
    expect(parsed.error).toBeUndefined();
  });

  it("waits for turn.completed instead of finishing on the first agent message", () => {
    const backend = new TraeCliBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });
    const hooks = (backend as any).getExecHooks(session) as { isComplete?: (line: string) => boolean };

    expect(hooks.isComplete?.(JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "commentary" },
    }))).toBe(false);

    expect(hooks.isComplete?.(JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 12, output_tokens: 3 },
    }))).toBe(true);
  });

  it("captures thread_id from onLine hook", () => {
    const backend = new TraeCliBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });
    const hooks = (backend as any).getExecHooks(session) as { onLine?: (line: string) => void };

    hooks.onLine?.(JSON.stringify({
      type: "thread.started",
      thread_id: "019f02c8-43c8-7da1-b78c-d7c2c81e544b",
    }));

    expect(session.agentSessionId).toBe("019f02c8-43c8-7da1-b78c-d7c2c81e544b");
  });

  it("skips non-directory entries while locating session logs", () => {
    const threadId = "019f02c8-3333-7da1-b78c-d7c2c81e544b";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "trae-home-"));
    setTestHome(tempHome);

    const sessionsRoot = path.join(tempHome, ".trae", "cli", "sessions");
    const logDir = path.join(sessionsRoot, "2026", "06", "26");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsRoot, "rollout-legacy.json"), "{}");
    fs.writeFileSync(path.join(sessionsRoot, "2026", "legacy-file.json"), "{}");
    fs.writeFileSync(path.join(sessionsRoot, "2026", "06", "legacy-file.json"), "{}");
    fs.writeFileSync(
      path.join(logDir, `rollout-2026-06-26T10-00-00-${threadId}.jsonl`),
      JSON.stringify({
        type: "turn_context",
        payload: { model: "Test-O-New-Thinking" },
      }),
    );

    const backend = new TraeCliBackend();
    const session = backend.buildSession({ workingDirectory: tempHome });
    const parsed = backend.parseOutput([
      JSON.stringify({ type: "thread.started", thread_id: threadId }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "ok" },
      }),
    ].join("\n"), session);

    expect(parsed.model).toBe("Test-O-New-Thinking");
  });

  it("returns null from mtime probe when sessions root contains only files", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "trae-home-"));
    setTestHome(tempHome);

    const sessionsRoot = path.join(tempHome, ".trae", "cli", "sessions");
    fs.mkdirSync(sessionsRoot, { recursive: true });
    fs.writeFileSync(path.join(sessionsRoot, "rollout-legacy.json"), "{}");

    const backend = new TraeCliBackend();
    const session = backend.buildSession({ workingDirectory: tempHome });
    session.agentSessionId = "missing-thread";

    expect((backend as any).probeSessionFileMtime(session)).toBeNull();
  });
});
