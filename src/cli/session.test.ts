import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBackend, TranscriptEvent } from "../agent/types.js";
import { initDatabase, storeMessage } from "../database/schema.js";
import { archiveAgentSession } from "../session-archive/archive.js";
import { readCodexTranscript, wrapInjectedUserMessage } from "../session-archive/native-transcript.js";
import { TZ, utcToLocalDateTime } from "../tz.js";
import { parseArgs } from "./args.js";
import { handleSessions, markdownCodeFence, selectTimelineEvents } from "./session.js";

const tempDirs: string[] = [];

function localParts(utc: string): { date: string; time: string; dateTime: string } {
  const dateTime = utcToLocalDateTime(utc);
  const [date = "", time = ""] = dateTime.split(" ");
  return { date, time, dateTime };
}

function expectedListRange(startUtc: string, endUtc: string): string {
  const start = localParts(startUtc);
  const end = localParts(endUtc);
  if (start.dateTime === end.dateTime) return start.time;
  return start.date === end.date
    ? `${start.time}～${end.time}`
    : `${start.dateTime}～${end.time}`;
}

function expectedSessionRange(startUtc: string, endUtc: string): string {
  const start = localParts(startUtc);
  const end = localParts(endUtc);
  return start.date === end.date
    ? `${start.date} ${start.time}～${end.time}`
    : `${start.dateTime}～${end.dateTime}`;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function addArchivedCodexSession(
  db: ReturnType<typeof initDatabase>,
  home: string,
  id: string,
  start: string,
  end: string,
  timestamp: string,
  finalReply: string,
): Promise<void> {
  db.prepare(`
    INSERT INTO sessions (
      id, chat_id, user_id, source, status, backend_type, agent_session_id,
      started_at, ended_at, last_active_at
    ) VALUES (?, 'c1', 'u2', 'user', 'archived', 'codex', ?, ?, ?, ?)
  `).run(id, `agent-${id}`, start, end, end);
  const native = join(home, `${id}.jsonl`);
  writeFileSync(native, [
    { type: "response_item", timestamp, payload: { type: "message", role: "user", content: [{ type: "input_text", text: `问题 ${id}` }] } },
    { type: "response_item", timestamp, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: finalReply }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const transcript = { ...readCodexTranscript(native, `agent-${id}`), sources: [{ path: native, role: "session" }] };
  const backend = { exportSessionTranscript: async () => transcript } as AgentBackend;
  await archiveAgentSession(home, backend, { id: `agent-${id}` }, {
    botId: "NiuBot",
    chatId: "c1",
    sessionId: id,
    source: "user",
    backend: "codex",
    startedAt: start,
    archivedAt: end,
  });
}

describe("nbt sessions", () => {
  it("chooses a fence without expanding every backtick run as function arguments", () => {
    expect(markdownCodeFence("` ".repeat(200_000))).toBe("```");
    expect(markdownCodeFence("before ```` after")).toBe("`````");
  });

  it("stops timeline loading after the current page and one lookahead event", async () => {
    let consumed = 0;
    async function* events(): AsyncGenerator<TranscriptEvent> {
      for (let turn = 1; turn <= 100; turn++) {
        consumed++;
        yield { type: "user", timestamp: `2026-07-13T01:${String(turn % 60).padStart(2, "0")}:00Z`, content: `问题 ${turn}` };
        consumed++;
        yield { type: "assistant", timestamp: `2026-07-13T01:${String(turn % 60).padStart(2, "0")}:01Z`, content: `回答 ${turn}` };
      }
    }

    const page = await selectTimelineEvents("s1", events(), { pageSize: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(consumed).toBe(3);
  });

  it("keeps event cursors stable when normalized content changes", async () => {
    const first = await selectTimelineEvents("s1", [
      { type: "user", timestamp: "2026-07-13T01:00:00Z", content: "旧内容" },
    ], { pageSize: 1 });
    const second = await selectTimelineEvents("s1", [
      { type: "user", timestamp: "2026-07-13T01:00:00Z", content: "新内容" },
    ], { pageSize: 1 });
    expect(first.items[0]?.eventId).toBe(second.items[0]?.eventId);
  });

  it("marks every text block in the final native assistant message as final", async () => {
    const page = await selectTimelineEvents("s1", [
      { type: "user", timestamp: "2026-07-13T01:00:00Z", content: "问题" },
      { type: "assistant", timestamp: "2026-07-13T01:00:01Z", content: "回答上半段" },
      { type: "assistant", timestamp: "2026-07-13T01:00:01Z", content: "回答下半段" },
    ], { pageSize: 10 });
    expect(page.items.map((item) => item.finalAssistant)).toEqual([false, true, true]);
  });

  it("pairs tool calls with results by call ID and paginates them as one step", async () => {
    const firstPage = await selectTimelineEvents("s1", [
      { type: "user", timestamp: "2026-07-13T01:00:00Z", content: "问题" },
      { type: "tool_call", timestamp: "2026-07-13T01:00:01Z", name: "first", callId: "c1", content: "input 1" },
      { type: "tool_call", timestamp: "2026-07-13T01:00:02Z", name: "second", callId: "c2", content: "input 2" },
      { type: "tool_result", timestamp: "2026-07-13T01:00:03Z", callId: "c2", content: "output 2" },
      { type: "tool_result", timestamp: "2026-07-13T01:00:04Z", callId: "c1", content: "output 1" },
      { type: "assistant", timestamp: "2026-07-13T01:00:05Z", content: "完成" },
    ], { pageSize: 2 });

    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.items.map((item) => item.stepNumber)).toEqual([1, 2]);
    expect(firstPage.items[1]?.event.name).toBe("first");
    expect(firstPage.items[1]?.pairedResult?.event.content).toBe("output 1");
    expect(firstPage.hasMore).toBe(true);

    const resultCursor = firstPage.items[1]?.pairedResult?.eventId;
    const secondPage = await selectTimelineEvents("s1", [
      { type: "user", timestamp: "2026-07-13T01:00:00Z", content: "问题" },
      { type: "tool_call", timestamp: "2026-07-13T01:00:01Z", name: "first", callId: "c1", content: "input 1" },
      { type: "tool_call", timestamp: "2026-07-13T01:00:02Z", name: "second", callId: "c2", content: "input 2" },
      { type: "tool_result", timestamp: "2026-07-13T01:00:03Z", callId: "c2", content: "output 2" },
      { type: "tool_result", timestamp: "2026-07-13T01:00:04Z", callId: "c1", content: "output 1" },
      { type: "assistant", timestamp: "2026-07-13T01:00:05Z", content: "完成" },
    ], { afterEventId: resultCursor, pageSize: 2 });
    expect(secondPage.items.map((item) => item.event.name ?? item.event.type)).toEqual(["second", "assistant"]);
    expect(secondPage.items[0]?.pairedResult?.event.content).toBe("output 2");
  });

  it("pairs a tool result across an intervening process message", async () => {
    const page = await selectTimelineEvents("s1", [
      { type: "user", timestamp: "2026-07-13T01:00:00Z", content: "问题" },
      { type: "tool_call", timestamp: "2026-07-13T01:00:01Z", name: "exec", callId: "c1", content: "input" },
      { type: "assistant", timestamp: "2026-07-13T01:00:02Z", content: "仍在处理" },
      { type: "tool_result", timestamp: "2026-07-13T01:00:03Z", callId: "c1", content: "output" },
      { type: "assistant", timestamp: "2026-07-13T01:00:04Z", content: "完成" },
    ], { pageSize: 10 });

    expect(page.items.map((item) => item.event.type)).toEqual([
      "user", "tool_call", "assistant", "assistant",
    ]);
    expect(page.items[1]?.pairedResult?.event.content).toBe("output");
    expect(page.items.some((item) => item.event.type === "tool_result")).toBe(false);
  });

  it("keeps tool pairing progressive on a long session", async () => {
    let consumed = 0;
    async function* events(): AsyncGenerator<TranscriptEvent> {
      consumed++;
      yield { type: "user", timestamp: "2026-07-13T01:00:00Z", content: "问题" };
      for (let index = 0; index < 1_000; index++) {
        consumed++;
        yield { type: "tool_call", callId: `c${index}`, content: `input ${index}` };
        consumed++;
        yield { type: "tool_result", callId: `c${index}`, content: `output ${index}` };
      }
    }

    const page = await selectTimelineEvents("s1", events(), { pageSize: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.items[1]?.pairedResult?.event.content).toBe("output 0");
    expect(page.hasMore).toBe(true);
    expect(consumed).toBe(5);
  });

  it("bounds unresolved tool calls instead of buffering the whole session", async () => {
    let consumed = 0;
    async function* events(): AsyncGenerator<TranscriptEvent> {
      consumed++;
      yield { type: "user", timestamp: "2026-07-13T01:00:00Z", content: "问题" };
      for (let index = 0; index < 1_000; index++) {
        consumed++;
        yield { type: "tool_call", callId: `c${index}`, content: `input ${index}` };
      }
    }

    const page = await selectTimelineEvents("s1", events(), { pageSize: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.items[1]?.pairingLimited).toBe(true);
    expect(page.hasMore).toBe(true);
    expect(consumed).toBeLessThanOrEqual(103);
  });

  it("lists linked archives, searches parsed events, and gets a complete event", async () => {
    const home = mkdtempSync(join(tmpdir(), "niubot-sessions-cli-"));
    tempDirs.push(home);
    const db = initDatabase(join(home, "niubot.db"));
    db.prepare("INSERT INTO users (id, platform, platform_id, name) VALUES ('u2', 'feishu', 'u2p', 'Zen')").run();
    db.prepare("INSERT INTO chats (id, platform, platform_id, type, user_id) VALUES ('c1', 'feishu', 'c1p', 'p2p', 'u2')").run();
    db.prepare(`
      INSERT INTO sessions (
        id, chat_id, user_id, source, status, backend_type, agent_session_id,
        started_at, ended_at, last_active_at, turn_count
      ) VALUES (
        's1', 'c1', 'u2', 'user', 'archived', 'codex', 'thread-1',
        '2026-07-13 01:00:00', '2026-07-13 02:00:00', '2026-07-13 02:00:00', 5
      )
    `).run();
    const messageId = storeMessage(db, {
      chatId: "c1", senderId: "u2", sessionId: "s1", role: "user",
      contentText: "查找唯一标记 NEEDLE_FULL_TEXT", platform: "feishu",
    });

    const native = join(home, "codex.jsonl");
    const longOutput = `LONG_OUTPUT ${"x".repeat(24_980)} TAIL_MARKER`;
    writeFileSync(native, [
      { type: "response_item", timestamp: "2026-07-13T00:59:58Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<recommended_plugins>internal plugin list</recommended_plugins>" }] } },
      { type: "response_item", timestamp: "2026-07-13T00:59:59Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<skill><name>internal</name><path>/private/skill</path></skill>" }] } },
      { type: "response_item", timestamp: "2026-07-13T01:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "查找唯一标记 NEEDLE_FULL_TEXT" }] } },
      { type: "response_item", timestamp: "2026-07-13T01:00:00Z", payload: { type: "function_call", name: "shell", call_id: "call--fence", arguments: '{"text":"FENCE_MARK\\n```"}' } },
      { type: "response_item", timestamp: "2026-07-13T01:00:02Z", payload: { type: "custom_tool_call_output", call_id: "long-output", output: longOutput } },
      { type: "response_item", timestamp: "2026-07-13T01:00:03Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "已经处理" }] } },
      { type: "response_item", timestamp: "2026-07-13T01:01:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "第二轮问题" }] } },
      { type: "response_item", timestamp: "2026-07-13T01:01:01Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `第二轮完成 ${"y".repeat(200)}` }] } },
      { type: "response_item", timestamp: "2026-07-13T01:02:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "第三轮问题" }] } },
      { type: "response_item", timestamp: "2026-07-13T01:02:01Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "第三轮完成" }] } },
      { type: "response_item", timestamp: "2026-07-13T01:03:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "第四轮问题" }] } },
      { type: "response_item", timestamp: "2026-07-13T01:03:01Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "第四轮完成" }] } },
      { type: "response_item", timestamp: "2026-07-13T01:04:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "中断问题" }] } },
      { type: "response_item", timestamp: "2026-07-13T01:04:01Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "中断过程标记" }] } },
      { type: "response_item", timestamp: "2026-07-13T01:04:02Z", payload: { type: "function_call", name: "shell", call_id: "call-interrupted", arguments: "{}" } },
      { type: "response_item", timestamp: "2026-07-13T01:04:03Z", payload: { type: "function_call_output", call_id: "call-interrupted", output: "done without final reply" } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const transcript = { ...readCodexTranscript(native, "thread-1"), sources: [{ path: native, role: "session" }] };
    const backend = { exportSessionTranscript: async () => transcript } as AgentBackend;
    await archiveAgentSession(home, backend, { id: "agent-1" }, {
      botId: "NiuBot", chatId: "c1", sessionId: "s1", source: "user", backend: "codex",
      startedAt: "2026-07-13 01:00:00", archivedAt: "2026-07-13 02:00:00",
    });

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values) => lines.push(values.join(" ")));
    await handleSessions(db, ["list"], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain(`[s1] [${expectedListRange("2026-07-13 01:00:00", "2026-07-13 02:00:00")}] 对话 · codex · 5轮`);
    expect(lines.join("\n")).toContain("概要: 问「查找唯一标记 NEEDLE_FULL_TEXT」→答「未回复」");
    expect(lines.join("\n")).not.toContain("source-reference");
    expect(lines.join("\n")).not.toContain("归档缺失");

    lines.length = 0;
    await handleSessions(db, ["search", "NEEDLE_FULL_TEXT"], "c1", "p2p", home, "NiuBot", parseArgs);
    const eventId = /\[event ([^\]]+)\]/.exec(lines[0] ?? "")?.[1];
    expect(eventId).toMatch(/^s1:e[0-9a-f]{12}$/);
    expect(lines[0]).toContain(`[message #${messageId}]`);
    expect(lines.join("\n")).toContain("查找唯一标记 NEEDLE_FULL_TEXT");

    lines.length = 0;
    await handleSessions(db, [
      "search", "NEEDLE_FULL_TEXT",
      "--since", "2026-07-13T01:00:00Z",
      "--before", "2026-07-13T01:00:01Z",
    ], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("NEEDLE_FULL_TEXT");

    lines.length = 0;
    await handleSessions(db, [
      "search", "NEEDLE_FULL_TEXT",
      "--before", "2026-07-13T01:00:00Z",
    ], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines).toEqual(["(无匹配 transcript 事件)"]);

    lines.length = 0;
    await handleSessions(db, ["get", eventId!], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("查找唯一标记 NEEDLE_FULL_TEXT");
    expect(lines.join("\n")).toContain(`event_id: ${eventId}`);

    lines.length = 0;
    await handleSessions(db, ["get", "s1"], "c1", "p2p", home, "NiuBot", parseArgs);
    const firstTurn = localParts("2026-07-13 01:00:00");
    const secondTurn = localParts("2026-07-13 01:01:00");
    expect(lines.join("\n")).toContain(`Timezone: ${TZ}`);
    expect(lines.join("\n")).toContain(`Session s1 · codex · ${expectedSessionRange("2026-07-13 01:00:00", "2026-07-13 02:00:00")}`);
    expect(lines.join("\n")).toContain("步骤 1～10");
    expect(lines.join("\n").match(new RegExp(`${firstTurn.date} · 第`, "g"))).toHaveLength(1);
    expect(lines.join("\n")).toContain("\n第 2 轮\n");
    expect(lines.join("\n")).toContain("本页显示 10 步，还有更多");
    expect(lines.join("\n")).toContain("下一页：/nbt sessions get s1 --after-event");

    lines.length = 0;
    await handleSessions(db, ["get", "s1", "--page-size", "3", "--event-chars", "200"], "c1", "p2p", home, "NiuBot", parseArgs);
    const timelinePage = lines.join("\n");
    expect(timelinePage).toContain("步骤 1～3");
    expect(timelinePage).toContain(`${firstTurn.date} · 第 1 轮`);
    expect(timelinePage).toContain(`[1] [${firstTurn.time}] 用户: 查找唯一标记 NEEDLE_FULL_TEXT`);
    expect(timelinePage).toContain(`[2] [${firstTurn.time}] shell:\n调用：`);
    expect(timelinePage).toContain("结果：未返回");
    expect(timelinePage).toContain(`[3] [${firstTurn.time}] 工具结果（未找到对应调用）:`);
    expect(timelinePage).toContain("LONG_OUTPUT");
    expect(timelinePage).toContain("〔内容已截断：/nbt sessions get s1:");
    expect(timelinePage).toContain("--after-event");
    expect(timelinePage).not.toContain("event=");
    expect(timelinePage).not.toContain("TAIL_MARKER");
    expect(timelinePage).not.toContain("recommended_plugins");

    lines.length = 0;
    await handleSessions(db, ["get", "s1", "--summary"], "c1", "p2p", home, "NiuBot", parseArgs);
    const summaryPage = lines.join("\n");
    expect(summaryPage).toContain(`Timezone: ${TZ}`);
    expect(summaryPage).toContain(`Session s1 · codex · ${expectedSessionRange("2026-07-13 01:00:00", "2026-07-13 02:00:00")}`);
    expect(summaryPage).toContain(`## ${firstTurn.date} · 第 1 轮 · ${firstTurn.time}`);
    expect(summaryPage).toContain(`## 第 2 轮 · ${secondTurn.time}`);
    expect(summaryPage).not.toContain(`(${TZ})`);
    expect(summaryPage).toContain("范围：第 1～2 轮，共 5 轮");
    expect(summaryPage).toContain("用户：\n查找唯一标记 NEEDLE_FULL_TEXT");
    expect(summaryPage).toContain("工具调用 1 次：shell ×1");
    expect(summaryPage).toContain("NiuBot：\n已经处理");
    expect(summaryPage).toContain("--summary --after-turn 2 --page-size 2");
    expect(summaryPage).not.toContain("recommended_plugins");
    expect(summaryPage).not.toContain("LONG_OUTPUT");

    lines.length = 0;
    await handleSessions(db, ["get", "s1", "--summary", "--after-turn", "2"], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("范围：第 3～4 轮，共 5 轮");
    expect(lines.join("\n")).toContain("第四轮问题");

    lines.length = 0;
    await handleSessions(db, ["get", "s1", "--summary", "--turn", "5"], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("过程消息 1 条，已折叠");
    expect(lines.join("\n")).toContain("NiuBot：\n（本轮没有最终回复）");
    expect(lines.join("\n")).not.toContain("NiuBot：\n中断过程标记");

    lines.length = 0;
    await handleSessions(db, ["get", "s1", "--turn", "5", "--page-size", "10"], "c1", "p2p", home, "NiuBot", parseArgs);
    const pairedToolPage = lines.join("\n");
    expect(pairedToolPage).toContain("shell:\n调用：");
    expect(pairedToolPage).toContain("结果：\n```text\ndone without final reply");
    expect(pairedToolPage).not.toContain("结果：未返回");

    lines.length = 0;
    await handleSessions(db, ["search", "中断过程标记", "--messages-only"], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines).toEqual(["(无匹配 transcript 事件)"]);

    lines.length = 0;
    await handleSessions(db, ["search", "中断过程标记"], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("中断过程标记");

    lines.length = 0;
    await handleSessions(db, ["get", "s1", "--summary", "--max-chars", "100"], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("分页游标未推进");
    expect(lines.join("\n")).toContain("--summary --after-turn 1 --page-size 2 --max-chars 200");
    expect(lines.join("\n")).not.toContain("下一页：/nbt sessions get s1 --after-turn 2");

    lines.length = 0;
    await handleSessions(db, ["get", "s1", "--turn", "1", "--verbose", "--max-chars", "30000"], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain(`[2] [${firstTurn.time}] shell:`);
    expect(lines.join("\n")).toContain("event=s1:");
    expect(lines.join("\n")).toContain("call=call--fence");
    expect(lines.join("\n")).toContain("LONG_OUTPUT");
    expect(lines.join("\n")).toContain(`[4] [${firstTurn.time}] 最终回复: 已经处理`);

    lines.length = 0;
    await handleSessions(db, ["get", "s1", "--turn", "1", "--verbose", "--event-page-size", "2"], "c1", "p2p", home, "NiuBot", parseArgs);
    const verboseFirstPage = lines.join("\n");
    const eventCursor = /--after-event ([^ ]+)/.exec(verboseFirstPage)?.[1];
    expect(verboseFirstPage).toContain("步骤 1～2 · 第 1 轮");
    expect(verboseFirstPage).toContain("本页显示 2 步，还有更多");
    expect(eventCursor).toBeTruthy();
    expect(verboseFirstPage).not.toContain("LONG_OUTPUT");

    lines.length = 0;
    await handleSessions(db, [
      "get", "s1", "--turn", "1", "--verbose",
      "--after-event", eventCursor!, "--event-page-size", "2", "--max-chars", "30000",
    ], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("LONG_OUTPUT");
    expect(lines.join("\n")).toContain("本页显示 2 步，已到最后一步");

    lines.length = 0;
    await handleSessions(db, [
      "get", "s1", "--turn", "1", "--verbose",
      "--after-event", eventCursor!, "--event-page-size", "2", "--max-chars", "1000",
    ], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("〔内容已截断：");
    expect(lines.join("\n")).toContain("下一页：");

    lines.length = 0;
    await handleSessions(db, ["search", "FENCE_MARK", "--messages-only"], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines).toEqual(["(无匹配 transcript 事件)"]);

    lines.length = 0;
    await handleSessions(db, ["search", "FENCE_MARK"], "c1", "p2p", home, "NiuBot", parseArgs);
    const fenceEventId = /\[event ([^\]]+)\]/.exec(lines[0] ?? "")?.[1];
    lines.length = 0;
    await handleSessions(db, ["get", fenceEventId!], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("````text");
    expect(lines.join("\n")).toContain("call_id: call—fence");

    lines.length = 0;
    await handleSessions(db, ["search", "FENCE_MARK", "--include-tools", "-n", "1"], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("FENCE_MARK");
    expect(lines.join("\n")).toContain("本页 1 条");

    lines.length = 0;
    await handleSessions(db, ["search", "LONG_OUTPUT", "--include-tools"], "c1", "p2p", home, "NiuBot", parseArgs);
    const longEventId = /\[event ([^\]]+)\]/.exec(lines[0] ?? "")?.[1];
    lines.length = 0;
    await handleSessions(db, ["get", longEventId!], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("内容已截断");
    expect(lines.join("\n")).not.toContain("TAIL_MARKER");

    lines.length = 0;
    await handleSessions(db, ["get", longEventId!, "--max-chars", "30000"], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("TAIL_MARKER");
    expect(lines.join("\n")).not.toContain("内容已截断");

    lines.length = 0;
    await handleSessions(db, ["search", "轮", "-n", "2"], "c1", "p2p", home, "NiuBot", parseArgs);
    const firstSearchPage = lines.join("\n");
    const searchCursor = /--after ([^ ]+)/.exec(firstSearchPage)?.[1];
    expect(firstSearchPage).toContain("本页 2 条，还有更多");
    expect(searchCursor).toBeTruthy();

    lines.length = 0;
    await handleSessions(db, ["search", "轮", "-n", "2", "--after", searchCursor!], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("本页 2 条，还有更多");
    expect(lines.join("\n")).not.toEqual(firstSearchPage);

    await expect(handleSessions(db, ["get", "s1", "--raw"], "c1", "p2p", home, "NiuBot", parseArgs))
      .rejects.toThrow("--raw is not supported");
    await expect(handleSessions(db, ["list", "--chat-id", "private-chat"], "c1", "group", home, "NiuBot", parseArgs))
      .rejects.toThrow("cross-chat query is not allowed in group chat");
    db.close();
  });

  it("keeps a real context-shaped user message while hiding synthetic context", async () => {
    const home = mkdtempSync(join(tmpdir(), "niubot-sessions-context-message-"));
    tempDirs.push(home);
    const db = initDatabase(join(home, "niubot.db"));
    db.prepare("INSERT INTO users (id, platform, platform_id, name) VALUES ('u2', 'feishu', 'u2p', 'Zen')").run();
    db.prepare("INSERT INTO chats (id, platform, platform_id, type, user_id) VALUES ('c1', 'feishu', 'c1p', 'p2p', 'u2')").run();
    db.prepare(`
      INSERT INTO sessions (
        id, chat_id, user_id, source, status, backend_type, agent_session_id,
        started_at, ended_at, last_active_at
      ) VALUES (
        'literal', 'c1', 'u2', 'user', 'archived', 'codex', 'agent-literal',
        '2026-07-13 01:00:00', '2026-07-13 01:10:00', '2026-07-13 01:10:00'
      )
    `).run();
    const literal = "<skill><name>literal</name></skill>";
    storeMessage(db, {
      chatId: "c1", senderId: "u2", sessionId: "literal", role: "user",
      contentText: literal, platform: "feishu",
    });

    const native = join(home, "literal.jsonl");
    writeFileSync(native, [
      { type: "response_item", timestamp: "2026-07-13T01:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<recommended_plugins>synthetic</recommended_plugins>" }] } },
      { type: "response_item", timestamp: "2026-07-13T01:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: literal }] } },
      { type: "response_item", timestamp: "2026-07-13T01:00:02Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `<niubot-system-rules>private</niubot-system-rules>\n\n${wrapInjectedUserMessage(literal)}` }] } },
      { type: "response_item", timestamp: "2026-07-13T01:00:03Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "已保留" }] } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const transcript = { ...readCodexTranscript(native, "agent-literal"), sources: [{ path: native, role: "session" }] };
    const backend = { exportSessionTranscript: async () => transcript } as AgentBackend;
    await archiveAgentSession(home, backend, { id: "agent-literal" }, {
      botId: "NiuBot", chatId: "c1", sessionId: "literal", source: "user", backend: "codex",
      startedAt: "2026-07-13 01:00:00", archivedAt: "2026-07-13 01:10:00",
    });

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values) => lines.push(values.join(" ")));
    await handleSessions(db, ["get", "literal"], "c1", "p2p", home, "NiuBot", parseArgs);
    const output = lines.join("\n");
    expect(output.match(new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
    expect(output).not.toContain("recommended_plugins");
    expect(output).toContain("已保留");

    lines.length = 0;
    await handleSessions(db, ["get", "literal", "--format", "jsonl"], "c1", "p2p", home, "NiuBot", parseArgs);
    const literalEvents = lines
      .map((line) => JSON.parse(line) as { type: string; content: string; timestamp?: string })
      .filter((event) => event.type === "user" && event.content === literal);
    expect(literalEvents).toEqual([expect.objectContaining({ timestamp: "2026-07-13T01:00:02Z" })]);
    db.close();
  });

  it("paginates session lists with a stable session cursor", async () => {
    const home = mkdtempSync(join(tmpdir(), "niubot-sessions-list-"));
    tempDirs.push(home);
    const db = initDatabase(join(home, "niubot.db"));
    db.prepare("INSERT INTO users (id, platform, platform_id, name) VALUES ('u2', 'feishu', 'u2p', 'Zen')").run();
    db.prepare("INSERT INTO chats (id, platform, platform_id, type, user_id) VALUES ('c1', 'feishu', 'c1p', 'p2p', 'u2')").run();
    const insert = db.prepare(`
      INSERT INTO sessions (
        id, chat_id, user_id, source, status, backend_type, agent_session_id,
        started_at, ended_at, last_active_at, turn_count
      ) VALUES (?, 'c1', 'u2', ?, 'archived', 'codex', ?, ?, ?, ?, ?)
    `);
    insert.run("s1", "user", "a1", "2026-07-13 01:00:00", "2026-07-13 01:10:00", "2026-07-13 01:10:00", 3);
    insert.run("s2", "cron", "a2", "2026-07-13 02:00:00", "2026-07-13 02:00:00", "2026-07-13 02:00:00", 1);
    insert.run("s3", "task", "a3", "2026-07-12 03:00:00", "2026-07-13 03:10:00", "2026-07-13 03:10:00", 1);
    storeMessage(db, {
      chatId: "c1", senderId: "u2", sessionId: "s3", role: "assistant",
      contentText: "没有前置用户消息的系统回复", platform: "feishu",
    });
    storeMessage(db, {
      chatId: "c1", senderId: "u2", sessionId: "s3", role: "user",
      contentText: "旧 prompt", platform: "feishu",
    });
    storeMessage(db, {
      chatId: "c1", senderId: "u2", sessionId: "s3", role: "assistant",
      contentText: "旧 response", platform: "feishu",
    });
    storeMessage(db, {
      chatId: "c1", senderId: "u2", sessionId: "s3", role: "user",
      contentText: "最后的 user prompt\n第二行", platform: "feishu",
    });
    storeMessage(db, {
      chatId: "c1", senderId: "u2", sessionId: "s3", role: "assistant",
      contentText: "最后的 response", platform: "feishu",
    });
    storeMessage(db, {
      chatId: "c1", senderId: "u2", sessionId: "s2", role: "user",
      contentText: "已回复的 prompt", platform: "feishu",
    });
    storeMessage(db, {
      chatId: "c1", senderId: "u2", sessionId: "s2", role: "assistant",
      contentText: "上一轮 response", platform: "feishu",
    });
    storeMessage(db, {
      chatId: "c1", senderId: "u2", sessionId: "s2", role: "user",
      contentText: "尚未回复的 prompt", platform: "feishu",
    });

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values) => lines.push(values.join(" ")));
    await handleSessions(db, ["list", "-n", "2"], "c1", "p2p", home, "NiuBot", parseArgs);
    const firstPage = lines.join("\n");
    const pageDate = localParts("2026-07-13 03:10:00").date;
    expect(firstPage).toContain(`Timezone: ${TZ}`);
    expect(firstPage.match(new RegExp(pageDate, "g"))).toHaveLength(1);
    expect(firstPage).toContain(`[s3] [${expectedListRange("2026-07-12 03:00:00", "2026-07-13 03:10:00")}] 后台任务 · codex · 1轮 · 归档缺失`);
    expect(firstPage).toContain(`[s2] [${expectedListRange("2026-07-13 02:00:00", "2026-07-13 02:00:00")}] 定时任务 · codex · 1轮 · 归档缺失`);
    expect(firstPage).not.toContain("[s1]");
    expect(firstPage).toContain("概要: 首问「旧 prompt」→首答「旧 response」；末问「最后的 user prompt 第二行」→末答「最后的 response」");
    expect(firstPage).not.toContain("没有前置用户消息的系统回复");
    expect(firstPage).toContain("概要: 问「已回复的 prompt」→答「上一轮 response」");
    expect(firstPage).not.toContain("尚未回复的 prompt");
    expect(firstPage).not.toContain("backend=");
    expect(firstPage).not.toContain("archive=");
    expect(firstPage).toContain("/nbt sessions list --after s2 -n 2");
    for (const line of lines.filter((line) => line.trimStart().startsWith("概要:"))) {
      expect([...line.trimStart()].length).toBeLessThanOrEqual(180);
    }

    lines.length = 0;
    await handleSessions(db, ["list", "-n", "2", "--after", "s2"], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain(`[s1] [${expectedListRange("2026-07-13 01:00:00", "2026-07-13 01:10:00")}] 对话 · codex · 3轮 · 归档缺失`);
    expect(lines.join("\n")).toContain("概要: 问「未记录」→答「未回复」");
    expect(lines.join("\n")).toContain("已到最后一页");
    db.close();
  });

  it("keeps search pagination anchored when newer sessions are archived", async () => {
    const home = mkdtempSync(join(tmpdir(), "niubot-sessions-search-cursor-"));
    tempDirs.push(home);
    const db = initDatabase(join(home, "niubot.db"));
    db.prepare("INSERT INTO users (id, platform, platform_id, name) VALUES ('u2', 'feishu', 'u2p', 'Zen')").run();
    db.prepare("INSERT INTO chats (id, platform, platform_id, type, user_id) VALUES ('c1', 'feishu', 'c1p', 'p2p', 'u2')").run();
    await addArchivedCodexSession(
      db, home, "s1", "2026-07-13 01:00:00", "2026-07-13 01:10:00",
      "2026-07-13T01:09:00Z", "稳定游标 s1",
    );
    await addArchivedCodexSession(
      db, home, "s2", "2026-07-13 02:00:00", "2026-07-13 02:10:00",
      "2026-07-13T02:09:00Z", "稳定游标 s2",
    );

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values) => lines.push(values.join(" ")));
    await handleSessions(db, ["search", "稳定游标", "-n", "1", "--sessions", "2"], "c1", "p2p", home, "NiuBot", parseArgs);
    const firstPage = lines.join("\n");
    const eventCursor = /--after ([^ ]+)/.exec(firstPage)?.[1];
    const throughSession = /--through-session ([^ ]+)/.exec(firstPage)?.[1];
    expect(firstPage).toContain("稳定游标 s2");
    expect(eventCursor).toBeTruthy();
    expect(throughSession).toBe("s2");

    writeFileSync(join(home, "s2.jsonl"), [
      { type: "response_item", timestamp: "2026-07-13T02:09:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "问题 s2" }] } },
      { type: "response_item", timestamp: "2026-07-13T02:09:00Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "正文已经变化" }] } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");

    await addArchivedCodexSession(
      db, home, "s3", "2026-07-13 03:00:00", "2026-07-13 03:10:00",
      "2026-07-13T03:09:00Z", "稳定游标 s3",
    );
    lines.length = 0;
    await handleSessions(db, [
      "search", "稳定游标", "-n", "1", "--sessions", "2",
      "--after", eventCursor!, "--through-session", throughSession!,
    ], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("稳定游标 s1");
    expect(lines.join("\n")).not.toContain("稳定游标 s3");
    db.close();
  });
});
