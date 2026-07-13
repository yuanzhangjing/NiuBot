import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentBackend, AgentSession, SessionTranscript } from "../agent/types.js";
import { archiveAgentSession, buildArchiveFileName, formatSessionArchive, getSessionArchiveDirectory } from "./archive.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const metadata = {
  botId: "NiuBot",
  chatId: "c1",
  sessionId: "f876dcde",
  source: "user",
  backend: "codex",
  startedAt: "2026-07-12 06:11:03",
  archivedAt: "2026-07-12 15:11:28",
};

const transcript: SessionTranscript = {
  backend: "codex",
  agentSessionId: "thread-1",
  events: [
    { timestamp: "2026-07-12T06:11:03Z", type: "user", content: "检查问题" },
    { timestamp: "2026-07-12T06:11:04Z", type: "tool_call", name: "exec", callId: "call-1", content: '{"cmd":"pwd"}' },
    { timestamp: "2026-07-12T06:11:05Z", type: "tool_result", name: "exec", callId: "call-1", content: "/tmp" },
    { type: "assistant", content: "已经找到。" },
  ],
};

describe("session archive", () => {
  it("formats metadata and transcript events as Markdown", () => {
    const output = formatSessionArchive(metadata, transcript);
    expect(output).toContain("schema_version: 1");
    expect(output).toContain('session_id: "f876dcde"');
    expect(output).toContain('timezone:');
    expect(output).toContain("· tool call · exec");
    expect(output).toContain("<!-- call_id: call-1 -->");
    expect(output).toContain("```json\n{\"cmd\":\"pwd\"}\n```");
    expect(output).toContain("## time unavailable · assistant");
  });

  it("writes atomically and is idempotent", async () => {
    const home = mkdtempSync(join(tmpdir(), "niubot-archive-"));
    tempDirs.push(home);
    let exportCount = 0;
    const backend = { exportSessionTranscript: async () => { exportCount++; return transcript; } } as AgentBackend;
    const session: AgentSession = { id: "internal-1" };
    const first = await archiveAgentSession(home, backend, session, metadata);
    const second = await archiveAgentSession(home, backend, session, metadata);
    expect(second).toBe(first);
    expect(exportCount).toBe(1);
    expect(readFileSync(first, "utf-8")).toContain("检查问题");
    expect(statSync(first).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "NiuBot", "session-archives", "c1")).mode & 0o777).toBe(0o700);
  });

  it("writes async transcript events as they are produced", async () => {
    const home = mkdtempSync(join(tmpdir(), "niubot-archive-stream-"));
    tempDirs.push(home);
    let produced = 0;
    async function* events() {
      produced++;
      yield { type: "user" as const, content: "first" };
      await Promise.resolve();
      produced++;
      yield { type: "assistant" as const, content: "second" };
    }
    const backend = {
      exportSessionTranscript: async () => ({ backend: "test", agentSessionId: "stream-1", events: events() }),
    } as AgentBackend;

    const file = await archiveAgentSession(home, backend, { id: "internal-stream" }, {
      ...metadata, sessionId: "streamed",
    });

    expect(produced).toBe(2);
    expect(readFileSync(file, "utf-8")).toContain("first");
    expect(readFileSync(file, "utf-8")).toContain("second");
  });

  it("rejects path traversal segments", () => {
    expect(() => getSessionArchiveDirectory("/tmp", "NiuBot", "../private")).toThrow("invalid chatId");
  });

  it("includes local start/end times and session id in file name", () => {
    const name = buildArchiveFileName(metadata);
    expect(name).toMatch(/^2026-07-12_\d\d-\d\d-\d\d--2026-07-12_\d\d-\d\d-\d\d_f876dcde\.md$/);
  });
});
