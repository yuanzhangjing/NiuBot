import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { SessionTranscript } from "../agent/types.js";
import { nativeSessionId } from "../agent/session-id.js";
import { locateGrokChatHistory } from "../backends/grok.js";
import { encodePiSessionDir } from "../backends/pi.js";
import { resolveOpencodeDatabasePath } from "../backends/opencode.js";
import { normalizeBackend } from "../config.js";
import { claudeProjectKey, cursorProjectKey } from "../platform/workspace-path.js";
import {
  readClaudeTranscript,
  readCodexTranscript,
  readCursorTranscript,
  readGrokTranscript,
  readPiTranscript,
  transcriptFromOpencodeRows,
} from "./native-transcript.js";

type LiveLoader = (cwd: string, nativeId: string) => SessionTranscript | undefined;

function fromJsonl(
  locate: (cwd: string, nativeId: string) => string | undefined,
  read: (file: string, nativeId: string) => SessionTranscript,
): LiveLoader {
  return (cwd, nativeId) => {
    const file = locate(cwd, nativeId);
    return file ? read(file, nativeId) : undefined;
  };
}

const LIVE_LOADERS: Record<string, LiveLoader> = {
  grok: fromJsonl(locateGrokChatHistory, readGrokTranscript),
  claude: fromJsonl(locateClaudeTranscript, readClaudeTranscript),
  cursor: fromJsonl(locateCursorTranscript, readCursorTranscript),
  pi: fromJsonl(locatePiTranscript, readPiTranscript),
  codex: fromJsonl(
    (_cwd, nativeId) => locateDatedTranscript(join(codexHome(), "sessions"), nativeId),
    readCodexTranscript,
  ),
  traecli: fromJsonl(
    (_cwd, nativeId) => locateDatedTranscript(traeSessionsRoot(), nativeId),
    (file, nativeId) => readCodexTranscript(file, nativeId, "traecli"),
  ),
  opencode: (_cwd, nativeId) => loadOpencodeTranscript(nativeId),
};

export function loadLiveTranscript(options: {
  backend?: string | null;
  agentSessionId?: string | null;
  cwd: string;
}): SessionTranscript | undefined {
  const nativeId = nativeSessionId(options.agentSessionId);
  if (!nativeId) return undefined;
  const backend = normalizeBackend(options.backend ?? undefined);
  return backend ? LIVE_LOADERS[backend]?.(options.cwd, nativeId) : undefined;
}

function locateClaudeTranscript(cwd: string, nativeId: string): string | undefined {
  const configDir = process.env["CLAUDE_CONFIG_DIR"]?.trim()
    ? resolve(process.env["CLAUDE_CONFIG_DIR"]!)
    : resolve(homedir(), ".claude");
  const file = join(configDir, "projects", claudeProjectKey(cwd), `${nativeId}.jsonl`);
  return existsSync(file) ? file : undefined;
}

function locateCursorTranscript(cwd: string, nativeId: string): string | undefined {
  const dataDir = process.env["CURSOR_AGENT_HOME"]?.trim()
    ? resolve(process.env["CURSOR_AGENT_HOME"]!)
    : join(homedir(), ".cursor");
  const projectDir = join(dataDir, "projects", cursorProjectKey(cwd), "agent-transcripts");
  for (const candidate of [
    join(projectDir, nativeId, `${nativeId}.jsonl`),
    join(projectDir, `${nativeId}.jsonl`),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  const projectsDir = join(dataDir, "projects");
  if (!existsSync(projectsDir)) return undefined;
  for (const projectKey of listNames(projectsDir, "dir")) {
    const transcriptsDir = join(projectsDir, projectKey, "agent-transcripts");
    const nested = join(transcriptsDir, nativeId, `${nativeId}.jsonl`);
    if (existsSync(nested)) return nested;
    const flat = join(transcriptsDir, `${nativeId}.jsonl`);
    if (existsSync(flat)) return flat;
  }
  return undefined;
}

function locatePiTranscript(cwd: string, nativeId: string): string | undefined {
  const piHome = process.env["PI_HOME"]?.trim() ? resolve(process.env["PI_HOME"]!) : join(homedir(), ".pi");
  const root = join(piHome, "agent", "sessions", encodePiSessionDir(cwd));
  if (!existsSync(root)) return undefined;
  const match = listNames(root, "file").find((name) => name.endsWith(`_${nativeId}.jsonl`));
  return match ? join(root, match) : undefined;
}

function locateDatedTranscript(root: string, nativeId: string): string | undefined {
  if (!existsSync(root)) return undefined;
  for (const year of listNames(root, "dir").sort().reverse()) {
    const yearDir = join(root, year);
    for (const month of listNames(yearDir, "dir").sort().reverse()) {
      const monthDir = join(yearDir, month);
      for (const day of listNames(monthDir, "dir").sort().reverse()) {
        const dayDir = join(monthDir, day);
        const match = listNames(dayDir, "file").find((name) => isDatedSessionFile(name, nativeId));
        if (match) return join(dayDir, match);
      }
    }
  }
  return undefined;
}

function loadOpencodeTranscript(nativeId: string): SessionTranscript | undefined {
  const dbPath = resolveOpencodeDatabasePath();
  if (!existsSync(dbPath)) return undefined;
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return undefined;
  }
  try {
    const rows = db.prepare(`
      SELECT m.data AS message_data, p.data AS part_data,
             COALESCE(p.time_created, m.time_created) AS time_created
      FROM message m
      JOIN part p ON p.message_id = m.id
      WHERE m.session_id = ?
      ORDER BY COALESCE(p.time_created, m.time_created), p.id
    `).all(nativeId) as Array<{
      message_data: string;
      part_data: string;
      time_created: number | null;
    }>;
    if (rows.length === 0) return undefined;
    return transcriptFromOpencodeRows(nativeId, rows);
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

function isDatedSessionFile(name: string, nativeId: string): boolean {
  return name === `${nativeId}.jsonl` || name.endsWith(`-${nativeId}.jsonl`);
}

function codexHome(): string {
  const override = process.env["CODEX_HOME"]?.trim();
  return override ? resolve(override) : resolve(homedir(), ".codex");
}

function traeSessionsRoot(): string {
  const override = process.env["TRAE_HOME"]?.trim();
  return join(override ? resolve(override) : resolve(homedir(), ".trae"), "cli", "sessions");
}

function listNames(dir: string, kind: "dir" | "file"): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => kind === "dir" ? entry.isDirectory() : entry.isFile() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
