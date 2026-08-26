import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { SessionTranscript, TranscriptEvent } from "../agent/types.js";
import {
  getSessionArchiveDirectory,
} from "../session-archive/archive.js";
import {
  findSessionArchive,
  loadArchivedTranscript,
  type LocatedSessionArchive,
} from "../session-archive/reader.js";
import {
  listSessionMessages,
} from "../messages/store.js";
import { loadLiveTranscript } from "../session-archive/live-transcript.js";
import { visibleUserPayload } from "../session-archive/native-transcript.js";
import {
  getSessionForAccess,
  listSessions,
  sessionPublicId,
  listSessionsOverlappingUtcRange,
  type SessionActivityCursor,
  type SessionRow,
} from "../sessions/store.js";
import {
  formatLocalDateTimeWithTZ,
  instantIsInUtcRange,
  TZ,
  userTimeRangeToUtc,
  utcToLocalDateTime,
} from "../tz.js";
import {
  chatIsIsolatedTopic,
  historyThreadLabel,
  resolveHistoryThreadScope,
  type ResolvedHistoryThreadScope,
} from "./history-scope.js";

type ParseArgs = (args: string[]) => { positional: string[]; flags: Record<string, string> };

const DEFAULT_EVENT_MAX_CHARS = 20_000;
const DEFAULT_SESSION_MAX_CHARS = 100_000;
const MAX_OUTPUT_CHARS = 1_000_000;
const DEFAULT_TURN_PAGE_SIZE = 2;
const MAX_TURN_PAGE_SIZE = 20;
const DEFAULT_EVENT_PAGE_SIZE = 10;
const MAX_EVENT_PAGE_SIZE = 100;
const DEFAULT_EVENT_PREVIEW_CHARS = 1_200;
const MAX_EVENT_PREVIEW_CHARS = 20_000;
const MAX_PENDING_TIMELINE_ITEMS = 100;
const TRUNCATED_NOTICE = "\n\n[内容已截断；使用 --max-chars <n> 调高限制]";

export interface IdentifiedTranscriptEvent {
  eventId: string;
  messageId?: number;
  event: TranscriptEvent;
}

interface TranscriptTurn {
  number: number;
  events: IdentifiedTranscriptEvent[];
}

export interface TimelineItem extends IdentifiedTranscriptEvent {
  turnNumber: number;
  stepNumber: number;
  finalAssistant: boolean;
  pairedResult?: IdentifiedTranscriptEvent;
  pairingLimited?: boolean;
}

export interface TimelineSelection {
  items: TimelineItem[];
  hasMore: boolean;
  seenEvents: number;
  seenTurns: number;
}

interface SearchMatch {
  eventId: string;
  messageId?: number;
  sessionId: string;
  turnNumber: number;
  event: TranscriptEvent;
  snippet: string;
}

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
    await sessionList(db, args.slice(1), currentChatId, chatType, niubotHome, botName, parseArgs);
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

async function sessionList(
  db: Database.Database,
  args: string[],
  currentChatId: string | undefined,
  chatType: "p2p" | "group",
  niubotHome: string,
  botName: string,
  parseArgs: ParseArgs,
): Promise<void> {
  const { flags } = parseArgs(args);
  const targetChatId = requireChatId(flags["chat-id"] ?? currentChatId);
  const threadScope = resolveHistoryThreadScope(
    flags,
    currentChatId,
    targetChatId,
    chatType === "group" ? process.env["NIUBOT_THREAD_ID"] : undefined,
    chatIsIsolatedTopic(db, targetChatId),
  );
  const status = parseSessionListStatus(flags["status"]);
  const pageSize = boundedCountFlag(flags["limit"] ?? flags["n"], 10, 100);
  let after: SessionActivityCursor | undefined;
  if (flags["after"]) {
    const cursor = getSessionForAccess(db, flags["after"], { currentChatId, chatType });
    if (!cursor || cursor.chat_id !== targetChatId || !sessionMatchesThreadScope(cursor, threadScope)) {
      throw new Error(`Session cursor not found: ${flags["after"]}`);
    }
    after = sessionActivityCursor(cursor);
  }
  const rows = listSessions(db, {
    currentChatId,
    chatType,
    targetChatId,
    threadId: threadScope.threadId,
    allThreads: threadScope.allThreads,
    status,
    limit: pageSize + 1,
    since: flags["since"],
    before: flags["before"],
    after,
  });
  if (rows.length === 0) {
    console.log("(无 session)");
    return;
  }
  const hasMore = rows.length > pageSize;
  const page = rows.slice(0, pageSize);
  console.log(`Timezone: ${TZ}`);
  if (threadScope.threadId && !threadScope.allThreads) {
    console.log(`当前话题：${threadScope.threadId}`);
  }
  let currentDate: string | undefined;
  for (const row of page) {
    const archive = locate(niubotHome, botName, row);
    const time = sessionListTime(row);
    if (time.date !== currentDate) {
      if (currentDate !== undefined) console.log("");
      console.log(time.date);
      currentDate = time.date;
    }
    const transcript = loadNativeTranscript(niubotHome, botName, row);
    const overview = transcript
      ? await sessionOverviewFromTranscript(row.id, transcript.events)
      : { preview: "概要: 无原生记录", turns: 0 };
    console.log(formatSessionListRow(row, !archive, time.range, threadScope.allThreads && chatType === "group", overview.turns));
    console.log(`  ${overview.preview}`);
  }
  console.log(`\n本页 ${page.length} 条${hasMore ? "，还有更多" : "，已到最后一页"}`);
  if (hasMore) {
    const last = page.at(-1)!;
    console.log(`下一页：${listContinuationCommand(last.id, pageSize, flags)}`);
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
  const threadScope = resolveHistoryThreadScope(
    flags,
    currentChatId,
    targetChatId,
    chatType === "group" ? process.env["NIUBOT_THREAD_ID"] : undefined,
    chatIsIsolatedTopic(db, targetChatId),
  );
  const pageSize = boundedCountFlag(flags["limit"] ?? flags["n"], 10, 100);
  const messagesOnly = flags["messages-only"] === "true";
  const includeTools = flags["include-tools"] === "true";
  const sessionScanLimit = boundedCountFlag(flags["sessions"], 500, 10_000);
  const eventRange = userTimeRangeToUtc({ since: flags["since"], before: flags["before"] });
  let requestedThrough: SessionActivityCursor | undefined;
  let throughRow: SessionRow | undefined;
  const untilSession = flags["until-session"] ?? flags["through-session"];
  if (untilSession) {
    const anchor = getSessionForAccess(db, untilSession, { currentChatId, chatType });
    if (!anchor || anchor.chat_id !== targetChatId || !sessionMatchesThreadScope(anchor, threadScope)) {
      throw new Error(`Search anchor session not found: ${untilSession}`);
    }
    if (anchor.status === "active") {
      throw new Error("--until-session cannot target an active session; last_active_at still moves");
    }
    requestedThrough = sessionActivityCursor(anchor);
    throughRow = anchor;
  }
  const candidateRows = listSessionsOverlappingUtcRange(db, {
    currentChatId,
    chatType,
    targetChatId,
    threadId: threadScope.threadId,
    allThreads: threadScope.allThreads,
    status: "all",
    limit: sessionScanLimit + 1,
    sinceUtc: eventRange.since,
    beforeUtc: eventRange.before,
    through: requestedThrough,
  });
  const through = requestedThrough ?? (
    !untilSession
      && candidateRows[0]?.status === "archived"
      ? sessionActivityCursor(candidateRows[0])
      : undefined
  );
  if (!throughRow && through && candidateRows[0]?.id === through.id) {
    throughRow = candidateRows[0];
  }
  const throughSessionId = throughRow ? sessionPublicId(throughRow) : undefined;
  const candidateSessionsTruncated = candidateRows.length > sessionScanLimit;
  const rows = candidateRows.slice(0, sessionScanLimit);
  const needle = query.toLocaleLowerCase();
  const page: SearchMatch[] = [];
  let cursorFound = flags["after"] === undefined;
  let hasMore = false;
  scan: for (const row of rows) {
    try {
      const transcript = loadNativeTranscript(niubotHome, botName, row);
      if (!transcript) continue;
      const messageIds = sessionMessageIds(db, row.id);
      for await (const item of visibleTimelineEvents(row.id, transcript.events, messageIds)) {
        if (!cursorFound) {
          if (item.eventId === flags["after"]) cursorFound = true;
          continue;
        }
        if (!includeTools
          && (item.event.type === "tool_call" || item.event.type === "tool_result")) {
          continue;
        }
        if (messagesOnly && item.event.type !== "user" && !item.finalAssistant) continue;
        if (!instantIsInUtcRange(item.event.timestamp, eventRange)) continue;
        const index = item.event.content.toLocaleLowerCase().indexOf(needle);
        if (index < 0) continue;
        if (page.length >= pageSize) {
          hasMore = true;
          break scan;
        }
        page.push({
          eventId: item.eventId,
          messageId: item.messageId,
          sessionId: sessionPublicId(row),
          turnNumber: item.turnNumber,
          event: { ...item.event, content: "" },
          snippet: snippet(item.event.content, index, query.length),
        });
      }
    } catch (err) {
      console.error(`Warning: cannot read session ${sessionPublicId(row)}: ${(err as Error).message}`);
    }
  }
  if (!cursorFound) throw new Error(`Search cursor not found: ${flags["after"]}`);
  if (page.length === 0) {
    console.log(flags["after"] ? "(没有更多匹配结果)" : "(无匹配 transcript 事件)");
    if (candidateSessionsTruncated) {
      console.log(`注意：只扫描了最近 ${sessionScanLimit} 个 session；使用 --sessions <数量> 调高范围`);
    }
    return;
  }
  for (const match of page) {
    console.log(`[event ${match.eventId}]${match.messageId ? ` [message #${match.messageId}]` : ""} [session ${match.sessionId}] [turn ${match.turnNumber}] ${eventLabel(match.event)}`);
    console.log(match.snippet);
    console.log("---");
  }
  console.log(`本页 ${page.length} 条${hasMore ? "，还有更多" : "，当前扫描范围已到最后一页"}`);
  if (candidateSessionsTruncated) {
    console.log(`注意：只扫描了最近 ${sessionScanLimit} 个 session；使用 --sessions <数量> 调高范围`);
  }
  if (hasMore) {
    console.log(`下一页：${searchContinuationCommand(
      query,
      page.at(-1)!.eventId,
      pageSize,
      throughSessionId,
      flags,
    )}`);
  }
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
  let row = getSessionForAccess(db, sessionId, { currentChatId, chatType });
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  if (flags["thread-id"] && !flags["all-threads"] && row.thread_id !== flags["thread-id"]) {
    throw new Error(`Session not found in thread ${flags["thread-id"]}: ${sessionId}`);
  }
  const archive = locate(niubotHome, botName, row);
  const transcript = loadNativeTranscript(niubotHome, botName, row);
  if (!transcript) {
    throw new Error(`Session transcript not available: ${sessionPublicId(row)}`);
  }

  if (flags["format"] === "jsonl"
    && (flags["turn"] || flags["after-turn"] || flags["after-event"]
      || flags["verbose"] === "true" || flags["summary"] === "true")) {
    throw new Error("turn and event pagination flags cannot be combined with --format jsonl");
  }
  if (requestedEventId || flags["format"] === "jsonl") {
    await printEventStream(row.id, transcript.events, requestedEventId, flags["format"], maxChars);
    return;
  }
  const sourceLabel = archive ? undefined : "live";
  const targetTurn = optionalPositiveIntegerFlag(flags["turn"], "--turn");
  const summary = flags["summary"] === "true";
  if (summary) {
    if (flags["after-event"]) throw new Error("--after-event cannot be combined with --summary");
    if (flags["verbose"] === "true") throw new Error("--verbose cannot be combined with --summary");
    await printSessionSummary(row, transcript.events, botName, targetTurn, flags, maxChars, sourceLabel);
    return;
  }
  if (flags["after-turn"]) throw new Error("--after-turn requires --summary");
  const pageSize = boundedCountFlag(
    flags["page-size"] ?? flags["event-page-size"],
    DEFAULT_EVENT_PAGE_SIZE,
    MAX_EVENT_PAGE_SIZE,
  );
  const verbose = flags["verbose"] === "true";
  const eventChars = boundedPreviewFlag(
    flags["event-chars"],
    verbose ? DEFAULT_EVENT_MAX_CHARS : DEFAULT_EVENT_PREVIEW_CHARS,
    MAX_EVENT_PREVIEW_CHARS,
  );
  const selection = await selectTimelineEvents(row.id, transcript.events, {
    targetTurn,
    afterEventId: flags["after-event"],
    pageSize,
  });
  printTimeline(row, selection, {
    targetTurn,
    pageSize,
    eventChars,
    maxChars,
    verbose,
    flags,
    sourceLabel,
  });
}

async function printSessionSummary(
  row: SessionRow,
  events: SessionTranscript["events"],
  botName: string,
  targetTurn: number | undefined,
  flags: Record<string, string>,
  maxChars: number,
  sourceLabel?: string,
): Promise<void> {
  const afterTurn = optionalNonNegativeIntegerFlag(flags["after-turn"], "--after-turn") ?? 0;
  if (targetTurn && flags["after-turn"]) throw new Error("--turn cannot be combined with --after-turn");
  const pageSize = targetTurn
    ? 1
    : boundedCountFlag(flags["page-size"], DEFAULT_TURN_PAGE_SIZE, MAX_TURN_PAGE_SIZE);
  const selection = await selectTranscriptTurns(row.id, events, { targetTurn, afterTurn, pageSize });
  if (targetTurn && selection.turns.length === 0) throw new Error(`Turn not found: ${targetTurn}`);
  printTurnSessionHeader(row, selection.turns, selection.totalTurns, sourceLabel);
  if (selection.turns.length === 0) {
    console.log("(没有更多 turn)");
    return;
  }
  let remainingChars = maxChars;
  let lastCompleteTurn: TranscriptTurn | undefined;
  let pageTruncated = false;
  let currentDate: string | undefined;
  for (const turn of selection.turns) {
    const timestamp = compactEventTimestamp(turn.events[0]?.event.timestamp);
    const showDate = timestamp.date !== currentDate;
    currentDate = timestamp.date;
    const result = printTurn(botName, sessionPublicId(row), turn, remainingChars, {
      date: showDate ? timestamp.date : undefined,
      time: timestamp.time,
    });
    remainingChars = result.remainingChars;
    if (result.truncated) {
      pageTruncated = true;
      break;
    }
    lastCompleteTurn = turn;
    if (turn !== selection.turns.at(-1)) console.log("---\n");
  }
  if (pageTruncated) {
    printTurnRetryCommand(sessionPublicId(row), targetTurn, lastCompleteTurn?.number ?? afterTurn, pageSize, maxChars);
  } else if (!targetTurn && lastCompleteTurn && lastCompleteTurn.number < selection.totalTurns) {
    console.log(`下一页：/nbt sessions get ${sessionPublicId(row)} --summary --after-turn ${lastCompleteTurn.number} --page-size ${pageSize}`);
  }
}

function locate(niubotHome: string, botName: string, row: SessionRow): LocatedSessionArchive | undefined {
  return findSessionArchive(getSessionArchiveDirectory(niubotHome, botName, row.chat_id), row.id);
}

function transcriptFor(archive: LocatedSessionArchive): SessionTranscript {
  const transcript = loadArchivedTranscript(archive.path).transcript;
  return { ...transcript, events: inferToolResultNames(transcript.events) };
}

function loadNativeTranscript(
  niubotHome: string,
  botName: string,
  row: SessionRow,
): SessionTranscript | undefined {
  const archive = locate(niubotHome, botName, row);
  if (archive) return transcriptFor(archive);
  return loadLiveTranscript({
    backend: row.backend_type,
    agentSessionId: row.agent_session_id,
    cwd: process.env["NIUBOT_WORK_DIR"]?.trim() || process.cwd(),
  });
}

async function* inferToolResultNames(
  events: SessionTranscript["events"],
): AsyncGenerator<TranscriptEvent> {
  const names = new Map<string, string>();
  for await (const event of events) {
    if (event.type === "tool_call" && event.callId && event.name) names.set(event.callId, event.name);
    if (event.type === "tool_result" && !event.name && event.callId) {
      yield { ...event, name: names.get(event.callId) };
      names.delete(event.callId);
    } else {
      yield event;
      if (event.type === "tool_result" && event.callId) names.delete(event.callId);
    }
  }
}

async function printEventStream(
  sessionId: string,
  events: SessionTranscript["events"],
  requestedEventId: string | undefined,
  format: string | undefined,
  maxChars: number,
): Promise<void> {
  const seen = new Map<string, number>();
  let remainingChars = maxChars;
  for await (const event of events) {
    const eventId = makeEventId(sessionId, event, seen);
    if (requestedEventId && eventId !== requestedEventId) continue;
    const displayed = format === "jsonl" ? event : displayedTranscriptEvent(event);
    if (!displayed) {
      if (requestedEventId) {
        printEvent(eventId, { ...event, content: "（引擎注入，已过滤）" });
        return;
      }
      continue;
    }
    const { event: outputEvent, truncated } = limitEventContent(displayed, remainingChars);
    if (format === "jsonl") {
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

async function* timelineEvents(
  sessionId: string,
  events: SessionTranscript["events"],
  messageIds?: Map<string, number[]>,
): AsyncGenerator<TimelineItem> {
  const seen = new Map<string, number>();
  let turnNumber = 0;
  let stepNumber = 0;
  let currentHasOnlyUsers = false;
  let lastUserTimestamp: string | undefined;
  let pendingAssistants: TimelineItem[] = [];

  for await (const event of events) {
    const eventId = makeEventId(sessionId, event, seen);
    if (event.type === "user") {
      const isSameUserMessage = turnNumber > 0
        && currentHasOnlyUsers
        && lastUserTimestamp === event.timestamp;
      if (!isSameUserMessage) turnNumber++;
      currentHasOnlyUsers = true;
      lastUserTimestamp = event.timestamp;
    } else if (turnNumber > 0) {
      currentHasOnlyUsers = false;
    }
    if (turnNumber === 0) continue;

    const item: TimelineItem = {
      eventId,
      messageId: messageIds ? takeMessageId(messageIds, event) : undefined,
      event,
      turnNumber,
      stepNumber: ++stepNumber,
      finalAssistant: false,
    };

    if (event.type === "assistant") {
      const pendingTimestamp = pendingAssistants[0]?.event.timestamp;
      const sameNativeMessage = pendingAssistants.length > 0
        && pendingTimestamp !== undefined
        && pendingTimestamp === event.timestamp;
      if (!sameNativeMessage) {
        for (const pending of pendingAssistants) yield pending;
        pendingAssistants = [];
      }
      pendingAssistants.push(item);
      continue;
    }

    if (pendingAssistants.length > 0) {
      const previousTurn = pendingAssistants[0]!.turnNumber;
      const finalAssistant = event.type === "user" && turnNumber > previousTurn;
      for (const pending of pendingAssistants) yield { ...pending, finalAssistant };
      pendingAssistants = [];
    }
    yield item;
  }

  for (const pending of pendingAssistants) yield { ...pending, finalAssistant: true };
}

async function* transcriptTurns(
  sessionId: string,
  events: SessionTranscript["events"],
  messageIds?: Map<string, number[]>,
): AsyncGenerator<TranscriptTurn> {
  let current: TranscriptTurn | undefined;
  for await (const timelineItem of timelineEvents(sessionId, events, messageIds)) {
    const { eventId, messageId, event, turnNumber } = timelineItem;
    const item: IdentifiedTranscriptEvent = {
      eventId,
      messageId,
      event,
    };
    if (!current || current.number !== turnNumber) {
      if (current) yield current;
      current = { number: turnNumber, events: [] };
    }
    current.events.push(item);
  }
  if (current) yield current;
}

async function* visibleTimelineEvents(
  sessionId: string,
  events: SessionTranscript["events"],
  messageIds?: Map<string, number[]>,
): AsyncGenerator<TimelineItem> {
  let turnNumber = 0;
  let yieldedUser = false;
  for await (const item of timelineEvents(sessionId, events, messageIds)) {
    if (item.turnNumber !== turnNumber) {
      turnNumber = item.turnNumber;
      yieldedUser = false;
    }
    if (item.event.type === "user") {
      const content = conversationUserContent(item.event.content);
      if (!content) continue;
      yieldedUser = true;
      yield { ...item, event: { ...item.event, content } };
      continue;
    }
    if (!yieldedUser) continue;
    yield item;
  }
}

function displayedTranscriptEvent(event: TranscriptEvent): TranscriptEvent | undefined {
  if (event.type !== "user") return event;
  const content = conversationUserContent(event.content);
  if (!content) return undefined;
  return { ...event, content };
}

function turnHasVisibleUser(turn: TranscriptTurn): boolean {
  return turn.events.some((item) => item.event.type === "user" && conversationUserContent(item.event.content));
}

async function* timelineSteps(
  sessionId: string,
  events: SessionTranscript["events"],
): AsyncGenerator<TimelineItem> {
  yield* pairTimelineSteps(visibleTimelineEvents(sessionId, events));
}

async function* pairTimelineSteps(
  items: AsyncIterable<TimelineItem>,
): AsyncGenerator<TimelineItem> {
  let stepNumber = 0;
  let buffered: Array<{ item: TimelineItem; waitingForResult: boolean }> = [];

  const numbered = (item: TimelineItem): TimelineItem => ({ ...item, stepNumber: ++stepNumber });
  const drainReady = (): TimelineItem[] => {
    const ready: TimelineItem[] = [];
    while (buffered.length > 0 && !buffered[0]!.waitingForResult) {
      ready.push(buffered.shift()!.item);
    }
    return ready;
  };
  const flushAll = (pairingLimited: boolean): TimelineItem[] => {
    const flushed = buffered.map(({ item, waitingForResult }) => (
      pairingLimited && waitingForResult ? { ...item, pairingLimited: true } : item
    ));
    buffered = [];
    return flushed;
  };

  for await (const item of items) {
    const boundary = item.event.type === "user"
      || (item.event.type === "assistant" && item.finalAssistant);
    if (boundary) {
      for (const pending of flushAll(false)) yield numbered(pending);
      yield numbered(item);
      continue;
    }

    if (item.event.type === "tool_call" && item.event.callId) {
      buffered.push({ item, waitingForResult: true });
    } else if (item.event.type === "tool_result" && item.event.callId) {
      const call = buffered.find((candidate) => (
        candidate.waitingForResult
        && candidate.item.event.type === "tool_call"
        && candidate.item.event.callId === item.event.callId
      ));
      if (call) {
        call.waitingForResult = false;
        call.item = {
          ...call.item,
          pairedResult: {
            eventId: item.eventId,
            messageId: item.messageId,
            event: item.event,
          },
        };
      } else {
        buffered.push({ item, waitingForResult: false });
      }
    } else {
      buffered.push({ item, waitingForResult: false });
    }

    for (const ready of drainReady()) yield numbered(ready);
    while (buffered.length > MAX_PENDING_TIMELINE_ITEMS) {
      const oldest = buffered.shift()!;
      yield numbered(oldest.waitingForResult
        ? { ...oldest.item, pairingLimited: true }
        : oldest.item);
      for (const ready of drainReady()) yield numbered(ready);
    }
  }
  for (const pending of flushAll(false)) yield numbered(pending);
}

async function selectTranscriptTurns(
  sessionId: string,
  events: SessionTranscript["events"],
  options: { targetTurn?: number; afterTurn: number; pageSize: number },
): Promise<{ turns: TranscriptTurn[]; totalTurns: number }> {
  const turns: TranscriptTurn[] = [];
  let totalTurns = 0;
  for await (const turn of transcriptTurns(sessionId, events)) {
    totalTurns = turn.number;
    if (!options.targetTurn && !turnHasVisibleUser(turn)) continue;
    if (options.targetTurn) {
      if (turn.number === options.targetTurn) turns.push(turn);
    } else if (turn.number > options.afterTurn && turns.length < options.pageSize) {
      turns.push(turn);
    }
  }
  return { turns, totalTurns };
}

export async function selectTimelineEvents(
  sessionId: string,
  events: SessionTranscript["events"],
  options: { targetTurn?: number; afterEventId?: string; pageSize: number },
): Promise<TimelineSelection> {
  const items: TimelineItem[] = [];
  let seenEvents = 0;
  let seenTurns = 0;
  let targetTurnFound = options.targetTurn === undefined;
  let cursorFound = options.afterEventId === undefined;
  let hasMore = false;
  for await (const item of timelineSteps(sessionId, events)) {
    seenTurns = Math.max(seenTurns, item.turnNumber);
    if (options.targetTurn && item.turnNumber > options.targetTurn) break;
    if (options.targetTurn && item.turnNumber !== options.targetTurn) continue;
    targetTurnFound = true;
    seenEvents++;
    if (!cursorFound) {
      if (item.eventId === options.afterEventId || item.pairedResult?.eventId === options.afterEventId) {
        cursorFound = true;
      }
      continue;
    }
    if (items.length >= options.pageSize) {
      hasMore = true;
      break;
    }
    items.push(item);
  }
  if (!targetTurnFound) throw new Error(`Turn not found: ${options.targetTurn}`);
  if (!cursorFound) {
    const scope = options.targetTurn ? ` in turn ${options.targetTurn}` : "";
    throw new Error(`Event cursor not found${scope}: ${options.afterEventId}`);
  }
  return { items, hasMore, seenEvents, seenTurns };
}

function printTimeline(
  row: SessionRow,
  selection: TimelineSelection,
  options: {
    targetTurn?: number;
    pageSize: number;
    eventChars: number;
    maxChars: number;
    verbose: boolean;
    flags: Record<string, string>;
    sourceLabel?: string;
  },
): void {
  console.log(`Timezone: ${TZ}`);
  console.log(sessionHeader(row, options.sourceLabel));
  if (selection.items.length > 0) {
    const first = selection.items[0]!.stepNumber;
    const last = selection.items.at(-1)!.stepNumber;
    const scope = options.targetTurn ? ` · 第 ${options.targetTurn} 轮` : "";
    console.log(`步骤 ${first}～${last}${scope}`);
  } else {
    const scope = options.targetTurn ? `第 ${options.targetTurn} 轮` : "整个 Session";
    console.log(scope);
    console.log(selection.seenEvents === 0 && !options.flags["after-event"]
      ? "(没有执行步骤)"
      : "(没有更多执行步骤)");
    return;
  }

  let remainingChars = options.maxChars;
  let currentTurn: number | undefined;
  let currentDate: string | undefined;
  let lastPrinted: TimelineItem | undefined;
  let printed = 0;
  for (const item of selection.items) {
    if (lastPrinted && remainingChars < 100) break;
    const localTimestamp = compactEventTimestamp(item.event.timestamp);
    if (item.turnNumber !== currentTurn || localTimestamp.date !== currentDate) {
      if (currentTurn !== undefined) console.log("");
      const dateChanged = localTimestamp.date !== currentDate;
      currentTurn = item.turnNumber;
      currentDate = localTimestamp.date;
      console.log(dateChanged
        ? `${localTimestamp.date} · 第 ${currentTurn} 轮`
        : `第 ${currentTurn} 轮`);
    }
    const preview = timelinePreview(item.event.content, Math.min(options.eventChars, remainingChars));
    const header = `[${item.stepNumber}] [${localTimestamp.time}] ${compactTimelineEventLabel(item)}:`;
    const inline = (item.event.type === "user" || item.event.type === "assistant")
      && !preview.truncated
      && !preview.content.includes("\n");
    console.log(inline ? `${header} ${preview.content}` : header);
    if (options.verbose) {
      const resultEvent = item.pairedResult ? ` result_event=${item.pairedResult.eventId}` : "";
      console.log(`    event=${item.eventId}${resultEvent}${item.event.callId ? ` call=${item.event.callId}` : ""}`);
    }
    if (item.event.type === "tool_call") {
      console.log("调用：");
      const fence = markdownCodeFence(preview.content);
      console.log(`${fence}text\n${preview.content}\n${fence}`);
      if (preview.truncated) console.log(`〔内容已截断：/nbt sessions get ${item.eventId}〕`);
      remainingChars -= preview.content.length;
      if (item.pairedResult) {
        const resultPreview = timelinePreview(
          item.pairedResult.event.content,
          Math.min(options.eventChars, Math.max(0, remainingChars)),
        );
        console.log("结果：");
        const resultFence = markdownCodeFence(resultPreview.content);
        console.log(`${resultFence}text\n${resultPreview.content}\n${resultFence}`);
        if (resultPreview.truncated) {
          console.log(`〔内容已截断：/nbt sessions get ${item.pairedResult.eventId}〕`);
        }
        remainingChars -= resultPreview.content.length;
      } else {
        console.log(item.pairingLimited
          ? "结果：未在当前配对窗口内找到"
          : "结果：未返回");
      }
    } else if (item.event.type === "tool_result") {
      const fence = markdownCodeFence(preview.content);
      console.log(`${fence}text\n${preview.content}\n${fence}`);
      if (preview.truncated) console.log(`〔内容已截断：/nbt sessions get ${item.eventId}〕`);
      remainingChars -= preview.content.length;
    } else if (!inline) {
      console.log(preview.content);
      if (preview.truncated) console.log(`〔内容已截断：/nbt sessions get ${item.eventId}〕`);
      remainingChars -= preview.content.length;
    } else {
      remainingChars -= preview.content.length;
    }
    lastPrinted = item;
    printed++;
  }

  const hasUnprintedSelectedItems = printed < selection.items.length;
  const hasMore = !!lastPrinted && (selection.hasMore || hasUnprintedSelectedItems);
  console.log(`本页显示 ${printed} 步${hasMore ? "，还有更多" : "，已到最后一步"}`);
  if (hasMore && lastPrinted) {
    console.log(`下一页：${timelineContinuationCommand(
      sessionPublicId(row),
      lastPrinted.pairedResult?.eventId ?? lastPrinted.eventId,
      options,
    )}`);
  }
}

function compactTimelineEventLabel(item: TimelineItem): string {
  const name = item.event.name;
  switch (item.event.type) {
    case "user": return "用户";
    case "assistant": return item.finalAssistant ? "最终回复" : "过程消息";
    case "tool_call": return name ?? "工具";
    case "tool_result": return name ? `${name} 结果（未找到对应调用）` : "工具结果（未找到对应调用）";
  }
}

function compactSessionTimeRange(row: SessionRow): string {
  const start = utcToLocalDateTime(row.started_at);
  if (!row.ended_at) return `${start}～进行中`;
  const end = utcToLocalDateTime(row.ended_at);
  const [startDate = "", startTime = ""] = start.split(" ");
  const [endDate = "", endTime = ""] = end.split(" ");
  return startDate === endDate
    ? `${startDate} ${startTime}～${endTime}`
    : `${start}～${end}`;
}

function compactEventTimestamp(timestamp: string | undefined): { date: string; time: string } {
  if (!timestamp) return { date: "日期未知", time: "时间未知" };
  const [date = "日期未知", time = "时间未知"] = utcToLocalDateTime(timestamp).split(" ");
  return { date, time };
}

function timelinePreview(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) return { content, truncated: false };
  const notice = "\n\n[…本步骤内容较长，已显示开头…]";
  if (maxChars <= notice.length) {
    return { content: content.slice(0, Math.max(0, maxChars)), truncated: true };
  }
  return {
    content: content.slice(0, Math.max(0, maxChars - notice.length)) + notice,
    truncated: true,
  };
}

function assistantSections(turn: TranscriptTurn): {
  processMessages: IdentifiedTranscriptEvent[];
  finalMessages: IdentifiedTranscriptEvent[];
} {
  const assistants = turn.events.filter((item) => item.event.type === "assistant");
  const last = turn.events.at(-1);
  if (!last || last.event.type !== "assistant") {
    return { processMessages: assistants, finalMessages: [] };
  }
  let finalStart = turn.events.length - 1;
  if (last.event.timestamp) {
    while (finalStart > 0) {
      const previous = turn.events[finalStart - 1]!;
      if (previous.event.type !== "assistant" || previous.event.timestamp !== last.event.timestamp) break;
      finalStart--;
    }
  }
  const finalMessages = turn.events.slice(finalStart);
  const finalIds = new Set(finalMessages.map((item) => item.eventId));
  return {
    processMessages: assistants.filter((item) => !finalIds.has(item.eventId)),
    finalMessages,
  };
}

function printTurnSessionHeader(
  row: SessionRow,
  turns: TranscriptTurn[],
  totalTurns: number,
  sourceLabel?: string,
): void {
  console.log(`Timezone: ${TZ}`);
  console.log(sessionHeader(row, sourceLabel));
  if (turns.length > 0) {
    console.log(`范围：第 ${turns[0]!.number}～${turns.at(-1)!.number} 轮，共 ${totalTurns} 轮\n`);
  } else {
    console.log(`共 ${totalTurns} 轮\n`);
  }
}

function printTurn(
  botName: string,
  sessionId: string,
  turn: TranscriptTurn,
  maxChars: number,
  timestamp: { date?: string; time: string },
): { remainingChars: number; truncated: boolean } {
  const date = timestamp.date ? `${timestamp.date} · ` : "";
  console.log(`## ${date}第 ${turn.number} 轮 · ${timestamp.time}\n`);

  const users = turn.events.filter((item) => item.event.type === "user");
  const { processMessages, finalMessages } = assistantSections(turn);
  const toolCalls = turn.events.filter((item) => item.event.type === "tool_call");
  const toolResults = turn.events.filter((item) => item.event.type === "tool_result");
  let remainingChars = maxChars;

  console.log("用户：");
  const userText = users
    .map((item) => conversationUserContent(item.event.content))
    .filter((content): content is string => Boolean(content))
    .join("\n\n") || (users.length > 0 ? "（引擎注入，已过滤）" : "（无用户消息）");
  const userResult = printLimitedText(userText, remainingChars);
  remainingChars = userResult.remainingChars;
  if (userResult.truncated) return { remainingChars, truncated: true };

  if (processMessages.length > 0 || toolCalls.length > 0 || toolResults.length > 0) {
    console.log("\n过程：");
    if (processMessages.length > 0) console.log(`- 过程消息 ${processMessages.length} 条，已折叠`);
    if (toolCalls.length > 0) console.log(`- 工具调用 ${toolCalls.length} 次：${toolCallSummary(toolCalls)}`);
    if (toolResults.length > 0) console.log(`- 工具结果 ${toolResults.length} 条，已折叠`);
  }

  console.log(`\n${botName}：`);
  const finalResult = printLimitedText(
    finalMessages.map((item) => item.event.content).join("\n\n") || "（本轮没有最终回复）",
    remainingChars,
  );
  remainingChars = finalResult.remainingChars;
  if (processMessages.length > 0 || toolCalls.length > 0 || toolResults.length > 0) {
    console.log(`\n查看本轮详情：/nbt sessions get ${sessionId} --turn ${turn.number} --verbose`);
  }
  return { remainingChars, truncated: finalResult.truncated };
}

function printLimitedText(content: string, maxChars: number): { remainingChars: number; truncated: boolean } {
  const result = limitEventContent({ type: "assistant", content }, maxChars);
  console.log(result.event.content);
  return { remainingChars: maxChars - result.event.content.length, truncated: result.truncated };
}

function toolCallSummary(items: IdentifiedTranscriptEvent[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = item.event.name ?? "unknown";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => `${name} ×${count}`).join("、");
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
  const identity = {
    type: event.type,
    timestamp: event.timestamp ?? null,
    callId: event.callId ?? null,
    name: event.callId ? null : (event.name ?? null),
  };
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 12);
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

function listContinuationCommand(
  after: string,
  pageSize: number,
  flags: Record<string, string>,
): string {
  const parts = ["/nbt sessions list", `--after ${quoteArg(after)}`, `-n ${pageSize}`];
  appendSessionScopeFlags(parts, flags);
  appendPreservedFlag(parts, flags, "since");
  appendPreservedFlag(parts, flags, "before");
  appendPreservedFlag(parts, flags, "chat-id");
  appendPreservedFlag(parts, flags, "status");
  return parts.join(" ");
}

function searchContinuationCommand(
  query: string,
  after: string,
  pageSize: number,
  throughSessionId: string | undefined,
  flags: Record<string, string>,
): string {
  const parts = [
    "/nbt sessions search",
    quoteArg(query),
    `--after ${quoteArg(after)}`,
    `-n ${pageSize}`,
  ];
  appendPreservedFlag(parts, flags, "since");
  appendPreservedFlag(parts, flags, "before");
  appendPreservedFlag(parts, flags, "chat-id");
  appendPreservedFlag(parts, flags, "sessions");
  appendSessionScopeFlags(parts, flags);
  if (throughSessionId) parts.push(`--until-session ${quoteArg(throughSessionId)}`);
  if (flags["messages-only"] === "true") parts.push("--messages-only");
  if (flags["include-tools"] === "true") parts.push("--include-tools");
  return parts.join(" ");
}

function appendSessionScopeFlags(parts: string[], flags: Record<string, string>): void {
  if (flags["all-threads"] === "true") {
    parts.push("--all-threads");
  } else {
    appendPreservedFlag(parts, flags, "thread-id");
  }
}

function timelineContinuationCommand(
  sessionId: string,
  afterEventId: string,
  options: {
    targetTurn?: number;
    pageSize: number;
    eventChars: number;
    verbose: boolean;
    flags: Record<string, string>;
  },
): string {
  const parts = [
    "/nbt sessions get",
    quoteArg(sessionId),
    `--after-event ${quoteArg(afterEventId)}`,
    `--page-size ${options.pageSize}`,
  ];
  if (options.targetTurn) parts.push(`--turn ${options.targetTurn}`);
  if (options.verbose) parts.push("--verbose");
  if (options.flags["event-chars"]) parts.push(`--event-chars ${options.eventChars}`);
  appendPreservedFlag(parts, options.flags, "max-chars");
  return parts.join(" ");
}

function printTurnRetryCommand(
  sessionId: string,
  targetTurn: number | undefined,
  afterTurn: number,
  pageSize: number,
  maxChars: number,
): void {
  if (maxChars >= MAX_OUTPUT_CHARS) {
    console.log("当前页内容已截断且达到输出上限；请用 --turn <number> --verbose 按事件查看");
    return;
  }
  const nextMaxChars = Math.min(MAX_OUTPUT_CHARS, maxChars * 2);
  const selection = targetTurn
    ? `--turn ${targetTurn}`
    : `--after-turn ${afterTurn} --page-size ${pageSize}`;
  console.log(`当前页内容已截断，分页游标未推进`);
  console.log(`调高限制后重试：/nbt sessions get ${sessionId} --summary ${selection} --max-chars ${nextMaxChars}`);
}

function appendPreservedFlag(parts: string[], flags: Record<string, string>, name: string): void {
  if (flags[name]) parts.push(`--${name} ${quoteArg(flags[name])}`);
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9_.:@/+\-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

function sessionListTime(row: SessionRow): { date: string; range: string } {
  const [startDate = "日期未知", startTime = "时间未知"] = utcToLocalDateTime(row.started_at).split(" ");
  if (!row.ended_at) return { date: startDate, range: `${startTime}～进行中` };
  const [endDate = "日期未知", endTime = "时间未知"] = utcToLocalDateTime(row.ended_at).split(" ");
  return {
    date: endDate,
    range: startDate === endDate
      ? (startTime === endTime ? startTime : `${startTime}～${endTime}`)
      : `${startDate} ${startTime}～${endTime}`,
  };
}

function formatSessionListRow(
  row: SessionRow,
  archiveMissing: boolean,
  timeRange: string,
  showThread: boolean,
  turnCount: number,
): string {
  const metadata = [
    sessionSourceLabel(row.source),
    row.backend_type ?? "unknown",
    `${turnCount}轮`,
  ].join(" · ");
  const thread = showThread ? ` · ${historyThreadLabel(row.thread_id)}` : "";
  return `[${row.id}] [${timeRange}] ${metadata}${thread} · ${sessionStatusLabel(row, archiveMissing)}`;
}

function sessionStatusLabel(row: SessionRow, archiveMissing: boolean): string {
  switch (row.status) {
    case "active": return "进行中";
    case "archive_failed": return "归档失败";
    case "discarded": return "未启动";
    case "archived": return archiveMissing ? "归档缺失" : "已归档";
    default: return row.status || "未知状态";
  }
}

function sessionBackendLabel(row: SessionRow, sourceLabel?: string): string {
  return `${row.backend_type ?? "unknown"}${sourceLabel ? `+${sourceLabel}` : ""}`;
}

function sessionHeader(row: SessionRow, sourceLabel?: string): string {
  const scope = row.thread_id ? `${historyThreadLabel(row.thread_id)} · ` : "";
  return `Session ${sessionPublicId(row)} · ${sessionBackendLabel(row, sourceLabel)} · ${scope}${compactSessionTimeRange(row)}`;
}

function sessionSourceLabel(source: string): string {
  switch (source) {
    case "user": return "对话";
    case "cron": return "定时任务";
    case "task": return "后台任务";
    default: return source || "未知来源";
  }
}

async function sessionOverviewFromTranscript(
  sessionId: string,
  events: SessionTranscript["events"],
  maxRunes = 180,
): Promise<{ preview: string; turns: number }> {
  const exchanges: Array<{ user: string; response?: string }> = [];
  let turns = 0;
  for await (const turn of transcriptTurns(sessionId, events)) {
    turns = turn.number;
    const user = conversationUserContent(
      turn.events.filter((item) => item.event.type === "user").map((item) => item.event.content).join("\n"),
    );
    if (!user) continue;
    const { finalMessages } = assistantSections(turn);
    const response = (finalMessages.length > 0
      ? finalMessages
      : turn.events.filter((item) => item.event.type === "assistant")).map((item) => item.event.content).join("\n").trim()
      || undefined;
    exchanges.push({ user, response });
  }
  const first = exchanges[0];
  const last = exchanges.at(-1);
  if (!first || !last) {
    return { preview: "概要: 无对话", turns };
  }
  const overview = exchanges.length === 1
    ? `概要: 问「${exchangeText(first.user, 28, "未记录")}」→答「${exchangeText(first.response, 42, "未回复")}」`
    : `概要: 首问「${exchangeText(first.user, 28, "未记录")}」→首答「${exchangeText(first.response, 42, "未回复")}」；末问「${exchangeText(last.user, 28, "未记录")}」→末答「${exchangeText(last.response, 42, "未回复")}」`;
  return { preview: truncateRunes(overview, maxRunes), turns };
}

function conversationUserContent(content: string): string | undefined {
  const visible = visibleUserPayload(content);
  if (!visible || isNonConversationUtterance(visible)) return undefined;
  return visible;
}

function isNonConversationUtterance(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/^\/[a-z][a-z0-9_-]*(?:\s|$)/i.test(trimmed)) return true;
  if (trimmed.startsWith("【重启完成】")) return true;
  return false;
}

function exchangeText(content: string | undefined, maxRunes: number, fallback: string): string {
  const flattened = content?.replace(/\s+/g, " ").trim() || fallback;
  return truncateRunes(flattened, maxRunes);
}

function truncateRunes(content: string, maxRunes: number): string {
  const runes = [...content];
  if (runes.length <= maxRunes) return content;
  if (maxRunes <= 1) return "…".slice(0, maxRunes);
  return `${runes.slice(0, maxRunes - 1).join("")}…`;
}

function requireChatId(value: string | undefined): string {
  if (!value) throw new Error("NIUBOT_CHAT_ID not set and --chat-id not provided");
  return value;
}

function parseSessionListStatus(value: string | undefined): "all" | "active" | "archived" {
  const status = value ?? "all";
  if (status === "active" || status === "archived") return status;
  if (status === "all") return "all";
  throw new Error(`--status must be one of: all, active, archived (got ${status})`);
}

function sessionActivityCursor(row: SessionRow): SessionActivityCursor {
  const activityAt = row.ended_at ?? row.last_active_at ?? row.started_at;
  return { activityAt, id: row.id };
}

function sessionMatchesThreadScope(
  row: { thread_id: string | null },
  scope: ResolvedHistoryThreadScope,
): boolean {
  if (scope.allThreads) return true;
  return (row.thread_id ?? undefined) === scope.threadId;
}

function numberFlag(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function optionalPositiveIntegerFlag(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function optionalNonNegativeIntegerFlag(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function boundedNumberFlag(value: string | undefined, fallback: number, maximum: number): number {
  return Math.max(100, Math.min(numberFlag(value, fallback), maximum));
}

function boundedCountFlag(value: string | undefined, fallback: number, maximum: number): number {
  return Math.max(1, Math.min(numberFlag(value, fallback), maximum));
}

function boundedPreviewFlag(value: string | undefined, fallback: number, maximum: number): number {
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
  console.log(`查询会话记录。读 backend 原生 transcript（归档 manifest 或进行中的 jsonl）。

命令:
  list                        列出进行中/已归档会话及首尾问答预览
  search <关键词>              搜索会话事件（与 list/get 一样过滤引擎注入）
  get <session-id>            按时间线查看会话，支持事件分页（短 ID 或原生 id 都能查）
  get <event-id>              查看 search 返回的单个完整事件

选项:
  list:   -n <count> | --after <session-id> | --since/--before <datetime>
          --thread-id <id> | --all-threads | --status all|active|archived
  search: -n <count> | --after <event-id> | --until-session <session-id>
          --messages-only | --sessions <count>
          --include-tools | --since/--before <datetime> | --thread-id <id> | --all-threads
  get:    --page-size <events> | --after-event <event-id> | --turn <number>
          --event-chars <count> | --verbose
          --thread-id <id>
          --summary [--page-size <turns> --after-turn <number>]
  --format jsonl              输出归一化事件 JSONL
  --max-chars <数量>          限制 get 输出（默认：事件 20000、会话 100000；上限 1000000）
  --since/--before <时间>     list 按归档时间过滤；search 按事件时间过滤
                               本地时间按配置时区；带 Z 或时区偏移的 ISO 时间也接受
  -n, --limit <数量>          list/search 的每页条数

话题群默认只看当前话题，与 nbt messages 一致；--all-threads 查看整个群。
list 显示内部短 ID；get/search 短 ID 和 backend 原生 id 都能认。
list/get/search 都去掉引擎注入、斜杠指令和重启 wake；--format jsonl 仍是原始 transcript。`);
}
