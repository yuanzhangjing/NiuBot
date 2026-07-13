import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { SessionTranscript, TranscriptEvent } from "../agent/types.js";

type JsonObject = Record<string, unknown>;
const INJECTED_USER_MARKER = /<niubot-user-message id="([a-f0-9-]+)" length="(\d+)">\n/g;
const ENGINE_CONTEXT_PREFIX = /<(?:niubot-system-rules|session-profile|session-state|system-reminder|current-speaker|speakers|session-archives)\b/;
const MEDIA_TYPES = new Set(["image", "input_image", "output_image", "audio", "video", "file", "media"]);

export function wrapInjectedUserMessage(content: string): string {
  const id = randomUUID();
  return `<niubot-user-message id="${id}" length="${content.length}">\n${content}\n</niubot-user-message id="${id}">`;
}

export function readClaudeTranscript(file: string, agentSessionId: string): SessionTranscript {
  return { backend: "claude", agentSessionId, events: messageJsonlEvents(file, (entry) => {
    const type = string(entry["type"]);
    if (type !== "user" && type !== "assistant") return [];
    return messageContentEvents(type, object(entry["message"])?.["content"], string(entry["timestamp"]));
  }) };
}

export function readCodexTranscript(file: string, agentSessionId: string, backend = "codex"): SessionTranscript {
  const events = messageJsonlEvents(file, (entry) => {
    if (entry["type"] !== "response_item") return [];
    const payload = object(entry["payload"]);
    if (!payload) return [];
    const timestamp = string(entry["timestamp"]);
    const payloadType = string(payload["type"]);
    if (payloadType === "message") {
      const role = string(payload["role"]);
      if (role === "user" || role === "assistant") {
        return messageContentEvents(role, payload["content"], timestamp);
      }
    } else if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      return [{
        timestamp,
        type: "tool_call",
        name: string(payload["name"]),
        callId: string(payload["call_id"]),
        content: pretty(payload["arguments"] ?? payload["input"]),
      }];
    } else if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      return [{
        timestamp,
        type: "tool_result",
        callId: string(payload["call_id"]),
        content: pretty(payload["output"]),
      }];
    }
    return [];
  });
  return { backend, agentSessionId, events };
}

export function readCursorTranscript(file: string, agentSessionId: string): SessionTranscript {
  const events = messageJsonlEvents(file, (entry) => {
    const role = string(entry["role"]);
    if (role !== "user" && role !== "assistant") return [];
    const message = object(entry["message"]);
    return messageContentEvents(role, message?.["content"] ?? entry["message"], string(entry["timestamp"]));
  });
  return { backend: "cursor", agentSessionId, events };
}

export function readPiTranscript(file: string, agentSessionId: string): SessionTranscript {
  const events = messageJsonlEvents(file, (entry) => {
    if (entry["type"] !== "message") return [];
    const message = object(entry["message"]);
    const role = string(message?.["role"]);
    const eventTimestamp = timestamp(message?.["timestamp"] ?? entry["timestamp"]);
    if (role === "user" || role === "assistant") {
      return messageContentEvents(role, message?.["content"] ?? message?.["text"], eventTimestamp);
    } else if (role === "toolResult") {
      return [{
        timestamp: eventTimestamp,
        type: "tool_result",
        name: string(message?.["toolName"]),
        callId: string(message?.["toolCallId"]),
        content: contentText(message?.["content"]),
      }];
    }
    return [];
  });
  return { backend: "pi", agentSessionId, events };
}

export function readGrokTranscript(file: string, agentSessionId: string, eventsFile?: string): SessionTranscript {
  const events = grokEvents(file, eventsFile);
  return { backend: "grok", agentSessionId, events };
}

async function* grokEvents(file: string, eventsFile?: string): AsyncGenerator<TranscriptEvent> {
  const toolTurns = eventsFile ? readGrokToolTurns(eventsFile)[Symbol.asyncIterator]() : undefined;
  for await (const entry of readJsonl(file)) {
    const type = string(entry["type"]);
    const eventTimestamp = string(entry["timestamp"] ?? entry["ts"]);
    if (type === "user") {
      yield* messageContentEvents(type, entry["content"], eventTimestamp);
    } else if (type === "assistant") {
      if (toolTurns) {
        const turn = await toolTurns.next();
        if (!turn.done) yield* turn.value;
      }
      yield* messageContentEvents(type, entry["content"], eventTimestamp);
    } else if (type === "function_call" || type === "tool_call") {
      yield {
        timestamp: eventTimestamp, type: "tool_call",
        name: string(entry["name"] ?? entry["tool_name"]),
        callId: string(entry["call_id"] ?? entry["id"]),
        content: pretty(entry["arguments"] ?? entry["input"]),
      };
    } else if (type === "function_call_output" || type === "tool_result") {
      yield {
        timestamp: eventTimestamp, type: "tool_result",
        name: string(entry["name"] ?? entry["tool_name"]),
        callId: string(entry["call_id"] ?? entry["id"]),
        content: pretty(entry["output"] ?? entry["content"]),
      };
    }
  }
  if (toolTurns) {
    for (let turn = await toolTurns.next(); !turn.done; turn = await toolTurns.next()) yield* turn.value;
  }
}

async function* readGrokToolTurns(file: string): AsyncGenerator<TranscriptEvent[]> {
  const active = new Map<string, string[]>();
  let current: TranscriptEvent[] | undefined;
  let sequence = 0;
  for await (const entry of readJsonl(file)) {
    const type = string(entry["type"]);
    if (type === "turn_started") {
      if (current) yield current;
      current = [];
      active.clear();
    }
    if (!current) continue;
    const name = string(entry["tool_name"]);
    const eventTimestamp = string(entry["ts"]);
    if (type === "tool_started") {
      const callId = `grok-tool-${++sequence}`;
      const ids = active.get(name ?? "unknown") ?? [];
      ids.push(callId);
      active.set(name ?? "unknown", ids);
      current.push({
        timestamp: eventTimestamp,
        type: "tool_call",
        name,
        callId,
        content: "（Grok 原生记录未提供工具参数）",
      });
    } else if (type === "tool_completed") {
      const ids = active.get(name ?? "unknown") ?? [];
      const callId = ids.shift() ?? `grok-tool-${++sequence}`;
      current.push({
        timestamp: eventTimestamp,
        type: "tool_result",
        name,
        callId,
        content: pretty({ outcome: entry["outcome"], duration_ms: entry["duration_ms"], detail: "Grok 原生记录未提供工具输出" }),
      });
    }
  }
  if (current) yield current;
}

export function transcriptFromOpencodeRows(
  agentSessionId: string,
  rows: Iterable<{ message_data: string; part_data: string; time_created: number | null }>,
): SessionTranscript {
  function* events(): Generator<TranscriptEvent> {
    for (const row of rows) {
    const message = parseObject(row.message_data);
    const part = parseObject(row.part_data);
    const role = string(message?.["role"]);
    const type = string(part?.["type"]);
    const timestamp = row.time_created
      ? new Date(row.time_created < 1_000_000_000_000 ? row.time_created * 1000 : row.time_created).toISOString()
      : undefined;
    if ((role === "user" || role === "assistant") && type === "text") {
      const text = string(part?.["text"]);
      if (text) yield { timestamp, type: role, content: text };
    } else if (type === "tool") {
      const state = object(part?.["state"]);
      const callId = string(part?.["callID"] ?? part?.["callId"]);
      const name = string(part?.["tool"]);
      const input = state?.["input"];
      if (input !== undefined) yield { timestamp, type: "tool_call", name, callId, content: pretty(input) };
      const output = state?.["output"] ?? state?.["error"];
      if (output !== undefined) yield { timestamp, type: "tool_result", name, callId, content: pretty(output) };
    }
    }
  }
  return { backend: "opencode", agentSessionId, events: events() };
}

function messageContentEvents(
  role: "user" | "assistant",
  value: unknown,
  timestamp?: string,
): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  if (typeof value === "string") {
    const content = role === "user" ? extractInjectedUserMessage(value) : value;
    if (content) events.push({ timestamp, type: role, content });
    return events;
  }
  if (!Array.isArray(value)) return events;
  for (const rawBlock of value) {
    const block = object(rawBlock);
    if (!block) continue;
    const type = string(block["type"]);
    if (type === "text" || type === "input_text" || type === "output_text") {
      const text = string(block["text"]);
      const content = role === "user" && text ? extractInjectedUserMessage(text) : text;
      if (content) events.push({ timestamp, type: role, content });
    } else if (type === "tool_use" || type === "tool_call" || type === "toolCall" || type === "function_call") {
      events.push({
        timestamp,
        type: "tool_call",
        name: string(block["name"] ?? block["tool_name"]),
        callId: string(block["id"] ?? block["call_id"]),
        content: pretty(block["input"] ?? block["arguments"]),
      });
    } else if (type === "tool_result" || type === "function_call_output") {
      events.push({
        timestamp,
        type: "tool_result",
        name: string(block["name"] ?? block["tool_name"]),
        callId: string(block["tool_use_id"] ?? block["call_id"] ?? block["id"]),
        content: pretty(block["content"] ?? block["output"]),
      });
    } else if (type && MEDIA_TYPES.has(type)) {
      events.push({ timestamp, type: role, content: pretty(block) });
    }
  }
  return events;
}

function extractInjectedUserMessage(content: string): string {
  INJECTED_USER_MARKER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INJECTED_USER_MARKER.exec(content)) !== null) {
    if (!ENGINE_CONTEXT_PREFIX.test(content.slice(0, match.index))) continue;
    const length = Number(match[2]);
    const start = match.index + match[0].length;
    const closing = `\n</niubot-user-message id="${match[1]}">`;
    if (Number.isSafeInteger(length) && length >= 0 && content.slice(start + length) === closing) {
      return content.slice(start, start + length);
    }
  }
  return content;
}

async function* messageJsonlEvents(
  file: string,
  convert: (entry: JsonObject) => TranscriptEvent[],
): AsyncGenerator<TranscriptEvent> {
  for await (const entry of readJsonl(file)) yield* convert(entry);
}

async function* readJsonl(file: string): AsyncGenerator<JsonObject> {
  const input = createReadStream(file, { encoding: "utf-8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (object(value)) yield value as JsonObject;
    } catch { /* skip malformed lines */ }
  }
}

function parseObject(value: string): JsonObject | undefined {
  try { return object(JSON.parse(value)); } catch { return undefined; }
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return new Date(value < 1_000_000_000_000 ? value * 1000 : value).toISOString();
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return pretty(value);
  return value.map((part) => {
    const block = object(part);
    return string(block?.["text"]) ?? pretty(part);
  }).filter(Boolean).join("\n");
}

function pretty(value: unknown): string {
  if (typeof value === "string") {
    try { return JSON.stringify(sanitizeTranscriptValue(JSON.parse(value)), null, 2); } catch {
      return sanitizeTranscriptString(value);
    }
  }
  return value === undefined ? "" : JSON.stringify(sanitizeTranscriptValue(value), null, 2);
}

function sanitizeTranscriptValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    if (["data", "base64", "bytes", "blob"].includes(key ?? "")) {
      return `[binary data omitted: ${value.length} chars]`;
    }
    return sanitizeTranscriptString(value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeTranscriptValue(item));
  const record = object(value);
  if (!record) return value;
  return Object.fromEntries(Object.entries(record).map(([childKey, childValue]) => [
    childKey,
    sanitizeTranscriptValue(childValue, childKey),
  ]));
}

function sanitizeTranscriptString(value: string): string {
  const dataUrl = /^data:([^;,]+)?(?:;[^,]*)?;base64,/i.exec(value);
  if (dataUrl) return `[binary data omitted${dataUrl[1] ? `: ${dataUrl[1]}` : ""}]`;
  if (value.length > 4096 && /^[A-Za-z0-9+/\r\n]+={0,2}$/.test(value)) {
    return `[binary data omitted: ${value.length} chars]`;
  }
  return value;
}
