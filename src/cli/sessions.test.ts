import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../database/schema.js";
import { getSessionForAccess, listSessions } from "../sessions/store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function setupDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-session-store-"));
  tempDirs.push(dir);
  const db = initDatabase(path.join(dir, "niubot.db"));
  db.prepare("INSERT INTO chats (id, type, platform, platform_id) VALUES ('c1', 'group', 'feishu', 'pc1')").run();
  db.prepare("INSERT INTO chats (id, type, platform, platform_id) VALUES ('c2', 'p2p', 'feishu', 'pc2')").run();
  db.prepare("INSERT INTO sessions (id, chat_id, user_id, status, summary, ended_at, last_active_at) VALUES ('s1', 'c1', 'u2', 'archived', '{\"summary\":\"one\"}', '2026-04-24 10:00:00', '2026-04-24 10:00:00')").run();
  db.prepare("INSERT INTO sessions (id, chat_id, user_id, status, summary, ended_at, last_active_at) VALUES ('s2', 'c2', 'u2', 'archived', '{\"summary\":\"two\"}', '2026-04-24 11:00:00', '2026-04-24 11:00:00')").run();
  return db;
}

describe("session access rules", () => {
  it("blocks group list for another chat", () => {
    const db = setupDb();

    expect(() => listSessions(db, {
      currentChatId: "c1",
      targetChatId: "c2",
      chatType: "group",
      limit: 10,
    })).toThrow("cross-chat query is not allowed in group chat");
  });

  it("blocks group get by id for another chat", () => {
    const db = setupDb();

    expect(() => getSessionForAccess(db, "s2", {
      currentChatId: "c1",
      chatType: "group",
    })).toThrow("cross-chat query is not allowed in group chat");
  });

  it("blocks group get by id when current chat is missing", () => {
    const db = setupDb();

    expect(() => getSessionForAccess(db, "s2", {
      chatType: "group",
    })).toThrow("NIUBOT_CHAT_ID not set");
  });
});
