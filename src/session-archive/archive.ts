import { randomUUID } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { extname, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import type { AgentBackend, AgentSession, SessionTranscript } from "../agent/types.js";
import { TZ } from "../tz.js";

export const SESSION_ARCHIVE_MANIFEST = "manifest.json";

export interface SessionArchiveSource {
  name: string;
  role: string;
  format: "native-jsonl" | "normalized-jsonl" | "opencode-rows-jsonl";
}

export interface SessionArchiveManifest {
  schema_version: 1;
  session_id: string;
  chat_id: string;
  source: string;
  backend: string;
  agent_session_id: string;
  started_at: string;
  archived_at: string;
  timezone: string;
  sources: SessionArchiveSource[];
}

export interface SessionArchiveMetadata {
  botId: string;
  chatId: string;
  sessionId: string;
  source: string;
  backend: string;
  startedAt: string;
  archivedAt: string;
}

export async function archiveAgentSession(
  niubotHome: string,
  backend: AgentBackend,
  agentSession: AgentSession,
  metadata: SessionArchiveMetadata,
): Promise<string> {
  if (!backend.exportSessionTranscript) throw new Error("backend does not support session transcript export");
  const directory = getSessionArchiveDirectory(niubotHome, metadata.botId, metadata.chatId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const archiveDirectory = join(directory, buildArchiveDirectoryName(metadata));
  const manifestFile = join(archiveDirectory, SESSION_ARCHIVE_MANIFEST);
  if (existsSync(manifestFile)) return manifestFile;
  if (existsSync(archiveDirectory)) throw new Error(`session archive directory is incomplete: ${archiveDirectory}`);
  const transcript = await backend.exportSessionTranscript(agentSession);

  const temporary = join(directory, `.${buildArchiveDirectoryName(metadata)}.${randomUUID()}.tmp`);
  try {
    mkdirSync(temporary, { mode: 0o700 });
    const sources: SessionArchiveSource[] = [];
    if (transcript.sources?.length) {
      const usedNames = new Set<string>();
      for (const [index, source] of transcript.sources.entries()) {
        const target = resolve(source.path);
        if (!statSync(target).isFile()) throw new Error(`backend transcript source is not a file: ${target}`);
        const role = safeSourceRole(source.role ?? `source-${index + 1}`);
        const extension = extname(target) || ".jsonl";
        let name = `${role}${extension}`;
        if (usedNames.has(name)) name = `${role}-${index + 1}${extension}`;
        usedNames.add(name);
        symlinkSync(target, join(temporary, name));
        sources.push({ name, role, format: "native-jsonl" });
      }
    } else if (transcript.snapshots?.length) {
      const usedNames = new Set<string>();
      for (const [index, snapshot] of transcript.snapshots.entries()) {
        const role = safeSourceRole(snapshot.role || `snapshot-${index + 1}`);
        let name = `${role}.jsonl`;
        if (usedNames.has(name)) name = `${role}-${index + 1}.jsonl`;
        usedNames.add(name);
        const recordCount = await writeJsonlRecords(join(temporary, name), snapshot.records);
        if (recordCount === 0) throw new Error(`backend transcript snapshot is empty: ${role}`);
        sources.push({ name, role, format: snapshot.format });
      }
    } else {
      const name = "events.jsonl";
      const eventCount = await writeNormalizedTranscript(join(temporary, name), transcript);
      if (eventCount === 0) throw new Error("backend transcript contains no recoverable events");
      sources.push({ name, role: "normalized", format: "normalized-jsonl" });
    }

    const manifest: SessionArchiveManifest = {
      schema_version: 1,
      session_id: metadata.sessionId,
      chat_id: metadata.chatId,
      source: metadata.source,
      backend: metadata.backend,
      agent_session_id: transcript.agentSessionId,
      started_at: localIso(metadata.startedAt),
      archived_at: localIso(metadata.archivedAt),
      timezone: TZ,
      sources,
    };
    const temporaryManifest = join(temporary, SESSION_ARCHIVE_MANIFEST);
    writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf-8", flag: "wx", mode: 0o600 });
    chmodSync(temporaryManifest, 0o600);
    renameSync(temporary, archiveDirectory);
  } catch (err) {
    rmSync(temporary, { recursive: true, force: true });
    throw err;
  }
  return manifestFile;
}

export function getSessionArchiveDirectory(niubotHome: string, botId: string, chatId: string): string {
  return join(niubotHome, safeSegment(botId, "botId"), "session-archives", safeSegment(chatId, "chatId"));
}

export function buildArchiveDirectoryName(metadata: Pick<SessionArchiveMetadata, "startedAt" | "archivedAt" | "sessionId">): string {
  return `${fileTime(metadata.startedAt)}--${fileTime(metadata.archivedAt)}_${safeSegment(metadata.sessionId, "sessionId")}`;
}

async function writeNormalizedTranscript(file: string, transcript: SessionTranscript): Promise<number> {
  return writeJsonlRecords(file, transcript.events);
}

async function writeJsonlRecords(
  file: string,
  records: Iterable<unknown> | AsyncIterable<unknown>,
): Promise<number> {
  const output = createWriteStream(file, { encoding: "utf-8", flags: "wx", mode: 0o600 });
  const completion = finished(output);
  void completion.catch(() => {});
  const write = async (content: string) => {
    if (!output.write(content)) await once(output, "drain");
  };
  try {
    let eventCount = 0;
    for await (const record of records) {
      await write(`${JSON.stringify(record)}\n`);
      eventCount++;
    }
    output.end();
    await completion;
    return eventCount;
  } catch (err) {
    output.destroy();
    await completion.catch(() => {});
    throw err;
  }
}

function safeSourceRole(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "source";
}

function safeSegment(value: string, label: string): string {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(`invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function fileTime(utc: string): string {
  return localIso(utc).slice(0, 19).replace("T", "_").replaceAll(":", "-");
}

function localIso(utc: string): string {
  const date = parseUtc(utc);
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  const asUtc = Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")), Number(get("hour")), Number(get("minute")), Number(get("second")));
  const offsetMinutes = Math.round((asUtc - date.getTime()) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${sign}${two(Math.floor(absolute / 60))}:${two(absolute % 60)}`;
}

function parseUtc(value: string): Date {
  const normalized = value.replace(" ", "T");
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
}

function two(value: number): string { return String(value).padStart(2, "0"); }
