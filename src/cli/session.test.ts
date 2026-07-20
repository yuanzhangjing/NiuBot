import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBackend } from "../agent/types.js";
import { initDatabase, storeMessage } from "../database/schema.js";
import { archiveAgentSession } from "../session-archive/archive.js";
import { readCodexTranscript } from "../session-archive/native-transcript.js";
import { handleSessions, markdownCodeFence } from "./session.js";

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg.startsWith("--")) {
      const next = args[index + 1];
      flags[arg.slice(2)] = next && !next.startsWith("-") ? (index++, next) : "true";
    } else if (arg === "-n") {
      flags.n = args[++index]!;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

describe("nbt sessions", () => {
  it("chooses a fence without expanding every backtick run as function arguments", () => {
    expect(markdownCodeFence("` ".repeat(200_000))).toBe("```");
    expect(markdownCodeFence("before ```` after")).toBe("`````");
  });

  it("lists linked archives, searches parsed events, and gets a complete event", async () => {
    const home = mkdtempSync(join(tmpdir(), "niubot-sessions-cli-"));
    tempDirs.push(home);
    const db = initDatabase(join(home, "niubot.db"));
    db.prepare("INSERT INTO users (id, platform, platform_id, name) VALUES ('u2', 'feishu', 'u2p', 'Zen')").run();
    db.prepare("INSERT INTO chats (id, platform, platform_id, type, user_id) VALUES ('c1', 'feishu', 'c1p', 'p2p', 'u2')").run();
    db.prepare(`
      INSERT INTO sessions (
        id, chat_id, user_id, source, status, backend_type, agent_session_id,
        started_at, ended_at, last_active_at
      ) VALUES (
        's1', 'c1', 'u2', 'user', 'archived', 'codex', 'thread-1',
        '2026-07-13 01:00:00', '2026-07-13 02:00:00', '2026-07-13 02:00:00'
      )
    `).run();
    const messageId = storeMessage(db, {
      chatId: "c1", senderId: "u2", sessionId: "s1", role: "user",
      contentText: "查找唯一标记 NEEDLE_FULL_TEXT", platform: "feishu",
    });

    const native = join(home, "codex.jsonl");
    const longOutput = `LONG_OUTPUT ${"x".repeat(24_980)} TAIL_MARKER`;
    writeFileSync(native, [
      { type: "response_item", timestamp: "2026-07-13T01:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "查找唯一标记 NEEDLE_FULL_TEXT" }] } },
      { type: "response_item", timestamp: "2026-07-13T01:00:00Z", payload: { type: "function_call", name: "shell", call_id: "call--fence", arguments: '{"text":"FENCE_MARK\\n```"}' } },
      { type: "response_item", timestamp: "2026-07-13T01:00:01Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "已经处理" }] } },
      { type: "response_item", timestamp: "2026-07-13T01:00:02Z", payload: { type: "custom_tool_call_output", call_id: "long-output", output: longOutput } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const transcript = { ...readCodexTranscript(native, "thread-1"), sources: [{ path: native, role: "session" }] };
    const backend = { exportSessionTranscript: async () => transcript } as AgentBackend;
    await archiveAgentSession(home, backend, { id: "agent-1" }, {
      botId: "NiuBot", chatId: "c1", sessionId: "s1", source: "user", backend: "codex",
      startedAt: "2026-07-13 01:00:00", archivedAt: "2026-07-13 02:00:00",
    });

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values) => lines.push(values.join(" ")));
    await handleSessions(db, ["list"], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("archive=source-reference");

    lines.length = 0;
    await handleSessions(db, ["search", "NEEDLE_FULL_TEXT"], "c1", "p2p", home, "NiuBot", parseArgs);
    const eventId = /\[event ([^\]]+)\]/.exec(lines[0] ?? "")?.[1];
    expect(eventId).toMatch(/^s1:e[0-9a-f]{12}$/);
    expect(lines[0]).toContain(`[message #${messageId}]`);
    expect(lines.join("\n")).toContain("查找唯一标记 NEEDLE_FULL_TEXT");

    lines.length = 0;
    await handleSessions(db, [
      "search", "NEEDLE_FULL_TEXT",
      "--since", "2026-07-13T01:00:00Z",
      "--before", "2026-07-13T01:00:01Z",
    ], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("NEEDLE_FULL_TEXT");

    lines.length = 0;
    await handleSessions(db, [
      "search", "NEEDLE_FULL_TEXT",
      "--before", "2026-07-13T01:00:00Z",
    ], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines).toEqual(["(无匹配 transcript 事件)"]);

    lines.length = 0;
    await handleSessions(db, ["get", eventId!], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("查找唯一标记 NEEDLE_FULL_TEXT");
    expect(lines.join("\n")).toContain(`event_id: ${eventId}`);

    lines.length = 0;
    await handleSessions(db, ["search", "FENCE_MARK"], "c1", "p2p", home, "NiuBot", parseArgs);
    const fenceEventId = /\[event ([^\]]+)\]/.exec(lines[0] ?? "")?.[1];
    lines.length = 0;
    await handleSessions(db, ["get", fenceEventId!], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("````text");
    expect(lines.join("\n")).toContain("call_id: call—fence");

    lines.length = 0;
    await handleSessions(db, ["search", "LONG_OUTPUT"], "c1", "p2p", home, "NiuBot", parseArgs);
    const longEventId = /\[event ([^\]]+)\]/.exec(lines[0] ?? "")?.[1];
    lines.length = 0;
    await handleSessions(db, ["get", longEventId!], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("内容已截断");
    expect(lines.join("\n")).not.toContain("TAIL_MARKER");

    lines.length = 0;
    await handleSessions(db, ["get", longEventId!, "--max-chars", "30000"], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("TAIL_MARKER");
    expect(lines.join("\n")).not.toContain("内容已截断");

    await expect(handleSessions(db, ["get", "s1", "--raw"], "c1", "p2p", home, "NiuBot", parseArgs))
      .rejects.toThrow("--raw is not supported");
    await expect(handleSessions(db, ["list", "--chat-id", "private-chat"], "c1", "group", home, "NiuBot", parseArgs))
      .rejects.toThrow("cross-chat query is not allowed in group chat");
    db.close();
  });
});
