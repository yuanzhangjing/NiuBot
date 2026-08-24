import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../database/schema.js";
import { getMessageForAccess, listContinuationMessages, listMessages, searchMessages } from "../messages/store.js";
import { TZ, userTimeRangeToUtc, utcToLocalDateTime } from "../tz.js";
import { parseArgs } from "./args.js";
import { formatMessagesForList, handleMessages } from "./messages.js";

const tempDirs: string[] = [];
const openDatabases: Database.Database[] = [];

afterEach(() => {
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
