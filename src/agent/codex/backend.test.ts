import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexCliBackend } from "./backend.js";

const originalHome = process.env["HOME"];

describe("CodexCliBackend session metadata", () => {
  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
  });

  it("hydrates model and context window from the Codex session log", () => {
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
            info: { model_context_window: 258400 },
          },
        }),
      ].join("\n"),
    );

    const backend = new CodexCliBackend();
    const session = backend.buildSession({ workingDirectory: tempHome });
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
    ].join("\n"));

    backend.updateSession(session, parsed);

    expect(parsed.model).toBe("gpt-5.4");
    expect(parsed.contextWindow).toBe(258400);
    expect(parsed.contextTokens).toBe(20523);
  });
});
