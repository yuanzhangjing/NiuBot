import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import CodexBackend from "./codex.js";

const originalHome = process.env["HOME"];

describe("CodexBackend session metadata", () => {
  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
  });

  it("hydrates model and current context usage from the Codex session log", () => {
    const threadId = "019d688f-4db1-7871-981e-09b47ad4f84b";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    process.env["HOME"] = tempHome;

    const logDir = path.join(tempHome, ".codex", "sessions", "2026", "04", "07");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, `rollout-2026-04-07T23-28-35-${threadId}.jsonl`),
      [
        JSON.stringify({
          type: "turn_context",
          payload: {
            model: "gpt-5.4",
            collaboration_mode: {
              settings: { reasoning_effort: null },
            },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              model_context_window: 258400,
              total_token_usage: {
                input_tokens: 2050400,
                cached_input_tokens: 2048000,
                output_tokens: 1900,
                total_tokens: 2052300,
              },
              last_token_usage: {
                input_tokens: 20504,
                cached_input_tokens: 10624,
                output_tokens: 19,
                total_tokens: 20666,
              },
            },
          },
        }),
      ].join("\n"),
    );

    const backend = new CodexBackend();
    const session = backend.buildSession({ workingDirectory: tempHome });
    // parseOutput now takes session and handles JSONL scan + agentSessionId internally
    const parsed = backend.parseOutput([
      JSON.stringify({ type: "thread.started", thread_id: threadId }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "ok" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 20504, cached_input_tokens: 10624, output_tokens: 19 },
      }),
    ].join("\n"), session);

    expect(parsed.model).toBe("gpt-5.4");
    expect(parsed.contextWindow).toBe(258400);
    expect(parsed.contextTokens).toBe(20666);
  });

  it("counts context_compacted events from the Codex session log", () => {
    const threadId = "019d6c46-7d53-7e22-9767-0e837ba20ebf";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    process.env["HOME"] = tempHome;

    const logDir = path.join(tempHome, ".codex", "sessions", "2026", "04", "08");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, `rollout-2026-04-08T16-47-32-${threadId}.jsonl`),
      [
        JSON.stringify({ type: "compacted", payload: { message: "" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "context_compacted" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "context_compacted" } }),
      ].join("\n"),
    );

    const backend = new CodexBackend();
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

  it("keeps the latest token usage even if a compacted marker appears", () => {
    const threadId = "019d6d6a-ef5b-75fe-a214-1d4d1b7f09b3";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    process.env["HOME"] = tempHome;

    const logDir = path.join(tempHome, ".codex", "sessions", "2026", "04", "16");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `rollout-2026-04-16T07-01-44-${threadId}.jsonl`);
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              model_context_window: 258400,
              last_token_usage: {
                input_tokens: 241890,
                output_tokens: 409,
                total_tokens: 242299,
              },
            },
          },
        }),
        JSON.stringify({ type: "compacted", payload: { message: "" } }),
      ].join("\n"),
    );

    const backend = new CodexBackend();
    const session = backend.buildSession({ workingDirectory: tempHome });
    const parsed = backend.parseOutput([
      JSON.stringify({ type: "thread.started", thread_id: threadId }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "ok" },
      }),
    ].join("\n"), session);

    expect(parsed.contextTokens).toBe(242299);
    expect(parsed.compactCount).toBeUndefined();
  });

  it("resumes scanning with the existing thread id and counts context_compacted markers", () => {
    const threadId = "019d6da5-3a23-7024-b99d-47c39056c0d2";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    process.env["HOME"] = tempHome;

    const logDir = path.join(tempHome, ".codex", "sessions", "2026", "04", "16");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `rollout-2026-04-16T07-01-44-${threadId}.jsonl`);
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              model_context_window: 258400,
              last_token_usage: {
                input_tokens: 241890,
                output_tokens: 409,
                total_tokens: 242299,
              },
            },
          },
        }),
        JSON.stringify({ type: "compacted", payload: { message: "" } }),
      ].join("\n"),
    );

    const backend = new CodexBackend();
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
              model_context_window: 258400,
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

  it("does not fall back to cumulative turn usage when session log metadata is unavailable", () => {
    const backend = new CodexBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const parsed = backend.parseOutput([
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "ok" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 2050400, cached_input_tokens: 2048000, output_tokens: 1900 },
      }),
    ].join("\n"), session);

    expect(parsed.contextTokens).toBeUndefined();
  });

  it("lite tier with no liteModel uses backend default lite model", () => {
    const backend = new CodexBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp",
      modelTier: "lite",
      model: "gpt-5.4",
    });

    expect(session.model).toBe("gpt-5.4-mini");
  });

  it("lite tier with no liteModel and no model uses backend default lite model", () => {
    const backend = new CodexBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp",
      modelTier: "lite",
    });

    expect(session.model).toBe("gpt-5.4-mini");
  });

  it("passes liteModel via SessionConfig for lite tier sessions", () => {
    const backend = new CodexBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp/project",
      modelTier: "lite",
      liteModel: "gpt-5.4-mini",
    });

    expect(backend.buildInput(session, "ping")).toEqual({
      args: [
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "-C",
        "/tmp/project",
        "-m",
        "gpt-5.4-mini",
      ],
      stdin: "ping",
    });
  });

  it("passes the new user message when resuming an existing codex thread", () => {
    const backend = new CodexBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp/project",
      model: "gpt-5.4",
    });
    session.agentSessionId = "thread_123";

    expect(backend.buildInput(session, "second turn")).toEqual({
      args: [
        "exec",
        "resume",
        "thread_123",
        "-",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "-m",
        "gpt-5.4",
      ],
      stdin: "second turn",
    });
  });
});
