import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../database/schema.js";
import { getMessageForAccess, listContinuationMessages, listMessages, searchMessages } from "../messages/store.js";
import { TZ, userTimeRangeToUtc, utcToLocalDateTime } from "../tz.js";
import { parseArgs } from "./args.js";
import { formatMessagesForList, handleMessages } from "./messages.js";

const tempDirs: string[] = [];
const openDatabases: Database.Database[] = [];

beforeEach(() => {
  // 测试进程可能继承宿主的话题隔离变量；明确清除，避免把查询默认限制到
  // 一个不存在的 thread_id。
  vi.stubEnv("NIUBOT_THREAD_ID", "");
  vi.stubEnv("NIUBOT_SCOPE_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const db of openDatabases.splice(0)) {
    if (db.open) db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function setupDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-message-store-"));
  tempDirs.push(dir);
  const db = initDatabase(path.join(dir, "niubot.db"));
  openDatabases.push(db);
  db.prepare("INSERT INTO users (id, name, platform, platform_id) VALUES ('u2', 'Zen', 'feishu', 'p2')").run();
  db.prepare("INSERT INTO chats (id, type, platform, platform_id) VALUES ('c1', 'group', 'feishu', 'pc1')").run();
  db.prepare("INSERT INTO chats (id, type, platform, platform_id) VALUES ('c2', 'p2p', 'feishu', 'pc2')").run();
  db.prepare("INSERT INTO messages (id, chat_id, sender_id, role, content_text, content_type, platform) VALUES (1, 'c1', 'u2', 'user', 'current chat text', 'text', 'feishu')").run();
  db.prepare("INSERT INTO messages (id, chat_id, sender_id, role, content_text, content_type, platform) VALUES (2, 'c2', 'u2', 'user', 'other chat text', 'text', 'feishu')").run();
  db.prepare("INSERT INTO messages_fts (rowid, content_text) VALUES (1, 'current chat text')").run();
  db.prepare("INSERT INTO messages_fts (rowid, content_text) VALUES (2, 'other chat text')").run();
  return db;
}

describe("message access rules", () => {
  it("groups message list output by local date and only labels timezone once", () => {
    const lines = formatMessagesForList([
      {
        id: 1,
        chat_id: "c1",
        sender_id: "u2",
        sender_name: "Zen",
        role: "user",
        content_text: "first",
        content_type: "text",
        created_at: "2026-04-24 16:12:00",
      },
      {
        id: 2,
        chat_id: "c1",
        sender_id: "u3",
        sender_name: "NiuBot",
        role: "assistant",
        content_text: "second",
        content_type: "text",
        created_at: "2026-04-24 16:13:00",
      },
    ]);

    const [date, time] = utcToLocalDateTime("2026-04-24 16:12:00").split(" ");

    expect(lines[0]).toBe(`Timezone: ${TZ}`);
    expect(lines).toContain(date);
    expect(lines.join("\n")).toContain(`[#1] [${time}] U2(Zen) (user): first`);
    expect(lines.join("\n")).not.toContain(`[#1] [${date} ${time}`);
  });

  it("blocks group all-chat search", () => {
    const db = setupDb();

    expect(() => searchMessages(db, {
      query: "text",
      searchAll: true,
      currentChatId: "c1",
      chatType: "group",
      limit: 10,
    })).toThrow("cross-chat query is not allowed in group chat");
  });

  it("blocks group get by id when the message belongs to another chat", () => {
    const db = setupDb();

    expect(() => getMessageForAccess(db, 2, {
      currentChatId: "c1",
      chatType: "group",
    })).toThrow("cross-chat query is not allowed in group chat");
  });

  it("blocks group get by id when current chat is missing", () => {
    const db = setupDb();

    expect(() => getMessageForAccess(db, 2, {
      chatType: "group",
    })).toThrow("NIUBOT_CHAT_ID not set");
  });

  it("requires target chat for scoped searches", () => {
    const db = setupDb();

    expect(() => searchMessages(db, {
      query: "text",
      searchAll: false,
      chatType: "p2p",
      limit: 10,
    })).toThrow("targetChatId is required unless searchAll is true");
  });

  it("interprets date filters as local calendar boundaries before querying UTC", () => {
    const db = setupDb();
    const range = userTimeRangeToUtc({ since: "2026-07-20", before: "2026-07-21" });
    db.prepare("UPDATE messages SET created_at = ? WHERE id = 2").run(range.since);

    expect(listMessages(db, {
      currentChatId: "c2",
      chatType: "p2p",
      targetChatId: "c2",
      limit: 10,
      since: "2026-07-20",
      before: "2026-07-21",
    }).map((row) => row.id)).toEqual([2]);
  });

  it("lists by original time so a later-synced old message is not the newest", () => {
    const db = setupDb();
    db.prepare(
      "INSERT INTO messages (id, chat_id, sender_id, role, content_text, content_type, platform, platform_msg_id, platform_ts, created_at) VALUES (10, 'c1', 'u2', 'user', 'old synced', 'text', 'feishu', 'om-old', '2020-01-01 00:00:00', '2020-01-01 00:00:00')",
    ).run();
    db.prepare(
      "INSERT INTO messages (id, chat_id, sender_id, role, content_text, content_type, platform, created_at) VALUES (11, 'c1', 'u2', 'user', 'new local', 'text', 'feishu', '2099-01-01 00:00:00')",
    ).run();

    expect(listMessages(db, {
      currentChatId: "c1",
      chatType: "group",
      targetChatId: "c1",
      limit: 1,
    }).map((row) => row.content_text)).toEqual(["new local"]);
    expect(listContinuationMessages(db, { chatId: "c1", limit: 1 }).map((row) => row.content_text))
      .toEqual(["new local"]);
  });

  it("binds thread filter before id cutoff so topic continuation is not empty", () => {
    const db = setupDb();
    db.prepare(
      "INSERT INTO messages (id, chat_id, sender_id, role, content_text, content_type, platform, thread_id) VALUES (10, 'c1', 'u2', 'user', 'keep-a-old', 'text', 'feishu', 'omt_a')",
    ).run();
    db.prepare(
      "INSERT INTO messages (id, chat_id, sender_id, role, content_text, content_type, platform, thread_id) VALUES (11, 'c1', 'u2', 'user', 'other-thread', 'text', 'feishu', 'omt_b')",
    ).run();
    db.prepare(
      "INSERT INTO messages (id, chat_id, sender_id, role, content_text, content_type, platform, thread_id) VALUES (12, 'c1', 'u2', 'user', 'keep-a-recent', 'text', 'feishu', 'omt_a')",
    ).run();
    db.prepare(
      "INSERT INTO messages (id, chat_id, sender_id, role, content_text, content_type, platform, thread_id) VALUES (13, 'c1', 'u2', 'user', 'current-excluded', 'text', 'feishu', 'omt_a')",
    ).run();

    expect(listContinuationMessages(db, {
      chatId: "c1",
      threadId: "omt_a",
      beforeMsgId: 13,
      limit: 10,
    }).map((row) => row.content_text)).toEqual(["keep-a-old", "keep-a-recent"]);
  });

  it("limits main-thread continuation to rows without thread_id", () => {
    const db = setupDb();
    db.prepare(
      "INSERT INTO messages (id, chat_id, sender_id, role, content_text, content_type, platform, thread_id) VALUES (30, 'c1', 'u2', 'user', 'topic-only', 'text', 'feishu', 'omt_x')",
    ).run();

    expect(listContinuationMessages(db, { chatId: "c1", limit: 10 }).map((row) => row.content_text))
      .toEqual(["current chat text", "topic-only"]);
    expect(listContinuationMessages(db, { chatId: "c1", mainThreadOnly: true, limit: 10 }).map((row) => row.content_text))
      .toEqual(["current chat text"]);
  });

  it("defaults message list to the main thread when no thread is selected", () => {
    const db = setupDb();
    db.prepare(
      "INSERT INTO messages (id, chat_id, sender_id, role, content_text, content_type, platform, thread_id) VALUES (20, 'c1', 'u2', 'user', 'topic-only', 'text', 'feishu', 'omt_x')",
    ).run();

    expect(listMessages(db, {
      currentChatId: "c1",
      chatType: "group",
      targetChatId: "c1",
      limit: 10,
    }).map((row) => row.content_text)).toEqual(["current chat text"]);
    expect(listMessages(db, {
      currentChatId: "c1",
      chatType: "group",
      targetChatId: "c1",
      allThreads: true,
      limit: 10,
    }).map((row) => row.content_text)).toEqual(["current chat text", "topic-only"]);
  });

  it("keeps Cron internal prompts in the session transcript but out of normal messages", () => {
    const db = setupDb();
    db.prepare(`
      INSERT INTO sessions (id, chat_id, user_id, source, status)
      VALUES ('cron-session', 'c1', 'u2', 'cron', 'archived')
    `).run();
    db.prepare(`
      INSERT INTO messages (id, chat_id, sender_id, session_key, role, content_text, content_type, platform)
      VALUES (3, 'c1', 'u2', 'cron-session', 'user', 'INTERNAL_CRON_PROMPT', 'internal_prompt', 'feishu')
    `).run();
    db.prepare("INSERT INTO messages_fts (rowid, content_text) VALUES (3, 'INTERNAL_CRON_PROMPT')").run();

    expect(listMessages(db, {
      currentChatId: "c1", chatType: "group", targetChatId: "c1", limit: 10,
    }).map((row) => row.id)).toEqual([1]);
    expect(searchMessages(db, {
      query: "INTERNAL_CRON_PROMPT", currentChatId: "c1", chatType: "group", targetChatId: "c1", limit: 10,
    })).toEqual([]);
    expect(getMessageForAccess(db, 3, { currentChatId: "c1", chatType: "group" })).toBeUndefined();
    expect(listContinuationMessages(db, { chatId: "c1", limit: 10 }).map((row) => row.content_text))
      .not.toContain("INTERNAL_CRON_PROMPT");
    expect(db.prepare("SELECT content_text FROM messages WHERE session_key = 'cron-session'").get())
      .toEqual({ content_text: "INTERNAL_CRON_PROMPT" });
  });
});

describe("handleMessages group sync", () => {
  it("defaults a topic group query to the current thread and labels it", async () => {
    const db = setupDb();
    vi.stubEnv("NIUBOT_THREAD_ID", "omt_aaa");
    db.prepare(
      "INSERT INTO messages (id, chat_id, sender_id, role, content_text, content_type, platform, thread_id) VALUES (10, 'c1', 'u2', 'user', 'topic a', 'text', 'feishu', 'omt_aaa')",
    ).run();
    db.prepare(
      "INSERT INTO messages (id, chat_id, sender_id, role, content_text, content_type, platform, thread_id) VALUES (11, 'c1', 'u2', 'user', 'topic b', 'text', 'feishu', 'omt_bbb')",
    ).run();

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values) => lines.push(values.join(" ")));
    try {
      await handleMessages(db, ["list", "-n", "20"], "c1", "group", parseArgs);
    } finally {
      vi.restoreAllMocks();
    }
    expect(lines.join("\n")).toContain("当前话题：omt_aaa");
    expect(lines.join("\n")).toContain("topic a");
    expect(lines.join("\n")).not.toContain("topic b");
  });

  it("lists thread replies in ordinary groups without --all-threads", async () => {
    const db = setupDb();
    db.prepare(
      "INSERT INTO messages (id, chat_id, sender_id, role, content_text, content_type, platform, thread_id) VALUES (10, 'c1', 'u2', 'user', 'reply-thread', 'text', 'feishu', 'omt_reply')",
    ).run();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values) => lines.push(values.join(" ")));
    try {
      await handleMessages(db, ["list", "-n", "20"], "c1", "group", parseArgs);
    } finally {
      vi.restoreAllMocks();
    }
    expect(lines.join("\n")).toContain("reply-thread");
    expect(lines.join("\n")).toContain("current chat text");
  });

  it("keeps isolated topic 主群 list off other threads", async () => {
    const db = setupDb();
    db.prepare("UPDATE chats SET chat_mode = 'topic', group_message_type = 'thread' WHERE id = 'c1'").run();
    db.prepare(
      "INSERT INTO messages (id, chat_id, sender_id, role, content_text, content_type, platform, thread_id) VALUES (10, 'c1', 'u2', 'user', 'topic-only', 'text', 'feishu', 'omt_x')",
    ).run();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values) => lines.push(values.join(" ")));
    try {
      await handleMessages(db, ["list", "-n", "20"], "c1", "group", parseArgs);
    } finally {
      vi.restoreAllMocks();
    }
    expect(lines.join("\n")).toContain("current chat text");
    expect(lines.join("\n")).not.toContain("topic-only");
  });

  it("labels every scope when listing all threads", async () => {
    const db = setupDb();
    db.prepare(
      "INSERT INTO messages (id, chat_id, sender_id, role, content_text, content_type, platform, thread_id) VALUES (10, 'c1', 'u2', 'user', 'topic a', 'text', 'feishu', 'omt_aaa')",
    ).run();

    const output = formatMessagesForList(
      [
        {
          id: 10,
          chat_id: "c1",
          sender_id: "u2",
          sender_name: "Zen",
          role: "user",
          content_text: "topic a",
          content_type: "text",
          thread_id: "omt_aaa",
          created_at: "2026-08-25 05:00:00",
        },
        {
          id: 1,
          chat_id: "c1",
          sender_id: "u2",
          sender_name: "Zen",
          role: "user",
          content_text: "main",
          content_type: "text",
          thread_id: null,
          created_at: "2026-08-25 05:01:00",
        },
      ],
      { threadScope: { allThreads: true } },
    ).join("\n");

    expect(output).toContain("话题 omt_aaa");
    expect(output).toContain("主群");
  });

  it("does not inherit the current topic filter when listing another p2p chat", async () => {
    const db = setupDb();
    vi.stubEnv("NIUBOT_THREAD_ID", "omt_aaa");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await handleMessages(db, ["list", "--chat-id", "c2", "-n", "20"], "c1", "p2p", parseArgs);
    } finally {
      console.log = origLog;
    }
    expect(logs.join("\n")).toContain("other chat text");
  });

  it("syncs a group chat before listing", async () => {
    const db = setupDb();
    let synced = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await handleMessages(db, ["list", "-n", "20"], "c1", "group", parseArgs, async (database, chatId) => {
        synced += 1;
        expect(chatId).toBe("c1");
        database.prepare(
          "INSERT INTO messages (id, chat_id, sender_id, role, content_text, content_type, platform) VALUES (10, 'c1', 'u2', 'user', 'cow said hi', 'text', 'feishu')",
        ).run();
      });
    } finally {
      console.log = origLog;
    }
    expect(synced).toBe(1);
    expect(logs.join("\n")).toContain("cow said hi");
  });

  it("does not sync p2p chats", async () => {
    const db = setupDb();
    let synced = 0;
    const origLog = console.log;
    console.log = () => {};
    try {
      await handleMessages(db, ["list", "-n", "20"], "c2", "p2p", parseArgs, async () => {
        synced += 1;
      });
    } finally {
      console.log = origLog;
    }
    expect(synced).toBe(0);
  });

  it("still lists when group sync fails", async () => {
    const db = setupDb();
    const logs: string[] = [];
    const errors: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      await handleMessages(db, ["list", "-n", "20"], "c1", "group", parseArgs, async () => {
        throw new Error("feishu down");
      });
    } finally {
      console.log = origLog;
      console.error = origError;
    }
    expect(logs.join("\n")).toContain("current chat text");
    expect(errors.join("\n")).toContain("group history sync failed: feishu down");
  });
});

describe("handleMessages search scope flags", () => {
  it("treats legacy --all as --all-chats", async () => {
    const db = setupDb();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values) => lines.push(values.join(" ")));
    try {
      await handleMessages(db, ["search", "text", "--all"], "c2", "p2p", parseArgs);
    } finally {
      vi.restoreAllMocks();
    }
    expect(lines.join("\n")).toContain("current chat text");
    expect(lines.join("\n")).toContain("other chat text");
  });

  it("rejects combining --all-chats with topic scope flags", async () => {
    const db = setupDb();
    await expect(handleMessages(db, ["search", "text", "--all-chats", "--all-threads"], "c2", "p2p", parseArgs))
      .rejects.toThrow("--all-chats cannot be combined with --thread-id or --all-threads");
  });

  it("help documents that --all-chats is private-chat only", async () => {
    const db = setupDb();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values) => lines.push(values.join(" ")));
    try {
      await handleMessages(db, ["--help"], "c1", "group", parseArgs);
    } finally {
      vi.restoreAllMocks();
    }
    const text = lines.join("\n");
    expect(text).toContain("--all-chats 仅私聊可用");
    expect(text).toContain("群聊禁用");
    expect(text).toContain("--all-threads 查看整个群（仍是本群）");
  });

  it("searches every chat with --all-chats in p2p", async () => {
    const db = setupDb();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values) => lines.push(values.join(" ")));
    try {
      await handleMessages(db, ["search", "text", "--all-chats"], "c2", "p2p", parseArgs);
    } finally {
      vi.restoreAllMocks();
    }
    expect(lines.join("\n")).toContain("current chat text");
    expect(lines.join("\n")).toContain("other chat text");
  });
});
