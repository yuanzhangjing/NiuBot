import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../database/schema.js";
import { getMessageForAccess, searchMessages } from "../messages/store.js";
import { TZ, utcToLocalDateTime } from "../tz.js";
import { formatMessagesForList } from "./messages.js";

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
});
