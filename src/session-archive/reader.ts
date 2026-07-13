import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, join } from "node:path";
import Database from "better-sqlite3";
import type { SessionTranscript, TranscriptEvent, TranscriptEventType } from "../agent/types.js";
import {
  readClaudeTranscript,
  readCodexTranscript,
  readCursorTranscript,
  readGrokTranscript,
  readPiTranscript,
  transcriptFromOpencodeRows,
} from "./native-transcript.js";
import { SESSION_ARCHIVE_MANIFEST, type SessionArchiveManifest } from "./archive.js";

export interface LocatedSessionArchive {
  kind: "manifest";
  path: string;
}

export function findSessionArchive(directory: string, sessionId: string): LocatedSessionArchive | undefined {
  if (!existsSync(directory)) return undefined;
  const suffix = `_${sessionId}`;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith(suffix)) {
      const manifest = join(directory, entry.name, SESSION_ARCHIVE_MANIFEST);
      if (existsSync(manifest)) return { kind: "manifest", path: manifest };
    }
  }
  return undefined;
}

export function readSessionArchiveManifest(file: string): SessionArchiveManifest {
  const value = JSON.parse(readFileSync(file, "utf-8")) as Partial<SessionArchiveManifest>;
  if (value.schema_version !== 1 || !value.session_id || !value.chat_id || !value.backend
    || !value.agent_session_id || !Array.isArray(value.sources) || value.sources.length === 0) {
    throw new Error(`invalid session archive manifest: ${file}`);
  }
  for (const source of value.sources) {
    if (!source || typeof source.role !== "string" || !source.role) {
      throw new Error(`invalid session archive source in ${file}`);
    }
    if (source.format === "normalized-jsonl") {
      if (typeof source.name !== "string" || source.name === "." || source.name === ".."
        || source.name.includes("/") || source.name.includes("\\") || source.name.includes("\0")) {
        throw new Error(`invalid session archive source in ${file}`);
      }
    } else if (source.format === "native-jsonl" || source.format === "opencode-db") {
      if (typeof source.path !== "string" || !isAbsolute(source.path) || source.path.includes("\0")) {
        throw new Error(`invalid session archive source in ${file}`);
      }
    } else {
      throw new Error(`invalid session archive source in ${file}`);
    }
  }
  return value as SessionArchiveManifest;
}

export function loadArchivedTranscript(manifestFile: string): {
  manifest: SessionArchiveManifest;
  transcript: SessionTranscript;
} {
  const manifest = readSessionArchiveManifest(manifestFile);
  const directory = dirname(manifestFile);
  const normalized = manifest.sources.find((source) => source.format === "normalized-jsonl");
  if (normalized) {
    return {
      manifest,
      transcript: {
        backend: manifest.backend,
        agentSessionId: manifest.agent_session_id,
        events: readNormalizedEvents(join(directory, normalized.name)),
      },
    };
  }
  const opencodeDb = manifest.sources.find((source) => source.format === "opencode-db");
  if (opencodeDb) {
    return {
      manifest,
      transcript: transcriptFromOpencodeRows(
        manifest.agent_session_id,
        readOpencodeDatabaseRows(opencodeDb.path, manifest.agent_session_id),
      ),
    };
  }

  const source = (role: string) => {
    const item = manifest.sources.find((candidate) => candidate.role === role)
      ?? (manifest.sources.length === 1 ? manifest.sources[0] : undefined);
    if (!item || item.format !== "native-jsonl") throw new Error(`session archive source not found: ${role}`);
    return item.path;
  };

  let transcript: SessionTranscript;
  switch (manifest.backend) {
    case "claude":
      transcript = readClaudeTranscript(source("session"), manifest.agent_session_id);
      break;
    case "codex":
      transcript = readCodexTranscript(source("session"), manifest.agent_session_id);
      break;
    case "traecli":
      transcript = readCodexTranscript(source("session"), manifest.agent_session_id, "traecli");
      break;
    case "cursor":
      transcript = readCursorTranscript(source("session"), manifest.agent_session_id);
      break;
    case "pi":
      transcript = readPiTranscript(source("session"), manifest.agent_session_id);
      break;
    case "grok": {
      const events = manifest.sources.find((candidate) => candidate.role === "events");
      transcript = readGrokTranscript(
        source("history"),
        manifest.agent_session_id,
        events?.format === "native-jsonl" ? events.path : undefined,
      );
      break;
    }
    default:
      throw new Error(`unsupported archived transcript backend: ${manifest.backend}`);
  }
  return { manifest, transcript };
}

async function* readNormalizedEvents(file: string): AsyncGenerator<TranscriptEvent> {
  const input = createReadStream(file, { encoding: "utf-8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Partial<TranscriptEvent>;
      if (isEventType(value.type) && typeof value.content === "string") yield value as TranscriptEvent;
    } catch { /* skip malformed normalized event lines */ }
  }
}

export async function* readOpencodeDatabaseRows(file: string, sessionId: string): AsyncGenerator<{
  message_data: string;
  part_data: string;
  time_created: number | null;
}> {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`
      SELECT m.data AS message_data, p.data AS part_data,
             COALESCE(p.time_created, m.time_created) AS time_created
      FROM message m
      JOIN part p ON p.message_id = m.id
      WHERE m.session_id = ?
      ORDER BY COALESCE(p.time_created, m.time_created), p.id
    `).iterate(sessionId) as IterableIterator<{
      message_data: string;
      part_data: string;
      time_created: number | null;
    }>;
    for (const row of rows) {
      yield row;
    }
  } finally {
    db.close();
  }
}

function isEventType(value: unknown): value is TranscriptEventType {
  return value === "user" || value === "assistant" || value === "tool_call" || value === "tool_result";
}
