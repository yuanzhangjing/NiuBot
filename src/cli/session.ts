import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { SessionTranscript, TranscriptEvent } from "../agent/types.js";
import { getSessionArchiveDirectory } from "../session-archive/archive.js";
import {
  findSessionArchive,
  loadArchivedTranscript,
  type LocatedSessionArchive,
} from "../session-archive/reader.js";
import { listSessionMessages } from "../messages/store.js";
import {
  getSessionForAccess,
  listSessions,
  listSessionsOverlappingUtcRange,
  type SessionRow,
} from "../sessions/store.js";
import {
  formatLocalDateTimeWithTZ,
  instantIsInUtcRange,
  userTimeRangeToUtc,
} from "../tz.js";

type ParseArgs = (args: string[]) => { positional: string[]; flags: Record<string, string> };

const DEFAULT_EVENT_MAX_CHARS = 20_000;
const DEFAULT_SESSION_MAX_CHARS = 100_000;
const MAX_OUTPUT_CHARS = 1_000_000;
const TRUNCATED_NOTICE = "\n\n[内容已截断；使用 --max-chars <n> 调高限制]";

export async function handleSessions(
  db: Database.Database,
  args: string[],
  currentChatId: string | undefined,
  chatType: "p2p" | "group",
  niubotHome: string,
  botName: string | undefined,
  parseArgs: ParseArgs,
): Promise<void> {
  if (!botName) throw new Error("NIUBOT_BOT_NAME not set");
  const sub = args[0];
  if (sub === "list") {
    sessionList(db, args.slice(1), currentChatId, chatType, niubotHome, botName, parseArgs);
  } else if (sub === "search") {
    await sessionSearch(db, args.slice(1), currentChatId, chatType, niubotHome, botName, parseArgs);
  } else if (sub === "get") {
    await sessionGet(db, args.slice(1), currentChatId, chatType, niubotHome, botName, parseArgs);
  } else if (sub === "--help" || sub === "help") {
    printHelp();
  } else {
    console.log("Usage: nbt sessions <list|search|get>");
  }
}

function sessionList(
  db: Database.Database,
  args: string[],
  currentChatId: string | undefined,
  chatType: "p2p" | "group",
  niubotHome: string,
  botName: string,
  parseArgs: ParseArgs,
): void {
  const { flags } = parseArgs(args);
  const targetChatId = requireChatId(flags["chat-id"] ?? currentChatId);
  const rows = listSessions(db, {
    currentChatId,
    chatType,
    targetChatId,
    limit: numberFlag(flags["limit"] ?? flags["n"], 10),
    since: flags["since"],
    before: flags["before"],
  });
  if (rows.length === 0) {
    console.log("(无归档 session)");
    return;
  }
  for (const row of rows) {
    const archive = locate(niubotHome, botName, row);
    const archiveLabel = archive ? "source-reference" : "missing";
    console.log(formatSessionRow(row, archiveLabel));
  }
}

async function sessionSearch(
  db: Database.Database,
  args: string[],
  currentChatId: string | undefined,
  chatType: "p2p" | "group",
  niubotHome: string,
  botName: string,
  parseArgs: ParseArgs,
): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const query = positional.join(" ");
  if (!query) throw new Error("Usage: nbt sessions search <query>");
  const targetChatId = requireChatId(flags["chat-id"] ?? currentChatId);
  const limit = numberFlag(flags["limit"] ?? flags["n"], 10);
  const eventRange = userTimeRangeToUtc({ since: flags["since"], before: flags["before"] });
  const rows = listSessionsOverlappingUtcRange(db, {
    currentChatId,
    chatType,
    targetChatId,
    limit: numberFlag(flags["sessions"], 500),
    sinceUtc: eventRange.since,
    beforeUtc: eventRange.before,
  });
  const needle = query.toLocaleLowerCase();
  let matches = 0;
  for (const row of rows) {
    const archive = locate(niubotHome, botName, row);
    if (!archive) continue;
    try {
      const transcript = transcriptFor(row, archive);
      const seen = new Map<string, number>();
      const messageIds = sessionMessageIds(db, row.id);
      for await (const event of transcript.events) {
        const eventId = makeEventId(row.id, event, seen);
        const messageId = takeMessageId(messageIds, event);
        if (!instantIsInUtcRange(event.timestamp, eventRange)) continue;
        const index = event.content.toLocaleLowerCase().indexOf(needle);
        if (index < 0) continue;
        console.log(`[event ${eventId}]${messageId ? ` [message #${messageId}]` : ""} [session ${row.id}] ${eventLabel(event)}`);
        console.log(snippet(event.content, index, query.length));
        console.log("---");
        matches++;
        if (matches >= limit) return;
      }
    } catch (err) {
      console.error(`Warning: cannot read session ${row.id}: ${(err as Error).message}`);
    }
  }
  if (matches === 0) console.log("(无匹配 transcript 事件)");
}

async function sessionGet(
  db: Database.Database,
  args: string[],
  currentChatId: string | undefined,
  chatType: "p2p" | "group",
  niubotHome: string,
  botName: string,
  parseArgs: ParseArgs,
): Promise<void> {
  const { positional, flags } = parseArgs(args);
  if (flags["raw"] === "true") throw new Error("--raw is not supported; use parsed session output");
  const idArg = positional[0];
  if (!idArg) throw new Error("Usage: nbt sessions get <session-id|event-id>");
  const separator = idArg.indexOf(":e");
  const sessionId = separator >= 0 ? idArg.slice(0, separator) : idArg;
  const requestedEventId = separator >= 0 ? idArg : flags["event"];
  const maxChars = boundedNumberFlag(
    flags["max-chars"],
    requestedEventId ? DEFAULT_EVENT_MAX_CHARS : DEFAULT_SESSION_MAX_CHARS,
    MAX_OUTPUT_CHARS,
  );
  const row = getSessionForAccess(db, sessionId, { currentChatId, chatType });
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  const archive = locate(niubotHome, botName, row);
  if (!archive) throw new Error(`Session archive not found: ${sessionId}`);

  const transcript = transcriptFor(row, archive);
  const seen = new Map<string, number>();
  let remainingChars = maxChars;
  if (!requestedEventId && flags["format"] !== "jsonl") printSessionHeader(row, transcript.agentSessionId);
  for await (const event of transcript.events) {
    const eventId = makeEventId(row.id, event, seen);
    if (requestedEventId && eventId !== requestedEventId) continue;
    const { event: outputEvent, truncated } = limitEventContent(event, remainingChars);
    if (flags["format"] === "jsonl") {
      console.log(JSON.stringify({ event_id: eventId, ...outputEvent, ...(truncated ? { truncated: true } : {}) }));
    } else {
      printEvent(eventId, outputEvent);
    }
    remainingChars -= outputEvent.content.length;
    if (requestedEventId) return;
    if (truncated || remainingChars <= 0) return;
  }
  if (requestedEventId) throw new Error(`Transcript event not found: ${requestedEventId}`);
}

function locate(niubotHome: string, botName: string, row: SessionRow): LocatedSessionArchive | undefined {
  return findSessionArchive(getSessionArchiveDirectory(niubotHome, botName, row.chat_id), row.id);
}

function transcriptFor(row: SessionRow, archive: LocatedSessionArchive): SessionTranscript {
  const transcript = loadArchivedTranscript(archive.path).transcript;
  return { ...transcript, events: inferToolResultNames(transcript.events) };
}

async function* inferToolResultNames(
  events: SessionTranscript["events"],
): AsyncGenerator<TranscriptEvent> {
  const names = new Map<string, string>();
  for await (const event of events) {
    if (event.type === "tool_call" && event.callId && event.name) names.set(event.callId, event.name);
    if (event.type === "tool_result" && !event.name && event.callId) {
      yield { ...event, name: names.get(event.callId) };
    } else {
      yield event;
    }
  }
}

function printSessionHeader(row: SessionRow, agentSessionId: string): void {
  console.log(`---\nsession_id: ${JSON.stringify(row.id)}`);
  console.log(`chat_id: ${JSON.stringify(row.chat_id)}`);
  console.log(`backend: ${JSON.stringify(row.backend_type ?? "unknown")}`);
  console.log(`agent_session_id: ${JSON.stringify(agentSessionId)}`);
  console.log(`started_at: ${JSON.stringify(formatLocalDateTimeWithTZ(row.started_at))}`);
  console.log(`archived_at: ${JSON.stringify(row.ended_at ? formatLocalDateTimeWithTZ(row.ended_at) : "")}`);
  console.log("---\n");
  console.log(`# Session ${row.id}\n`);
}

function printEvent(eventId: string, event: TranscriptEvent): void {
  console.log(`## ${eventLabel(event)}`);
  console.log(`<!-- event_id: ${eventId}${event.callId ? `; call_id: ${escapeComment(event.callId)}` : ""} -->\n`);
  if (event.type === "tool_call" || event.type === "tool_result") {
    const fence = markdownCodeFence(event.content);
    console.log(`${fence}text`);
    console.log(event.content);
    console.log(`${fence}\n`);
  } else {
    console.log(`${event.content}\n`);
  }
}

function eventLabel(event: TranscriptEvent): string {
  const time = event.timestamp ? formatLocalDateTimeWithTZ(event.timestamp) : "time unavailable";
  const type = event.type.replace("_", " ");
  return `${time} · ${type}${event.name ? ` · ${event.name}` : ""}`;
}

function makeEventId(sessionId: string, event: TranscriptEvent, seen: Map<string, number>): string {
  const digest = createHash("sha256").update(JSON.stringify(event)).digest("hex").slice(0, 12);
  const count = (seen.get(digest) ?? 0) + 1;
  seen.set(digest, count);
  return `${sessionId}:e${digest}${count > 1 ? `-${count}` : ""}`;
}

function sessionMessageIds(db: Database.Database, sessionId: string): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const row of listSessionMessages(db, sessionId)) {
    const key = `${row.role}\0${row.content_text}`;
    const ids = result.get(key) ?? [];
    ids.push(row.id);
    result.set(key, ids);
  }
  return result;
}

function takeMessageId(messages: Map<string, number[]>, event: TranscriptEvent): number | undefined {
  if (event.type !== "user" && event.type !== "assistant") return undefined;
  return messages.get(`${event.type}\0${event.content}`)?.shift();
}

function snippet(content: string, index: number, queryLength: number): string {
  const start = Math.max(0, index - 100);
  const end = Math.min(content.length, index + queryLength + 140);
  return `${start > 0 ? "…" : ""}${content.slice(start, end).replace(/\s+/g, " ")}${end < content.length ? "…" : ""}`;
}

function formatSessionRow(row: SessionRow, archive: string): string {
  const start = formatLocalDateTimeWithTZ(row.started_at);
  const end = row.ended_at ? formatLocalDateTimeWithTZ(row.ended_at) : "ongoing";
  return `[${row.id}] ${start} ~ ${end} backend=${row.backend_type ?? "unknown"} archive=${archive}`;
}

function requireChatId(value: string | undefined): string {
  if (!value) throw new Error("NIUBOT_CHAT_ID not set and --chat-id not provided");
  return value;
}

function numberFlag(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function boundedNumberFlag(value: string | undefined, fallback: number, maximum: number): number {
  return Math.max(100, Math.min(numberFlag(value, fallback), maximum));
}

function limitEventContent(event: TranscriptEvent, maxChars: number): {
  event: TranscriptEvent;
  truncated: boolean;
} {
  if (event.content.length <= maxChars) return { event, truncated: false };
  const notice = TRUNCATED_NOTICE.slice(0, maxChars);
  const contentLength = Math.max(0, maxChars - notice.length);
  return {
    event: { ...event, content: `${event.content.slice(0, contentLength)}${notice}` },
    truncated: true,
  };
}

function escapeComment(value: string): string {
  return value.replace(/--/g, "—");
}

export function markdownCodeFence(content: string): string {
  let longest = 0;
  let current = 0;
  for (const char of content) {
    if (char === "`") {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function printHelp(): void {
  console.log(`Query archived backend transcripts.

Commands:
  list                         List archived sessions
  search <query>               Search parsed transcript events
  get <session-id>             Render a complete transcript
  get <event-id>               Show one complete event returned by search

Options:
  --format jsonl               Output normalized events as JSONL
  --max-chars <count>          Limit get output (default: event 20000, session 100000; max 1000000)
  --since/--before <datetime>  List: filter archive time; search: filter event time
                               Date/local datetime uses configured timezone; ISO Z/offset is accepted
  -n, --limit <count>          Limit list or search results`);
}
