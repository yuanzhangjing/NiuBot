import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { SessionTranscript, TranscriptEvent } from "../agent/types.js";
import { getSessionArchiveDirectory } from "../session-archive/archive.js";
import {
  findSessionArchive,
  loadArchivedTranscript,
  type LocatedSessionArchive,
} from "../session-archive/reader.js";
import { isStandaloneInjectedContext } from "../session-archive/native-transcript.js";
import { getSessionLastExchange, listSessionMessages } from "../messages/store.js";
import {
  getSessionForAccess,
  listSessions,
  listSessionsOverlappingUtcRange,
  type SessionRow,
} from "../sessions/store.js";
import {
  formatLocalDateTimeWithTZ,
  instantIsInUtcRange,
  TZ,
  userTimeRangeToUtc,
  utcToLocalDateTime,
} from "../tz.js";

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
  const pageSize = boundedCountFlag(flags["limit"] ?? flags["n"], 10, 100);
  let after: { endedAt: string; id: string } | undefined;
  if (flags["after"]) {
    const cursor = getSessionForAccess(db, flags["after"], { currentChatId, chatType });
    if (!cursor || cursor.chat_id !== targetChatId || !cursor.ended_at) {
      throw new Error(`Session cursor not found: ${flags["after"]}`);
    }
    after = { endedAt: cursor.ended_at, id: cursor.id };
  }
  const rows = listSessions(db, {
    currentChatId,
    chatType,
    targetChatId,
    limit: pageSize + 1,
    since: flags["since"],
    before: flags["before"],
    after,
  });
  if (rows.length === 0) {
    console.log("(无归档 session)");
    return;
  }
  const hasMore = rows.length > pageSize;
  const page = rows.slice(0, pageSize);
  for (const row of page) {
    const archive = locate(niubotHome, botName, row);
    const archiveLabel = archive ? "source-reference" : "missing";
    console.log(formatSessionRow(row, archiveLabel));
    const exchange = getSessionLastExchange(db, row.id);
    console.log(`  user: ${exchange.user ? sessionListPreview(exchange.user.content_text) : "(无)"}`);
    console.log(`  response: ${exchange.response ? sessionListPreview(exchange.response.content_text) : "(无)"}`);
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
  const pageSize = boundedCountFlag(flags["limit"] ?? flags["n"], 10, 100);
  const messagesOnly = flags["messages-only"] === "true";
  const sessionScanLimit = boundedCountFlag(flags["sessions"], 500, 10_000);
  const eventRange = userTimeRangeToUtc({ since: flags["since"], before: flags["before"] });
  let through: { endedAt: string; id: string } | undefined;
  if (flags["through-session"]) {
    const anchor = getSessionForAccess(db, flags["through-session"], { currentChatId, chatType });
    if (!anchor || anchor.chat_id !== targetChatId || anchor.status !== "archived" || !anchor.ended_at) {
      throw new Error(`Search anchor session not found: ${flags["through-session"]}`);
    }
    through = { endedAt: anchor.ended_at, id: anchor.id };
  }
  const candidateRows = listSessionsOverlappingUtcRange(db, {
    currentChatId,
    chatType,
    targetChatId,
    limit: sessionScanLimit + 1,
    sinceUtc: eventRange.since,
    beforeUtc: eventRange.before,
    through,
  });
  const throughSessionId = through?.id ?? candidateRows[0]?.id;
  const candidateSessionsTruncated = candidateRows.length > sessionScanLimit;
  const rows = candidateRows.slice(0, sessionScanLimit);
  const needle = query.toLocaleLowerCase();
  const page: SearchMatch[] = [];
  let cursorFound = flags["after"] === undefined;
  let hasMore = false;
  scan: for (const row of rows) {
    const archive = locate(niubotHome, botName, row);
    if (!archive) continue;
    try {
      const transcript = transcriptFor(db, row, archive);
      const messageIds = sessionMessageIds(db, row.id);
      for await (const item of timelineEvents(row.id, transcript.events, messageIds)) {
        if (messagesOnly && item.event.type !== "user" && !item.finalAssistant) continue;
        if (!instantIsInUtcRange(item.event.timestamp, eventRange)) continue;
        const index = item.event.content.toLocaleLowerCase().indexOf(needle);
        if (index < 0) continue;
        if (!cursorFound) {
          if (item.eventId === flags["after"]) cursorFound = true;
          continue;
        }
        if (page.length >= pageSize) {
          hasMore = true;
          break scan;
        }
        page.push({
          eventId: item.eventId,
          messageId: item.messageId,
          sessionId: row.id,
          turnNumber: item.turnNumber,
          event: { ...item.event, content: "" },
          snippet: snippet(item.event.content, index, query.length),
        });
      }
    } catch (err) {
      console.error(`Warning: cannot read session ${row.id}: ${(err as Error).message}`);
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
  const row = getSessionForAccess(db, sessionId, { currentChatId, chatType });
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  const archive = locate(niubotHome, botName, row);
  if (!archive) throw new Error(`Session archive not found: ${sessionId}`);

  if (flags["format"] === "jsonl"
    && (flags["turn"] || flags["after-turn"] || flags["after-event"]
      || flags["verbose"] === "true" || flags["summary"] === "true")) {
    throw new Error("turn and event pagination flags cannot be combined with --format jsonl");
  }
  const transcript = transcriptFor(db, row, archive);
  if (requestedEventId || flags["format"] === "jsonl") {
    await printEventStream(row.id, transcript.events, requestedEventId, flags["format"], maxChars);
    return;
  }
  const targetTurn = optionalPositiveIntegerFlag(flags["turn"], "--turn");
  const summary = flags["summary"] === "true";
  if (summary) {
    if (flags["after-event"]) throw new Error("--after-event cannot be combined with --summary");
    if (flags["verbose"] === "true") throw new Error("--verbose cannot be combined with --summary");
    await printSessionSummary(row, transcript.events, botName, targetTurn, flags, maxChars);
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
  });
}

async function printSessionSummary(
  row: SessionRow,
  events: SessionTranscript["events"],
  botName: string,
  targetTurn: number | undefined,
  flags: Record<string, string>,
  maxChars: number,
): Promise<void> {
  const afterTurn = optionalNonNegativeIntegerFlag(flags["after-turn"], "--after-turn") ?? 0;
  if (targetTurn && flags["after-turn"]) throw new Error("--turn cannot be combined with --after-turn");
  const pageSize = targetTurn
    ? 1
    : boundedCountFlag(flags["page-size"], DEFAULT_TURN_PAGE_SIZE, MAX_TURN_PAGE_SIZE);
  const selection = await selectTranscriptTurns(row.id, events, { targetTurn, afterTurn, pageSize });
  if (targetTurn && selection.turns.length === 0) throw new Error(`Turn not found: ${targetTurn}`);
  printTurnSessionHeader(row, selection.turns, selection.totalTurns);
  if (selection.turns.length === 0) {
    console.log("(没有更多 turn)");
    return;
  }
  let remainingChars = maxChars;
  let lastCompleteTurn: TranscriptTurn | undefined;
  let pageTruncated = false;
  for (const turn of selection.turns) {
    const result = printTurn(botName, row.id, turn, remainingChars);
    remainingChars = result.remainingChars;
    if (result.truncated) {
      pageTruncated = true;
      break;
    }
    lastCompleteTurn = turn;
    if (turn !== selection.turns.at(-1)) console.log("---\n");
  }
  if (pageTruncated) {
    printTurnRetryCommand(row.id, targetTurn, lastCompleteTurn?.number ?? afterTurn, pageSize, maxChars);
  } else if (!targetTurn && lastCompleteTurn && lastCompleteTurn.number < selection.totalTurns) {
    console.log(`下一页：/nbt sessions get ${row.id} --summary --after-turn ${lastCompleteTurn.number} --page-size ${pageSize}`);
  }
}

function locate(niubotHome: string, botName: string, row: SessionRow): LocatedSessionArchive | undefined {
  return findSessionArchive(getSessionArchiveDirectory(niubotHome, botName, row.chat_id), row.id);
}

function transcriptFor(db: Database.Database, row: SessionRow, archive: LocatedSessionArchive): SessionTranscript {
  const transcript = loadArchivedTranscript(archive.path).transcript;
  const realUserMessages = new Map<string, number>();
  for (const message of listSessionMessages(db, row.id)) {
    if (message.role !== "user" || !isStandaloneInjectedContext(message.content_text)) continue;
    realUserMessages.set(message.content_text, (realUserMessages.get(message.content_text) ?? 0) + 1);
  }
  const events = omitSyntheticContextEvents(transcript.events, realUserMessages);
  return { ...transcript, events: inferToolResultNames(events) };
}

async function* omitSyntheticContextEvents(
  events: SessionTranscript["events"],
  realUserMessages: Map<string, number>,
): AsyncGenerator<TranscriptEvent> {
  for await (const event of events) {
    if (event.type === "user" && isStandaloneInjectedContext(event.content)) {
      const remaining = realUserMessages.get(event.content) ?? 0;
      if (remaining === 0) continue;
      realUserMessages.set(event.content, remaining - 1);
    }
    yield event;
  }
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
    const { event: outputEvent, truncated } = limitEventContent(event, remainingChars);
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

async function selectTranscriptTurns(
  sessionId: string,
  events: SessionTranscript["events"],
  options: { targetTurn?: number; afterTurn: number; pageSize: number },
): Promise<{ turns: TranscriptTurn[]; totalTurns: number }> {
  const turns: TranscriptTurn[] = [];
  let totalTurns = 0;
  for await (const turn of transcriptTurns(sessionId, events)) {
    totalTurns = turn.number;
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
  for await (const item of timelineEvents(sessionId, events)) {
    seenTurns = Math.max(seenTurns, item.turnNumber);
    if (options.targetTurn && item.turnNumber > options.targetTurn) break;
    if (options.targetTurn && item.turnNumber !== options.targetTurn) continue;
    targetTurnFound = true;
    seenEvents++;
    if (!cursorFound) {
      if (item.eventId === options.afterEventId) cursorFound = true;
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
  },
): void {
  console.log(`Timezone: ${TZ}`);
  console.log(`Session ${row.id} · ${row.backend_type ?? "unknown"} · ${compactSessionTimeRange(row)}`);
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
      console.log(`    event=${item.eventId}${item.event.callId ? ` call=${item.event.callId}` : ""}`);
    }
    if (item.event.type === "tool_call" || item.event.type === "tool_result") {
      const fence = markdownCodeFence(preview.content);
      console.log(`${fence}text\n${preview.content}\n${fence}`);
    } else if (!inline) {
      console.log(preview.content);
    }
    if (preview.truncated) console.log(`〔内容已截断：/nbt sessions get ${item.eventId}〕`);
    remainingChars -= preview.content.length;
    lastPrinted = item;
    printed++;
  }

  const hasUnprintedSelectedItems = printed < selection.items.length;
  const hasMore = !!lastPrinted && (selection.hasMore || hasUnprintedSelectedItems);
  console.log(`本页显示 ${printed} 步${hasMore ? "，还有更多" : "，已到最后一步"}`);
  if (hasMore && lastPrinted) {
    console.log(`下一页：${timelineContinuationCommand(row.id, lastPrinted.eventId, options)}`);
  }
}

function compactTimelineEventLabel(item: TimelineItem): string {
  const name = item.event.name;
  switch (item.event.type) {
    case "user": return "用户";
    case "assistant": return item.finalAssistant ? "最终回复" : "过程消息";
    case "tool_call": return name ? `${name} 调用` : "工具调用";
    case "tool_result": return name ? `${name} 结果` : "工具结果";
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

function printTurnSessionHeader(row: SessionRow, turns: TranscriptTurn[], totalTurns: number): void {
  console.log(`# Session ${row.id}`);
  console.log(`时间：${formatLocalDateTimeWithTZ(row.started_at)} ～ ${row.ended_at ? formatLocalDateTimeWithTZ(row.ended_at) : "ongoing"}`);
  console.log(`Backend：${row.backend_type ?? "unknown"}`);
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
): { remainingChars: number; truncated: boolean } {
  const time = turn.events[0]?.event.timestamp
    ? formatLocalDateTimeWithTZ(turn.events[0]!.event.timestamp!)
    : "time unavailable";
  console.log(`## 第 ${turn.number} 轮 · ${time}\n`);

  const users = turn.events.filter((item) => item.event.type === "user");
  const { processMessages, finalMessages } = assistantSections(turn);
  const toolCalls = turn.events.filter((item) => item.event.type === "tool_call");
  const toolResults = turn.events.filter((item) => item.event.type === "tool_result");
  let remainingChars = maxChars;

  console.log("用户：");
  const userResult = printLimitedText(users.map((item) => item.event.content).join("\n\n"), remainingChars);
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
  appendPreservedFlag(parts, flags, "since");
  appendPreservedFlag(parts, flags, "before");
  appendPreservedFlag(parts, flags, "chat-id");
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
  if (throughSessionId) parts.push(`--through-session ${quoteArg(throughSessionId)}`);
  if (flags["messages-only"] === "true") parts.push("--messages-only");
  if (flags["include-tools"] === "true") parts.push("--include-tools");
  return parts.join(" ");
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

function formatSessionRow(row: SessionRow, archive: string): string {
  const start = formatLocalDateTimeWithTZ(row.started_at);
  const end = row.ended_at ? formatLocalDateTimeWithTZ(row.ended_at) : "ongoing";
  return `[${row.id}] ${start} ~ ${end} backend=${row.backend_type ?? "unknown"} archive=${archive}`;
}

function sessionListPreview(content: string, maxRunes = 160): string {
  const flattened = content.replace(/\s+/g, " ").trim() || "(空)";
  const runes = [...flattened];
  return runes.length <= maxRunes ? flattened : `${runes.slice(0, maxRunes).join("")}...`;
}

function requireChatId(value: string | undefined): string {
  if (!value) throw new Error("NIUBOT_CHAT_ID not set and --chat-id not provided");
  return value;
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
  console.log(`Query archived backend transcripts.

Commands:
  list                         List archived sessions with their last user/response preview
  search <query>               Search every execution event in archived sessions
  get <session-id>             Show the execution timeline with event pagination
  get <event-id>               Show one complete event returned by search

Options:
  list:   -n <count> | --after <session-id> | --since/--before <datetime>
  search: -n <count> | --after <event-id> | --messages-only | --sessions <count>
          --since/--before <datetime>
  get:    --page-size <events> | --after-event <event-id> | --turn <number>
          --event-chars <count> | --verbose
          --summary [--page-size <turns> --after-turn <number>]
  --format jsonl               Output all normalized events as JSONL
  --max-chars <count>          Limit get output (default: event 20000, session 100000; max 1000000)
  --since/--before <datetime>  List: filter archive time; search: filter event time
                               Date/local datetime uses configured timezone; ISO Z/offset is accepted
  -n, --limit <count>          Page size for list or search`);
}
