import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentBackend, AgentSession, SessionTranscript } from "../agent/types.js";
import { archiveAgentSession, buildArchiveDirectoryName, getSessionArchiveDirectory } from "./archive.js";
import { loadArchivedTranscript } from "./reader.js";

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
  it("creates a manifest and native JSONL symlink atomically and idempotently", async () => {
    const home = mkdtempSync(join(tmpdir(), "niubot-archive-"));
    tempDirs.push(home);
    const native = join(home, "native.jsonl");
    writeFileSync(native, '{"type":"message"}\n');
    let exportCount = 0;
    const backend = {
      exportSessionTranscript: async () => {
        exportCount++;
        return { ...transcript, sources: [{ path: native, role: "session" }] };
      },
    } as AgentBackend;
    const session: AgentSession = { id: "internal-1" };
    const first = await archiveAgentSession(home, backend, session, metadata);
    const second = await archiveAgentSession(home, backend, session, metadata);
    expect(second).toBe(first);
    expect(exportCount).toBe(1);
    const manifest = JSON.parse(readFileSync(first, "utf-8"));
    expect(manifest).toMatchObject({ session_id: "f876dcde", backend: "codex" });
    const linked = join(dirname(first), manifest.sources[0].name);
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linked)).toBe(native);
    expect(statSync(first).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(first)).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "NiuBot", "session-archives", "c1")).mode & 0o777).toBe(0o700);
  });

  it("writes normalized JSONL snapshots for backends without native files", async () => {
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

    const manifestFile = await archiveAgentSession(home, backend, { id: "internal-stream" }, {
      ...metadata, sessionId: "streamed",
    });

    expect(produced).toBe(2);
    const manifest = JSON.parse(readFileSync(manifestFile, "utf-8"));
    expect(manifest.sources).toEqual([{ name: "events.jsonl", role: "normalized", format: "normalized-jsonl" }]);
    const snapshot = readFileSync(join(dirname(manifestFile), "events.jsonl"), "utf-8");
    expect(snapshot).toContain('"content":"first"');
    expect(snapshot).toContain('"content":"second"');
  });

  it("stores and reparses raw OpenCode rows without pre-rendering Markdown", async () => {
    const home = mkdtempSync(join(tmpdir(), "niubot-archive-opencode-"));
    tempDirs.push(home);
    const backend = {
      exportSessionTranscript: async () => ({
        backend: "opencode",
        agentSessionId: "open-1",
        events: [],
        snapshots: [{
          role: "rows",
          format: "opencode-rows-jsonl" as const,
          records: [{
            message_data: '{"role":"user"}',
            part_data: '{"type":"text","text":"raw row text"}',
            time_created: 1_700_000_000_000,
          }],
        }],
      }),
    } as AgentBackend;
    const manifestFile = await archiveAgentSession(home, backend, { id: "open-internal" }, {
      ...metadata, backend: "opencode", sessionId: "open-session",
    });
    const loaded = loadArchivedTranscript(manifestFile);
    const events = [];
    for await (const event of loaded.transcript.events) events.push(event);
    expect(loaded.manifest.sources[0]?.format).toBe("opencode-rows-jsonl");
    expect(events).toMatchObject([{ type: "user", content: "raw row text" }]);
  });

  it("rejects path traversal segments", () => {
    expect(() => getSessionArchiveDirectory("/tmp", "NiuBot", "../private")).toThrow("invalid chatId");
  });

  it("includes local start/end times and session id in directory name", () => {
    const name = buildArchiveDirectoryName(metadata);
    expect(name).toMatch(/^2026-07-12_\d\d-\d\d-\d\d--2026-07-12_\d\d-\d\d-\d\d_f876dcde$/);
  });
});
