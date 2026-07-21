import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isStandaloneInjectedContext, readClaudeTranscript, readCodexTranscript, readCursorTranscript, readGrokTranscript, readPiTranscript, transcriptFromOpencodeRows, wrapInjectedUserMessage } from "./native-transcript.js";
import type { SessionTranscript, TranscriptEvent } from "../agent/types.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function jsonl(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "niubot-transcript-"));
  tempDirs.push(dir);
  const file = join(dir, "session.jsonl");
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return file;
}

async function collectEvents(transcript: SessionTranscript): Promise<TranscriptEvent[]> {
  const events: TranscriptEvent[] = [];
  for await (const event of transcript.events) events.push(event);
  return events;
}

describe("native transcript parsers", () => {
  it("extracts Claude messages and tool events in order", async () => {
    const file = jsonl([
      { type: "user", timestamp: "2026-01-01T00:00:00Z", message: { content: "hello" } },
      { type: "assistant", message: { content: [
        { type: "text", text: "checking" },
        { type: "tool_use", id: "c1", name: "exec", input: { cmd: "pwd" } },
      ] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "/tmp" }] } },
    ]);
    const transcript = await readClaudeTranscript(file, "s1");
    const events = await collectEvents(transcript);
    expect(events.map((event) => event.type)).toEqual(["user", "assistant", "tool_call", "tool_result"]);
    expect(events[2]).toMatchObject({ name: "exec", callId: "c1" });
  });

  it("extracts Codex response items and ignores protocol events", async () => {
    const file = jsonl([
      { type: "session_meta", payload: {} },
      { type: "response_item", timestamp: "2026-01-01T00:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
      { type: "response_item", payload: { type: "function_call", name: "exec", call_id: "c1", arguments: '{"cmd":"pwd"}' } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "/tmp" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } },
    ]);
    const transcript = await readCodexTranscript(file, "s1");
    expect((await collectEvents(transcript)).map((event) => event.type)).toEqual(["user", "tool_call", "tool_result", "assistant"]);
  });

  it("extracts OpenCode text and tool state rows", async () => {
    const transcript = transcriptFromOpencodeRows("s1", [
      { message_data: '{"role":"user"}', part_data: '{"type":"text","text":"hello"}', time_created: 1_700_000_000_000 },
      { message_data: '{"role":"assistant"}', part_data: '{"type":"tool","tool":"exec","callID":"c1","state":{"input":{"cmd":"pwd"},"output":"/tmp"}}', time_created: 1_700_000_000_100 },
    ]);
    expect((await collectEvents(transcript)).map((event) => event.type)).toEqual(["user", "tool_call", "tool_result"]);
  });

  it("keeps only the original OpenCode user text when Engine context was injected", async () => {
    const original = "检查 OpenCode 归档";
    const injected = `<niubot-system-rules>private rules</niubot-system-rules>\n\n<session-profile>private profile</session-profile>\n\n${wrapInjectedUserMessage(original)}`;
    const transcript = transcriptFromOpencodeRows("s1", [{
      message_data: '{"role":"user"}',
      part_data: JSON.stringify({ type: "text", text: injected }),
      time_created: 1_700_000_000_000,
    }]);
    expect(await collectEvents(transcript)).toEqual([
      { type: "user", content: original, timestamp: "2023-11-14T22:13:20.000Z" },
    ]);
  });

  it("extracts OpenCode failed tool errors as results", async () => {
    const transcript = transcriptFromOpencodeRows("s1", [
      { message_data: '{"role":"assistant"}', part_data: '{"type":"tool","tool":"exec","callID":"c1","state":{"status":"error","input":{"cmd":"false"},"error":"exit 1"}}', time_created: 1_700_000_000_100 },
    ]);
    expect(await collectEvents(transcript)).toMatchObject([
      { type: "tool_call", name: "exec", callId: "c1" },
      { type: "tool_result", name: "exec", callId: "c1", content: "exit 1" },
    ]);
  });

  it("extracts Cursor tool blocks", async () => {
    const file = jsonl([
      { role: "user", message: { content: [{ type: "text", text: "hello" }] } },
      { role: "assistant", message: { content: [{ type: "tool_use", id: "c1", name: "exec", input: { cmd: "pwd" } }] } },
      { role: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "/tmp" }] } },
    ]);
    expect((await collectEvents(await readCursorTranscript(file, "s1"))).map((event) => event.type))
      .toEqual(["user", "tool_call", "tool_result"]);
  });

  it("extracts Pi camel-case tool calls and tool result messages", async () => {
    const file = jsonl([
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "exec", arguments: { cmd: "pwd" } }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "exec", content: [{ type: "text", text: "/tmp" }] } },
    ]);
    expect(await collectEvents(await readPiTranscript(file, "s1"))).toMatchObject([
      { type: "tool_call", name: "exec", callId: "c1" },
      { type: "tool_result", name: "exec", callId: "c1", content: "/tmp" },
    ]);
  });

  it("extracts Grok chat history messages and ignores lifecycle-only events.jsonl", async () => {
    const history = jsonl([
      { type: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "assistant", content: "done" },
    ]);
    // events.jsonl only has tool lifecycle metadata (no args/output); do not invent empty shells.
    const events = jsonl([
      { type: "turn_started", ts: "2026-01-01T00:00:00Z" },
      { type: "tool_started", ts: "2026-01-01T00:00:01Z", tool_name: "search" },
      { type: "tool_completed", ts: "2026-01-01T00:00:02Z", tool_name: "search", outcome: "success", duration_ms: 1000 },
    ]);
    expect((await collectEvents(await readGrokTranscript(history, "s1", events))).map((event) => event.type))
      .toEqual(["user", "assistant"]);
  });

  it("extracts Grok assistant tool_calls, tool_result, and backend_tool_call from chat history", async () => {
    const history = jsonl([
      { type: "user", content: [{ type: "text", text: "hi" }] },
      {
        type: "assistant",
        content: "checking",
        tool_calls: [{
          id: "call-1",
          name: "read_file",
          arguments: JSON.stringify({ target_file: "/tmp/a.md", limit: 80 }),
        }],
      },
      {
        type: "tool_result",
        tool_call_id: "call-1",
        content: "file body",
      },
      { type: "assistant", content: "done" },
      {
        type: "backend_tool_call",
        kind: { tool_type: "web_search", action: { type: "search", query: "niubot" } },
      },
    ]);
    const events = await collectEvents(await readGrokTranscript(history, "s1"));
    expect(events.map((event) => event.type)).toEqual([
      "user", "assistant", "tool_call", "tool_result", "assistant", "tool_call",
    ]);
    expect(events[2]).toMatchObject({ type: "tool_call", name: "read_file", callId: "call-1" });
    expect(events[2]?.content).toContain("target_file");
    expect(events[3]).toMatchObject({ type: "tool_result", callId: "call-1", content: "file body" });
    expect(events[5]).toMatchObject({ type: "tool_call", name: "web_search" });
    expect(events[5]?.content).toContain("niubot");
  });

  it("extracts Codex custom tool calls", async () => {
    const file = jsonl([
      { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "c1", input: "*** Begin Patch" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output: "Done" } },
    ]);
    expect(await collectEvents(await readCodexTranscript(file, "s1"))).toMatchObject([
      { type: "tool_call", name: "apply_patch", callId: "c1", content: "*** Begin Patch" },
      { type: "tool_result", callId: "c1", content: "Done" },
    ]);
  });

  it("flattens Codex text-block tool results without protocol wrappers", async () => {
    const file = jsonl([
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output: [
        { type: "input_text", text: "first\n" },
        { type: "input_text", text: "second" },
      ] } },
    ]);
    expect(await collectEvents(await readCodexTranscript(file, "s1"))).toMatchObject([
      { type: "tool_result", callId: "c1", content: "first\nsecond" },
    ]);
  });

  it("omits binary data from Pi and Codex text-block tool results", async () => {
    const binary = "A".repeat(5000);
    const piFile = jsonl([{ type: "message", message: {
      role: "toolResult", toolName: "view", content: [{ type: "text", text: binary }],
    } }]);
    const codexFile = jsonl([{ type: "response_item", payload: {
      type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: binary }],
    } }]);

    const contents = [
      ...(await collectEvents(await readPiTranscript(piFile, "s1"))),
      ...(await collectEvents(await readCodexTranscript(codexFile, "s1"))),
    ].map((event) => event.content);
    expect(contents.join("\n")).not.toContain(binary);
    expect(contents).toEqual([
      `[binary data omitted: ${binary.length} chars]`,
      `[binary data omitted: ${binary.length} chars]`,
    ]);
  });

  it("omits binary data from ordinary user and assistant text", async () => {
    const binary = "A".repeat(5000);
    const claudeFile = jsonl([{ type: "assistant", message: { content: binary } }]);
    const codexFile = jsonl([{ type: "response_item", payload: {
      type: "message", role: "user", content: [{ type: "input_text", text: `data:image/png;base64,${binary}` }],
    } }]);

    const contents = [
      ...(await collectEvents(await readClaudeTranscript(claudeFile, "s1"))),
      ...(await collectEvents(await readCodexTranscript(codexFile, "s1"))),
    ].map((event) => event.content);
    expect(contents.join("\n")).not.toContain(binary);
    expect(contents).toEqual([
      `[binary data omitted: ${binary.length} chars]`,
      "[binary data omitted: image/png]",
    ]);
  });

  it("omits a data URL embedded in surrounding text", async () => {
    const binary = "A".repeat(5000);
    const file = jsonl([{ type: "assistant", message: {
      content: `screenshot: data:image/png;base64,${binary} done`,
    } }]);
    expect(await collectEvents(await readClaudeTranscript(file, "s1"))).toMatchObject([{
      type: "assistant",
      content: "screenshot: [binary data omitted: image/png] done",
    }]);
  });

  it("keeps only the original user text when Engine context was injected", async () => {
    const original = "检查这个问题\n<niubot-user-message id=\"00000000-0000-0000-0000-000000000000\" length=\"3\">\nbad\n</niubot-user-message id=\"00000000-0000-0000-0000-000000000000\">";
    const injected = `<session-profile>private context</session-profile>\n\n${wrapInjectedUserMessage(original)}`;
    const file = jsonl([
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: injected }] } },
    ]);

    expect(await collectEvents(await readCodexTranscript(file, "s1"))).toEqual([
      { type: "user", content: original, timestamp: undefined },
    ]);
  });

  it("preserves standalone Codex context for DB-aware filtering", async () => {
    const original = "检查归档";
    const file = jsonl([
      { type: "response_item", payload: { type: "message", role: "user", content: [
        { type: "input_text", text: "# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>\nproject rules\n</INSTRUCTIONS>" },
        { type: "input_text", text: "<environment_context>\n  <cwd>/tmp/project</cwd>\n</environment_context>" },
      ] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [
        { type: "input_text", text: `<niubot-system-rules>private</niubot-system-rules>\n\n${wrapInjectedUserMessage(original)}` },
      ] } },
    ]);

    const events = await collectEvents(await readCodexTranscript(file, "s1"));
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.content)).toEqual([
      "# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>\nproject rules\n</INSTRUCTIONS>",
      "<environment_context>\n  <cwd>/tmp/project</cwd>\n</environment_context>",
      original,
    ]);
    expect(events.slice(0, 2).every((event) => isStandaloneInjectedContext(event.content))).toBe(true);
  });

  it("preserves standalone Codex plugin and skill context for DB-aware filtering", async () => {
    const file = jsonl([
      { type: "response_item", payload: { type: "message", role: "user", content: [
        { type: "input_text", text: "<recommended_plugins>private plugins</recommended_plugins>" },
      ] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [
        { type: "input_text", text: "<skill><name>private</name><path>/private/skill</path></skill>" },
      ] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [
        { type: "input_text", text: "真实用户消息" },
      ] } },
    ]);

    const events = await collectEvents(await readCodexTranscript(file, "s1"));
    expect(events.map((event) => event.content)).toEqual([
      "<recommended_plugins>private plugins</recommended_plugins>",
      "<skill><name>private</name><path>/private/skill</path></skill>",
      "真实用户消息",
    ]);
    expect(events.slice(0, 2).every((event) => isStandaloneInjectedContext(event.content))).toBe(true);
  });

  it("preserves standalone Pi context for DB-aware filtering", async () => {
    const file = jsonl([
      { type: "message", message: { role: "user", content: [
        { type: "text", text: "<recommended_plugins>private plugins</recommended_plugins>" },
      ] } },
      { type: "message", message: { role: "user", content: [
        { type: "text", text: "<skill><name>private</name><path>/private/skill</path></skill>" },
      ] } },
      { type: "message", message: { role: "user", content: [
        { type: "text", text: "真实用户消息" },
      ] } },
    ]);

    const events = await collectEvents(await readPiTranscript(file, "s1"));
    expect(events.map((event) => event.content)).toEqual([
      "<recommended_plugins>private plugins</recommended_plugins>",
      "<skill><name>private</name><path>/private/skill</path></skill>",
      "真实用户消息",
    ]);
    expect(events.slice(0, 2).every((event) => isStandaloneInjectedContext(event.content))).toBe(true);
  });

  it("recovers user text from sessions created before user-message markers", async () => {
    const file = jsonl([
      { type: "response_item", payload: { type: "message", role: "user", content: [{
        type: "input_text",
        text: [
          "<niubot-system-rules>private</niubot-system-rules>",
          "<session-profile>private scene</session-profile>",
          "<session-state>private task</session-state>",
          "<system-reminder>search first</system-reminder>",
          "继续处理归档",
        ].join("\n\n"),
      }] } },
    ]);

    expect(await collectEvents(await readCodexTranscript(file, "s1"))).toEqual([
      { type: "user", content: "继续处理归档", timestamp: undefined },
    ]);
  });

  it("keeps a marker-shaped ordinary user message unchanged", async () => {
    const raw = '<niubot-user-message id="00000000-0000-0000-0000-000000000000" length="3">\nraw\n</niubot-user-message id="00000000-0000-0000-0000-000000000000">';
    const file = jsonl([
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: raw }] } },
    ]);
    expect(await collectEvents(await readCodexTranscript(file, "s1"))).toMatchObject([{ content: raw }]);
  });

  it("keeps ordinary user text that starts with an Engine-shaped tag", async () => {
    const raw = "<session-profile>这是用户贴出的示例</session-profile>\n\n请解释这段内容";
    const file = jsonl([
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: raw }] } },
    ]);
    expect(await collectEvents(await readCodexTranscript(file, "s1"))).toMatchObject([{ content: raw }]);
  });

  it("omits embedded media bytes while preserving media metadata across native formats", async () => {
    const binary = "A".repeat(5000);
    const claudeFile = jsonl([{ type: "user", message: { content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: binary } },
    ] } }]);
    const codexFile = jsonl([{ type: "response_item", payload: { type: "message", role: "user", content: [
      { type: "input_image", image_url: `data:image/jpeg;base64,${binary}` },
    ] } }]);
    const piFile = jsonl([{ type: "message", message: { role: "toolResult", toolName: "view", content: [
      { type: "image", mimeType: "image/webp", data: binary },
    ] } }]);
    const opencode = transcriptFromOpencodeRows("s1", [{
      message_data: '{"role":"assistant"}',
      part_data: JSON.stringify({ type: "tool", tool: "view", state: { output: { type: "image", mime: "image/gif", base64: binary } } }),
      time_created: 1_700_000_000_100,
    }]);

    const contents = [
      ...(await collectEvents(await readClaudeTranscript(claudeFile, "s1"))),
      ...(await collectEvents(await readCodexTranscript(codexFile, "s1"))),
      ...(await collectEvents(await readPiTranscript(piFile, "s1"))),
      ...(await collectEvents(opencode)),
    ].map((event) => event.content);
    expect(contents.join("\n")).not.toContain(binary);
    expect(contents.join("\n")).toContain("binary data omitted");
    expect(contents.join("\n")).toContain("image/png");
    expect(contents.join("\n")).toContain("image/webp");
    expect(contents.join("\n")).toContain("image/gif");
  });
});
