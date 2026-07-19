import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentBackend, AgentSession, SessionTranscript } from "../agent/types.js";
import { archiveAgentSession, buildArchiveDirectoryName, getSessionArchiveDirectory } from "./archive.js";
import { findSessionArchive, loadArchivedTranscript } from "./reader.js";

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
  it("creates a manifest with a native JSONL path atomically and idempotently", async () => {
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
    expect(manifest.sources).toEqual([{ path: native, role: "session", format: "native-jsonl" }]);
    expect(readdirSync(dirname(first))).toEqual(["manifest.json"]);
    if (process.platform !== "win32") {
      expect(statSync(first).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(first)).mode & 0o777).toBe(0o700);
      expect(statSync(join(home, "NiuBot", "session-archives", "c1")).mode & 0o777).toBe(0o700);
    }
  });

  it("rejects backends without a native data source", async () => {
    const home = mkdtempSync(join(tmpdir(), "niubot-archive-stream-"));
    tempDirs.push(home);
    const backend = {
      exportSessionTranscript: async () => ({ backend: "test", agentSessionId: "stream-1", events: [] }),
    } as AgentBackend;

    await expect(archiveAgentSession(home, backend, { id: "internal-stream" }, {
      ...metadata, sessionId: "streamed",
    })).rejects.toThrow("does not provide a native data source");
  });

  it("queries OpenCode rows directly from its database", async () => {
    const home = mkdtempSync(join(tmpdir(), "niubot-archive-opencode-"));
    tempDirs.push(home);
    const databaseFile = join(home, "opencode.db");
    const db = new Database(databaseFile);
    db.exec(`
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT, time_created INTEGER);
    `);
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)")
      .run("message-1", "open-1", '{"role":"user"}', 1_700_000_000_000);
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)")
      .run("part-1", "message-1", '{"type":"text","text":"raw row text"}', 1_700_000_000_000);
    db.close();
    const backend = {
      exportSessionTranscript: async () => ({
        backend: "opencode",
        agentSessionId: "open-1",
        events: [],
        sources: [{ path: databaseFile, role: "database", format: "opencode-db" as const }],
      }),
    } as AgentBackend;
    const manifestFile = await archiveAgentSession(home, backend, { id: "open-internal" }, {
      ...metadata, backend: "opencode", sessionId: "open-session",
    });
    const loaded = loadArchivedTranscript(manifestFile);
    const events = [];
    for await (const event of loaded.transcript.events) events.push(event);
    expect(loaded.manifest.sources).toEqual([{ path: databaseFile, role: "database", format: "opencode-db" }]);
    expect(readdirSync(dirname(manifestFile))).toEqual(["manifest.json"]);
    expect(events).toMatchObject([{ type: "user", content: "raw row text" }]);
  });

  it("rejects path traversal segments", () => {
    expect(() => getSessionArchiveDirectory("/tmp", "NiuBot", "../private")).toThrow("invalid chatId");
  });

  it("ignores old Markdown archives", () => {
    const home = mkdtempSync(join(tmpdir(), "niubot-archive-legacy-"));
    tempDirs.push(home);
    const directory = getSessionArchiveDirectory(home, "NiuBot", "c1");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "2026-07-13_10-00-00--2026-07-13_11-00-00_f876dcde.md"), "# old archive\n");
    expect(findSessionArchive(directory, "f876dcde")).toBeUndefined();
  });

  it("includes local start/end times and session id in directory name", () => {
    const name = buildArchiveDirectoryName(metadata);
    expect(name).toMatch(/^2026-07-12_\d\d-\d\d-\d\d--2026-07-12_\d\d-\d\d-\d\d_f876dcde$/);
  });
});
