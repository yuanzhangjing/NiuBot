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
      args: ["-p", "--json", "--yolo", "second turn", "--resume", "session-123"],
    });
  });

  it("falls back to the main model when liteModel is not configured", () => {
    const backend = new TraeCliBackend();
    const session = backend.buildSession({
      workingDirectory: "/tmp/workspace",
      modelTier: "lite",
      model: "trae-main-model",
    });

    expect(session.model).toBe("trae-main-model");
  });

  it("parses stdout fields from the traecli json response", () => {
    const backend = new TraeCliBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp/workspace" });

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
      session_id: "session-abc",
    }), session);

    expect(parsed).toMatchObject({
      text: "hello from trae",
      agentSessionId: "session-abc",
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
