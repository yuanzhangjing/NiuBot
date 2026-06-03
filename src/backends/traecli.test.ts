import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import TraeCliBackend from "./traecli.js";

const originalHome = process.env["HOME"];
const originalXdgCacheHome = process.env["XDG_CACHE_HOME"];

function getTraeLogDir(tempHome: string, sessionId: string): string {
  if (process.platform === "darwin") {
    return path.join(tempHome, "Library", "Caches", "coco", "sessions", sessionId);
  }
  return path.join(process.env["XDG_CACHE_HOME"] || path.join(tempHome, ".cache"), "coco", "sessions", sessionId);
}

describe("TraeCliBackend", () => {
  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }

    if (originalXdgCacheHome === undefined) {
      delete process.env["XDG_CACHE_HOME"];
    } else {
      process.env["XDG_CACHE_HOME"] = originalXdgCacheHome;
    }
  });

  it("passes the new user message as an argument when resuming an existing session", () => {
    const backend = new TraeCliBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp/workspace",
    });
    session.agentSessionId = "session-123";

    expect(backend.buildInput(session, "second turn")).toEqual({
      args: ["-p", "--json", "--yolo", "--resume=session-123", "--", "second turn"],
    });
  });

  it("preassigns a plain UUID session id for the first turn", () => {
    const backend = new TraeCliBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp/workspace",
    });

    expect(session.preassignedSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(session.preassignedSessionId?.startsWith("niubot-")).toBe(false);
    expect(backend.buildInput(session, "first turn")).toEqual({
      args: ["-p", "--json", "--yolo", `--session-id=${session.preassignedSessionId}`, "--", "first turn"],
    });
  });

  it("uses backend default lite model when liteModel is not configured", () => {
    const backend = new TraeCliBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp/workspace",
      modelTier: "lite",
      model: "trae-main-model",
    });

    expect(session.model).toBe("Gemini-3-Flash-Preview");
  });

  it("parses stdout fields from the traecli json response", () => {
    const backend = new TraeCliBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });
    const sessionId = session.preassignedSessionId!;

    const parsed = backend.parseOutput(JSON.stringify({
      message: {
        content: "hello from trae",
        response_meta: {
          usage: {
            total_tokens: 321,
          },
        },
        extra: {
          _source_model: "trae-main",
        },
      },
      session_id: sessionId,
    }), session);

    expect(parsed).toMatchObject({
      text: "hello from trae",
      agentSessionId: sessionId,
      contextTokens: 321,
      model: "trae-main",
    });
  });

  it("hydrates model, current context tokens, and compact count from the session log", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "trae-home-"));
    process.env["HOME"] = tempHome;
    process.env["XDG_CACHE_HOME"] = path.join(tempHome, ".cache");

    const sessionId = "session-log-1";
    const logDir = getTraeLogDir(tempHome, sessionId);
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, "events.jsonl"),
      [
        JSON.stringify({
          message: {
            message: {
              role: "assistant",
              response_meta: {
                usage: {
                  total_tokens: 901,
                },
              },
              extra: {
                _source_model: "trae-log-model",
              },
            },
          },
        }),
        JSON.stringify({ compaction_end: { id: 1 } }),
        JSON.stringify({ compaction_end: { id: 2 } }),
      ].join("\n"),
    );

    const backend = new TraeCliBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });
    session.agentSessionId = sessionId;

    const parsed = backend.parseOutput(JSON.stringify({
      message: {
        content: "ok",
        response_meta: {
          usage: {
            total_tokens: 123,
          },
        },
        extra: {
          _source_model: "trae-stdout-model",
        },
      },
      session_id: sessionId,
    }), session);

    expect(parsed.text).toBe("ok");
    expect(parsed.model).toBe("trae-log-model");
    expect(parsed.contextTokens).toBe(901);
    expect(parsed.compactCount).toBe(2);
  });

  it("surfaces agent_end error_message from events.jsonl when stdout content is empty", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "trae-home-"));
    process.env["HOME"] = tempHome;
    process.env["XDG_CACHE_HOME"] = path.join(tempHome, ".cache");

    const sessionId = "session-error-1";
    const logDir = getTraeLogDir(tempHome, sessionId);
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, "events.jsonl"),
      JSON.stringify({
        agent_end: {
          error_message: "model 'Test-O-New': ValidationException: The value at messages.30.content.0.toolUse.input is empty.",
        },
      }),
    );

    const backend = new TraeCliBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });
    session.agentSessionId = sessionId;

    const parsed = backend.parseOutput(JSON.stringify({
      message: { content: "" },
      session_id: sessionId,
    }), session);

    expect(parsed.text).toContain("Coco 错误");
    expect(parsed.text).toContain("ValidationException");
  });

  it("uses the preassigned session id to find the log when stdout omits session_id", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "trae-home-"));
    process.env["HOME"] = tempHome;
    process.env["XDG_CACHE_HOME"] = path.join(tempHome, ".cache");

    const backend = new TraeCliBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });
    const sessionId = session.preassignedSessionId!;
    const logDir = getTraeLogDir(tempHome, sessionId);
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, "events.jsonl"),
      JSON.stringify({
        agent_end: {
          error_message: "preassigned log error",
        },
      }),
    );

    const parsed = backend.parseOutput(JSON.stringify({
      message: { content: "" },
    }), session);

    expect(parsed.agentSessionId).toBe(sessionId);
    expect(parsed.text).toContain("preassigned log error");
    expect(session.agentSessionId).toBe(sessionId);
  });

  it("does not override non-empty content with error_message", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "trae-home-"));
    process.env["HOME"] = tempHome;
    process.env["XDG_CACHE_HOME"] = path.join(tempHome, ".cache");

    const sessionId = "session-error-2";
    const logDir = getTraeLogDir(tempHome, sessionId);
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, "events.jsonl"),
      JSON.stringify({
        agent_end: {
          error_message: "some error",
        },
      }),
    );

    const backend = new TraeCliBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });
    session.agentSessionId = sessionId;

    const parsed = backend.parseOutput(JSON.stringify({
      message: { content: "actual reply" },
      session_id: sessionId,
    }), session);

    expect(parsed.text).toBe("actual reply");
  });

  it("keeps scanning incrementally across resume turns", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "trae-home-"));
    process.env["HOME"] = tempHome;
    process.env["XDG_CACHE_HOME"] = path.join(tempHome, ".cache");

    const sessionId = "session-log-2";
    const logDir = getTraeLogDir(tempHome, sessionId);
    const logPath = path.join(logDir, "events.jsonl");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      logPath,
      JSON.stringify({
        message: {
          message: {
            role: "assistant",
            response_meta: {
              usage: {
                total_tokens: 400,
              },
            },
            extra: {
              _source_model: "trae-first-model",
            },
          },
        },
      }),
    );

    const backend = new TraeCliBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });
    session.agentSessionId = sessionId;

    const first = backend.parseOutput(JSON.stringify({
      message: { content: "first" },
      session_id: sessionId,
    }), session);

    expect(first.contextTokens).toBe(400);
    expect(first.model).toBe("trae-first-model");
    expect(first.compactCount).toBeUndefined();

    fs.appendFileSync(
      logPath,
      "\n" + [
        JSON.stringify({ compaction_end: { id: 1 } }),
        JSON.stringify({
          message: {
            message: {
              role: "assistant",
              response_meta: {
                usage: {
                  total_tokens: 777,
                },
              },
              extra: {
                _source_model: "trae-second-model",
              },
            },
          },
        }),
      ].join("\n"),
    );

    const second = backend.parseOutput(JSON.stringify({
      message: { content: "second" },
      session_id: sessionId,
    }), session);

    expect(second.contextTokens).toBe(777);
    expect(second.model).toBe("trae-second-model");
    expect(second.compactCount).toBe(1);
  });
});
