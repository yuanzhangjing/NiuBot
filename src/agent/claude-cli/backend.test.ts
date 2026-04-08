import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCliBackend } from "./backend.js";

const originalHome = process.env["HOME"];

describe("ClaudeCliBackend session metadata", () => {
  afterEach(() => {
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
    process.env["HOME"] = tempHome;

    const projectKey = path.resolve(workingDirectory).split(path.sep).join("-");
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

    const backend = new ClaudeCliBackend();
    const session = backend.buildSession({
      workingDirectory,
      agentSessionId: sessionId,
    });
    const parsed = backend.parseOutput([
      JSON.stringify({
        type: "result",
        result: "ok",
        session_id: sessionId,
        usage: {
          input_tokens: 20504,
          cache_creation_input_tokens: 512,
          cache_read_input_tokens: 5641152,
          output_tokens: 19,
        },
        modelUsage: {
          "claude-sonnet-4-5-20250929": {},
        },
      }),
    ].join("\n"));

    backend.updateSession(session, parsed);

    expect(parsed.model).toBe("claude-sonnet-4-5-20250929");
    expect(parsed.contextTokens).toBe(5662187);
  });
});
