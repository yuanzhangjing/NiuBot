import { randomUUID } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import type { AgentBackend, AgentSession, SessionTranscript, TranscriptEvent } from "../agent/types.js";
import { TZ } from "../tz.js";

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
  const file = join(directory, buildArchiveFileName(metadata));
  if (existsSync(file)) return file;
  const transcript = await backend.exportSessionTranscript(agentSession);

  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const eventCount = await writeSessionArchive(temporary, metadata, transcript);
    if (eventCount === 0) throw new Error("backend transcript contains no recoverable events");
    renameSync(temporary, file);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
  return file;
}

export function getSessionArchiveDirectory(niubotHome: string, botId: string, chatId: string): string {
  return join(niubotHome, safeSegment(botId, "botId"), "session-archives", safeSegment(chatId, "chatId"));
}

export function buildArchiveFileName(metadata: Pick<SessionArchiveMetadata, "startedAt" | "archivedAt" | "sessionId">): string {
  return `${fileTime(metadata.startedAt)}--${fileTime(metadata.archivedAt)}_${safeSegment(metadata.sessionId, "sessionId")}.md`;
}

export function formatSessionArchive(
  metadata: SessionArchiveMetadata,
  transcript: SessionTranscript & { events: Iterable<TranscriptEvent> },
): string {
  const lines = archiveHeader(metadata, transcript);
  for (const event of transcript.events) lines.push(...formatEvent(event));
  return `${lines.join("\n").trimEnd()}\n`;
}

async function writeSessionArchive(file: string, metadata: SessionArchiveMetadata, transcript: SessionTranscript): Promise<number> {
  const output = createWriteStream(file, { encoding: "utf-8", flags: "wx", mode: 0o600 });
  const completion = finished(output);
  void completion.catch(() => {});
  const write = async (content: string) => {
    if (!output.write(content)) await once(output, "drain");
  };
  try {
    await write(`${archiveHeader(metadata, transcript).join("\n")}\n`);
    let eventCount = 0;
    for await (const event of transcript.events) {
      await write(`${formatEvent(event).join("\n")}\n`);
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

function archiveHeader(metadata: SessionArchiveMetadata, transcript: SessionTranscript): string[] {
  return [
    "---",
    "schema_version: 1",
    `session_id: ${yamlString(metadata.sessionId)}`,
    `chat_id: ${yamlString(metadata.chatId)}`,
    `source: ${yamlString(metadata.source)}`,
    `backend: ${yamlString(metadata.backend)}`,
    `agent_session_id: ${yamlString(transcript.agentSessionId)}`,
    `started_at: ${yamlString(localIso(metadata.startedAt))}`,
    `archived_at: ${yamlString(localIso(metadata.archivedAt))}`,
    `timezone: ${yamlString(TZ)}`,
    "---",
    "",
    `# Session ${metadata.sessionId}`,
    "",
  ];
}

function formatEvent(event: TranscriptEvent): string[] {
  const lines: string[] = [];
  const time = event.timestamp ? formatEventTime(event.timestamp) : "time unavailable";
  const label = event.type.replace("_", " ");
  const tool = event.name ? ` · ${event.name}` : "";
  lines.push(`## ${time} · ${label}${tool}`, "");
  if (event.callId) lines.push(`<!-- call_id: ${escapeComment(event.callId)} -->`, "");
  if (event.type === "tool_call" || event.type === "tool_result") {
    const fence = codeFence(event.content);
    const language = event.type === "tool_call" && isJson(event.content) ? "json" : "text";
    lines.push(`${fence}${language}`, event.content, fence, "");
  } else {
    lines.push(event.content, "");
  }
  return lines;
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

function formatEventTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return localIso(date.toISOString()).replace("T", " ");
}

function parseUtc(value: string): Date {
  const normalized = value.replace(" ", "T");
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
}

function yamlString(value: string): string { return JSON.stringify(value); }
function two(value: number): string { return String(value).padStart(2, "0"); }
function escapeComment(value: string): string { return value.replace(/--/g, "—"); }
function codeFence(content: string): string {
  const longest = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}
function isJson(content: string): boolean {
  try { JSON.parse(content); return true; } catch { return false; }
}
