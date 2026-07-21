import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBackend, TranscriptEvent } from "../agent/types.js";
import { initDatabase, storeMessage } from "../database/schema.js";
import { archiveAgentSession } from "../session-archive/archive.js";
import { readCodexTranscript, wrapInjectedUserMessage } from "../session-archive/native-transcript.js";
import { parseArgs } from "./args.js";
import { handleSessions, markdownCodeFence, selectTimelineEvents } from "./session.js";

const tempDirs: string[] = [];
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

  it("lists linked archives, searches parsed events, and gets a complete event", async () => {
    const home = mkdtempSync(join(tmpdir(), "niubot-sessions-cli-"));
    tempDirs.push(home);
    const db = initDatabase(join(home, "niubot.db"));
    db.prepare("INSERT INTO users (id, platform, platform_id, name) VALUES ('u2', 'feishu', 'u2p', 'Zen')").run();
    db.prepare("INSERT INTO chats (id, platform, platform_id, type, user_id) VALUES ('c1', 'feishu', 'c1p', 'p2p', 'u2')").run();
    db.prepare(`
      INSERT INTO sessions (
        id, chat_id, user_id, source, status, backend_type, agent_session_id,
        started_at, ended_at, last_active_at
      ) VALUES (
        's1', 'c1', 'u2', 'user', 'archived', 'codex', 'thread-1',
        '2026-07-13 01:00:00', '2026-07-13 02:00:00', '2026-07-13 02:00:00'
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
    expect(lines.join("\n")).toContain("archive=source-reference");

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
    expect(lines.join("\n")).toContain("范围：第 1～10 步");
    expect(lines.join("\n")).toContain("本页显示 10 步，还有更多");
    expect(lines.join("\n")).toContain("下一页：/nbt sessions get s1 --after-event");

    lines.length = 0;
    await handleSessions(db, ["get", "s1", "--page-size", "3", "--event-chars", "200"], "c1", "p2p", home, "NiuBot", parseArgs);
    const timelinePage = lines.join("\n");
    expect(timelinePage).toContain("视图：执行过程");
    expect(timelinePage).toContain("范围：第 1～3 步");
    expect(timelinePage).toContain("步骤 1 · 用户输入");
    expect(timelinePage).toContain("步骤 2 · 工具调用 · shell");
    expect(timelinePage).toContain("步骤 3 · 工具结果");
    expect(timelinePage).toContain("LONG_OUTPUT");
    expect(timelinePage).toContain("展开该步骤：/nbt sessions get s1:");
    expect(timelinePage).toContain("--after-event");
    expect(timelinePage).not.toContain("TAIL_MARKER");
    expect(timelinePage).not.toContain("recommended_plugins");

    lines.length = 0;
    await handleSessions(db, ["get", "s1", "--summary"], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("范围：第 1～2 轮，共 5 轮");
    expect(lines.join("\n")).toContain("用户：\n查找唯一标记 NEEDLE_FULL_TEXT");
    expect(lines.join("\n")).toContain("工具调用 1 次：shell ×1");
    expect(lines.join("\n")).toContain("NiuBot：\n已经处理");
    expect(lines.join("\n")).toContain("--summary --after-turn 2 --page-size 2");
    expect(lines.join("\n")).not.toContain("recommended_plugins");
    expect(lines.join("\n")).not.toContain("LONG_OUTPUT");

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
    expect(lines.join("\n")).toContain("步骤 2 · 工具调用 · shell");
    expect(lines.join("\n")).toContain("LONG_OUTPUT");
    expect(lines.join("\n")).toContain("步骤 4 · 最终回复");

    lines.length = 0;
    await handleSessions(db, ["get", "s1", "--turn", "1", "--verbose", "--event-page-size", "2"], "c1", "p2p", home, "NiuBot", parseArgs);
    const verboseFirstPage = lines.join("\n");
    const eventCursor = /--after-event ([^ ]+)/.exec(verboseFirstPage)?.[1];
    expect(verboseFirstPage).toContain("范围：第 1 轮，第 1～2 步");
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
    expect(lines.join("\n")).toContain("展开该步骤：");
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
        started_at, ended_at, last_active_at
      ) VALUES (?, 'c1', 'u2', 'user', 'archived', 'codex', ?, ?, ?, ?)
    `);
    insert.run("s1", "a1", "2026-07-13 01:00:00", "2026-07-13 01:10:00", "2026-07-13 01:10:00");
    insert.run("s2", "a2", "2026-07-13 02:00:00", "2026-07-13 02:10:00", "2026-07-13 02:10:00");
    insert.run("s3", "a3", "2026-07-13 03:00:00", "2026-07-13 03:10:00", "2026-07-13 03:10:00");

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values) => lines.push(values.join(" ")));
    await handleSessions(db, ["list", "-n", "2"], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("[s3]");
    expect(lines.join("\n")).toContain("[s2]");
    expect(lines.join("\n")).not.toContain("[s1]");
    expect(lines.join("\n")).toContain("/nbt sessions list --after s2 -n 2");

    lines.length = 0;
    await handleSessions(db, ["list", "-n", "2", "--after", "s2"], "c1", "p2p", home, "NiuBot", parseArgs);
    expect(lines.join("\n")).toContain("[s1]");
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
