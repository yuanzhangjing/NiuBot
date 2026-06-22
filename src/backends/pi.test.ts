import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import PiBackend, { encodePiSessionDir } from "./pi.js";

const originalHome = process.env["HOME"];

describe("PiBackend", () => {
  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
  });

  it("builds json mode args without injecting provider or env", () => {
    const backend = new PiBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp/workspace",
      model: "deepseek-v4-flash",
      importantContext: "You are NiuBot.",
    });

    const input = backend.buildInput(session, "hello");

    expect(input.args).toEqual([
      "--mode", "json",
      "-a",
      "-p",
      "--model", "deepseek-v4-flash",
      "--append-system-prompt", "You are NiuBot.",
      "hello",
    ]);
    expect(input.stdin).toBeUndefined();
  });

  it("omits --model when NiuBot config does not set one", () => {
    const backend = new PiBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });
    const input = backend.buildInput(session, "hello");

    expect(input.args).toEqual(["--mode", "json", "-a", "-p", "hello"]);
  });

  it("resumes with --session when agentSessionId is present", () => {
    const backend = new PiBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp", model: "deepseek-v4-flash" });
    session.agentSessionId = "019eeed6-1e1d-7faf-be82-a1010d86d6d8";

    const input = backend.buildInput(session, "continue");

    expect(input.args).toContain("--session");
    expect(input.args).toContain("019eeed6-1e1d-7faf-be82-a1010d86d6d8");
  });

  it("parses assistant text and session id from json events", () => {
    const backend = new PiBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp", model: "deepseek-v4-flash" });
    const sessionId = "019eeed6-1e1d-7faf-be82-a1010d86d6d8";

    const parsed = backend.parseOutput([
      JSON.stringify({ type: "session", id: sessionId, cwd: "/tmp" }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          model: "deepseek-v4-flash",
          content: [{ type: "text", text: "ok" }],
          usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0 },
        },
      }),
      JSON.stringify({
        type: "agent_end",
        messages: [{
          role: "assistant",
          model: "deepseek-v4-flash",
          content: [{ type: "text", text: "ok" }],
          usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0 },
        }],
      }),
    ].join("\n"), session);

    expect(parsed.text).toBe("ok");
    expect(parsed.agentSessionId).toBe(sessionId);
    expect(parsed.model).toBe("deepseek-v4-flash");
    expect(parsed.contextTokens).toBe(105);
  });

  it("hydrates model and usage from pi session log", () => {
    const sessionId = "019eeed6-1e1d-7faf-be82-a1010d86d6d8";
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-home-"));
    const workingDirectory = path.join(tempHome, "workspace");
    fs.mkdirSync(workingDirectory, { recursive: true });
    process.env["HOME"] = tempHome;

    const sessionsRoot = path.join(
      tempHome,
      ".pi",
      "agent",
      "sessions",
      encodePiSessionDir(workingDirectory),
    );
    fs.mkdirSync(sessionsRoot, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsRoot, `2026-06-22T10-00-00_${sessionId}.jsonl`),
      [
        JSON.stringify({ type: "session", id: sessionId, cwd: workingDirectory }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            model: "deepseek-v4-pro[1m]",
            content: [{ type: "text", text: "done" }],
            usage: { input: 2000, output: 42, cacheRead: 100, cacheWrite: 0 },
          },
        }),
        JSON.stringify({ type: "compaction", summary: "compact", tokensBefore: 3000 }),
      ].join("\n"),
    );

    const backend = new PiBackend();
    const session = backend.buildSession({ workingDirectory, agentSessionId: sessionId });
    const parsed = backend.parseOutput([
      JSON.stringify({ type: "session", id: sessionId }),
      JSON.stringify({
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      }),
    ].join("\n"), session);

    expect(parsed.model).toBe("deepseek-v4-pro[1m]");
    expect(parsed.contextTokens).toBe(2142);
    expect(parsed.compactCount).toBe(1);
  });

  it("surfaces assistant auth errors from pi json events", () => {
    const backend = new PiBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp", model: "deepseek-v4-flash" });

    const parsed = backend.parseOutput(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}}",
      },
    }), session);

    expect(parsed.text).toBe("");
    expect(parsed.error).toBe("invalid x-api-key");
    expect(parsed.failed).toBe(true);
  });

  it("encodes cwd into pi session directory slug", () => {
    expect(encodePiSessionDir("/private/tmp")).toBe("--private-tmp--");
  });
});
