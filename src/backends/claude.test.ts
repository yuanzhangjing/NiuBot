import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import ClaudeBackend from "./claude.js";
import { claudeProjectKey } from "../platform/workspace-path.js";

const originalHome = process.env["HOME"];

describe("ClaudeBackend session metadata", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
  });

  it("includes all token types when estimating context size", () => {
    const sessionId = "019d6888-07e1-7c91-8439-ef53ce51f973";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-"));
    const workingDirectory = path.join(tempHome, "workspace");
    fs.mkdirSync(workingDirectory, { recursive: true });
    process.env["HOME"] = tempHome;
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(tempHome, ".claude"));

    // Match getJsonlPath: realpathSync + replace /\_ with -
    const projectKey = claudeProjectKey(workingDirectory);
    const logDir = path.join(tempHome, ".claude", "projects", projectKey);
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-sonnet-4-5-20250929",
            usage: {
              input_tokens: 20504,
              cache_creation_input_tokens: 512,
              cache_read_input_tokens: 5641152,
              output_tokens: 19,
            },
          },
        }),
      ].join("\n"),
    );

    const backend = new ClaudeBackend();
    const session = backend.buildSession({
      workingDirectory,
      agentSessionId: sessionId,
    });
    const parsed = backend.parseOutput([
      JSON.stringify({
        type: "result",
        result: "ok",
        session_id: sessionId,
      }),
    ].join("\n"), session);

    expect(parsed.model).toBe("claude-sonnet-4-5-20250929");
    expect(parsed.contextTokens).toBe(5662187);
  });

  it("passes reasoning effort as --effort flag", () => {
    const backend = new ClaudeBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp/workspace",
      reasoningEffort: "high",
    });

    const { args } = backend.buildInput(session, "hello");
    expect(args).toContain("--effort");
    expect(args).toContain("high");
  });

  it("omits --effort when effort is not configured", () => {
    const backend = new ClaudeBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });

    const { args } = backend.buildInput(session, "hello");
    expect(args).not.toContain("--effort");
  });

  it("applies effort updates to an existing session via updateSessionModels", async () => {
    const backend = new ClaudeBackend();
    const agentSession = await backend.createSession({ workingDirectory: "/tmp/workspace" });

    // 模拟 /effort high 的运行时切换：更新内部 session 对象
    backend.updateSessionModels(agentSession.id, { effort: "high" });

    const internal = (backend as any).sessions.get(agentSession.id);
    expect(internal.reasoningEffort).toBe("high");
    const { args } = backend.buildInput(internal, "hello");
    expect(args).toContain("--effort");
    expect(args).toContain("high");
  });

  it("keeps the original Claude result text as the error message", () => {
    const backend = new ClaudeBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const parsed = backend.parseOutput(JSON.stringify({
      type: "result",
      result: "API quota exceeded",
      is_error: true,
    }), session);

    expect(parsed.text).toBe("");
    expect(parsed.error).toBe("API quota exceeded");
    expect(parsed.failed).toBe(true);
  });
});
