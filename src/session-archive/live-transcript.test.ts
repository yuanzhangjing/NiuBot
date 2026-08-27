import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeGrokSessionDir } from "../backends/grok.js";
import { encodePiSessionDir } from "../backends/pi.js";
import { claudeProjectKey, cursorProjectKey } from "../platform/workspace-path.js";
import { loadLiveTranscript } from "./live-transcript.js";
import { closeTestDatabases, openRawTestDatabase } from "../../test-utils/database.js";

vi.mock("../backends/opencode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../backends/opencode.js")>();
  return {
    ...actual,
    resolveOpencodeDatabasePath(options?: Parameters<typeof actual.resolveOpencodeDatabasePath>[0]) {
      const env = options?.env ?? process.env;
      const xdg = env["XDG_DATA_HOME"]?.trim();
      if (xdg) return join(xdg, "opencode", "opencode.db");
      return actual.resolveOpencodeDatabasePath({
        ...options,
        queryPath: options?.queryPath ?? (() => {
          throw new Error("skip opencode cli in tests");
        }),
      });
    },
  };
});

const tempDirs: string[] = [];

beforeEach(() => {
  const isolated = mkdtempSync(join(tmpdir(), "niubot-live-home-"));
  tempDirs.push(isolated);
  vi.stubEnv("HOME", isolated);
  vi.stubEnv("USERPROFILE", isolated);
  vi.stubEnv("GROK_HOME", join(isolated, ".grok"));
  vi.stubEnv("CODEX_HOME", join(isolated, ".codex"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(isolated, ".claude"));
  vi.stubEnv("CURSOR_AGENT_HOME", join(isolated, ".cursor"));
  vi.stubEnv("PI_HOME", join(isolated, ".pi"));
  vi.stubEnv("TRAE_HOME", join(isolated, ".trae"));
  vi.stubEnv("XDG_DATA_HOME", join(isolated, "share"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  closeTestDatabases();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function writeJsonl(file: string, rows: unknown[]): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

async function collect(transcript: ReturnType<typeof loadLiveTranscript>) {
  if (!transcript) return [];
  const events = [];
  for await (const event of transcript.events) events.push(event);
  return events;
}

describe("loadLiveTranscript", () => {
  it("reads grok, claude, cursor, pi, dated codex/trae, and opencode sessions", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "niubot-live-cwd-"));
    tempDirs.push(cwd);
    const claudeHome = process.env["CLAUDE_CONFIG_DIR"]!;
    const cursorHome = process.env["CURSOR_AGENT_HOME"]!;
    const grokHome = process.env["GROK_HOME"]!;
    const piHome = process.env["PI_HOME"]!;
    const traeHome = process.env["TRAE_HOME"]!;
    const xdg = process.env["XDG_DATA_HOME"]!;

    const grokDir = join(grokHome, "sessions", encodeGrokSessionDir(cwd), "grok-1");
    writeJsonl(join(grokDir, "chat_history.jsonl"), [
      { type: "user", timestamp: "2026-08-25T01:00:00Z", content: "grok 问" },
      { type: "assistant", timestamp: "2026-08-25T01:00:01Z", content: "grok 答" },
    ]);
    writeJsonl(join(claudeHome, "projects", claudeProjectKey(cwd), "claude-1.jsonl"), [
      { type: "user", timestamp: "2026-08-25T01:00:00Z", message: { content: [{ type: "text", text: "claude 问" }] } },
      { type: "assistant", timestamp: "2026-08-25T01:00:01Z", message: { content: [{ type: "text", text: "claude 答" }] } },
    ]);
    writeJsonl(join(cursorHome, "projects", cursorProjectKey(cwd), "agent-transcripts", "cursor-1", "cursor-1.jsonl"), [
      { role: "user", timestamp: "2026-08-25T01:00:00Z", message: { content: [{ type: "text", text: "cursor 问" }] } },
      { role: "assistant", timestamp: "2026-08-25T01:00:01Z", message: { content: [{ type: "text", text: "cursor 答" }] } },
    ]);
    writeJsonl(join(process.env["CODEX_HOME"]!, "sessions", "2026", "08", "25", "rollout-codex-1.jsonl"), [
      { type: "response_item", timestamp: "2026-08-25T01:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "codex 问" }] } },
      { type: "response_item", timestamp: "2026-08-25T01:00:01Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "codex 答" }] } },
    ]);
    writeJsonl(join(traeHome, "cli", "sessions", "2026", "08", "25", "rollout-trae-1.jsonl"), [
      { type: "response_item", timestamp: "2026-08-25T01:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "trae 问" }] } },
      { type: "response_item", timestamp: "2026-08-25T01:00:01Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "trae 答" }] } },
    ]);
    writeJsonl(join(piHome, "agent", "sessions", encodePiSessionDir(cwd), "2026-08-25T10-00-00_pi-1.jsonl"), [
      { type: "message", timestamp: "2026-08-25T01:00:00Z", message: { role: "user", content: [{ type: "text", text: "pi 问" }] } },
      { type: "message", timestamp: "2026-08-25T01:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "pi 答" }] } },
    ]);

    const dbFile = join(xdg, "opencode", "opencode.db");
    mkdirSync(join(dbFile, ".."), { recursive: true });
    const db = openRawTestDatabase(dbFile);
    db.exec(`
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT, time_created INTEGER);
    `);
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m1", "open-1", '{"role":"user"}', 1_700_000_000_000);
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run("p1", "m1", '{"type":"text","text":"opencode 问"}', 1_700_000_000_000);
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m2", "open-1", '{"role":"assistant"}', 1_700_000_000_100);
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run("p2", "m2", '{"type":"text","text":"opencode 答"}', 1_700_000_000_100);
    db.close();

    const grok = loadLiveTranscript({ backend: "grok-build", agentSessionId: "grok-1", cwd });
    const claude = loadLiveTranscript({ backend: "claude-code", agentSessionId: "claude-1", cwd });
    const cursor = loadLiveTranscript({ backend: "cursor-agent", agentSessionId: "cursor-1", cwd });
    const codex = loadLiveTranscript({ backend: "codex", agentSessionId: "codex-1", cwd });
    const trae = loadLiveTranscript({ backend: "trae-cli", agentSessionId: "trae-1", cwd });
    const pi = loadLiveTranscript({ backend: "pi-agent", agentSessionId: "pi-1", cwd });
    const opencode = loadLiveTranscript({ backend: "opencode", agentSessionId: "open-1", cwd });

    expect(grok?.backend).toBe("grok");
    expect(claude?.backend).toBe("claude");
    expect(cursor?.backend).toBe("cursor");
    expect(codex?.backend).toBe("codex");
    expect(trae?.backend).toBe("traecli");
    expect(pi?.backend).toBe("pi");
    expect(opencode?.backend).toBe("opencode");
    expect((await collect(grok)).map((event) => event.content)).toEqual(["grok 问", "grok 答"]);
    expect((await collect(claude)).map((event) => event.content)).toEqual(["claude 问", "claude 答"]);
    expect((await collect(cursor)).map((event) => event.content)).toEqual(["cursor 问", "cursor 答"]);
    expect((await collect(codex)).map((event) => event.content)).toEqual(["codex 问", "codex 答"]);
    expect((await collect(trae)).map((event) => event.content)).toEqual(["trae 问", "trae 答"]);
    expect((await collect(pi)).map((event) => event.content)).toEqual(["pi 问", "pi 答"]);
    expect((await collect(opencode)).map((event) => event.content)).toEqual(["opencode 问", "opencode 答"]);
  });

  it("finds a flat cursor transcript even when the cwd project key differs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "niubot-live-cursor-cwd-"));
    tempDirs.push(cwd);
    const cursorHome = process.env["CURSOR_AGENT_HOME"]!;
    writeJsonl(join(cursorHome, "projects", "other-project", "agent-transcripts", "cursor-flat.jsonl"), [
      { role: "user", timestamp: "2026-08-25T01:00:00Z", message: { content: [{ type: "text", text: "flat 问" }] } },
      { role: "assistant", timestamp: "2026-08-25T01:00:01Z", message: { content: [{ type: "text", text: "flat 答" }] } },
    ]);
    const cursor = loadLiveTranscript({ backend: "cursor", agentSessionId: "cursor-flat", cwd });
    expect((await collect(cursor)).map((event) => event.content)).toEqual(["flat 问", "flat 答"]);
  });

  it("does not treat a longer pi session id as a prefix of a shorter one", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "niubot-live-pi-cwd-"));
    tempDirs.push(cwd);
    const piRoot = join(process.env["PI_HOME"]!, "agent", "sessions", encodePiSessionDir(cwd));
    writeJsonl(join(piRoot, "2026-08-25T10-00-00_pi-10.jsonl"), [
      { type: "message", timestamp: "2026-08-25T01:00:00Z", message: { role: "user", content: [{ type: "text", text: "pi-10 问" }] } },
    ]);
    expect(loadLiveTranscript({ backend: "pi", agentSessionId: "pi-1", cwd })).toBeUndefined();
    expect((await collect(loadLiveTranscript({ backend: "pi", agentSessionId: "pi-10", cwd }))).map((event) => event.content))
      .toEqual(["pi-10 问"]);
  });

  it("does not treat a UUID suffix as a short dated session id", () => {
    writeJsonl(join(process.env["CODEX_HOME"]!, "sessions", "2026", "08", "25", "rollout-01a036e4-79ba-7b01-8531-0551b9ecafa3.jsonl"), [
      { type: "response_item", timestamp: "2026-08-25T01:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "宿主 session" }] } },
    ]);
    expect(loadLiveTranscript({ backend: "codex", agentSessionId: "a3", cwd: process.cwd() })).toBeUndefined();
  });

  it("returns undefined for unknown backends and missing files", () => {
    expect(loadLiveTranscript({ backend: "unknown", agentSessionId: "abc", cwd: process.cwd() })).toBeUndefined();
    expect(loadLiveTranscript({ backend: "claude", agentSessionId: "missing", cwd: process.cwd() })).toBeUndefined();
    expect(loadLiveTranscript({ backend: "grok", agentSessionId: "grok_1787630975612_af90f32a", cwd: process.cwd() })).toBeUndefined();
    expect(loadLiveTranscript({ backend: "opencode", agentSessionId: "missing", cwd: process.cwd() })).toBeUndefined();
  });
});
