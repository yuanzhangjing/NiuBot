import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { closeTestDatabases, openTestDatabase } from "../../test-utils/database.js";
import { getSessionForAccess } from "./store.js";

const tempDirectories: string[] = [];

afterEach(() => {
  closeTestDatabases();
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function openDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-sessions-"));
  tempDirectories.push(directory);
  return openTestDatabase(path.join(directory, "niubot.db"));
}

type InsertRow = {
  id: string;
  chatId: string;
  agentSessionId?: string;
  lastActiveAt?: string;
  status?: "active" | "archived";
};

function insertSessions(db: ReturnType<typeof openDatabase>, rows: InsertRow[]): void {
  const statement = db.prepare(`
    INSERT INTO sessions (id, chat_id, source, status, backend_type, agent_session_id, started_at, last_active_at)
    VALUES (?, ?, 'user', ?, 'dsh', ?, datetime('now'), ?)
  `);
  for (const row of rows) {
    statement.run(
      row.id,
      row.chatId,
      row.status ?? "active",
      row.agentSessionId ?? null,
      row.lastActiveAt ?? "2026-11-07 10:00:00",
    );
  }
}

const CHAT = "chat-1";
const context = { currentChatId: CHAT, chatType: "p2p" as const };

describe("getSessionForAccess", () => {
  test("finds a session by exact internal id and native id", () => {
    const db = openDatabase();
    insertSessions(db, [{ id: "d5f81d79", chatId: CHAT, agentSessionId: "session-aac50194-0772-484c-88f9-27d359b8eb09" }]);

    expect(getSessionForAccess(db, "d5f81d79", context)?.id).toBe("d5f81d79");
    expect(getSessionForAccess(db, "session-aac50194-0772-484c-88f9-27d359b8eb09", context)?.id).toBe("d5f81d79");
  });

  test("finds a session by the short id shown in the footer", () => {
    const db = openDatabase();
    insertSessions(db, [{ id: "d5f81d79", chatId: CHAT, agentSessionId: "session-aac50194-0772-484c-88f9-27d359b8eb09" }]);

    expect(getSessionForAccess(db, "aac50194", context)?.id).toBe("d5f81d79");
  });

  test("accepts a prefix of the internal id", () => {
    const db = openDatabase();
    insertSessions(db, [{ id: "d5f81d79", chatId: CHAT, agentSessionId: "session-aac50194-0772-484c-88f9-27d359b8eb09" }]);

    expect(getSessionForAccess(db, "d5f8", context)?.id).toBe("d5f81d79");
  });

  test("rejects an ambiguous prefix", () => {
    const db = openDatabase();
    insertSessions(db, [
      { id: "aac50001", chatId: CHAT, agentSessionId: "session-aac50194-0772-484c-88f9-27d359b8eb09" },
      {
        id: "aac50002",
        chatId: CHAT,
        agentSessionId: "session-aac50666-0772-484c-88f9-27d359b8eb09",
        status: "archived",
      },
    ]);

    expect(() => getSessionForAccess(db, "aac50", context)).toThrow(/Ambiguous session id prefix/);
  });

  test("prefers the current chat when a prefix matches several chats", () => {
    const db = openDatabase();
    insertSessions(db, [
      { id: "abc10000", chatId: "chat-2", agentSessionId: "session-abc10000-0000-0000-0000-000000000000" },
      { id: "abc10001", chatId: CHAT, agentSessionId: "session-abc10001-0000-0000-0000-000000000000" },
    ]);

    expect(getSessionForAccess(db, "abc1", context)?.id).toBe("abc10001");
  });

  test("returns undefined for unknown ids and does not treat LIKE wildcards as patterns", () => {
    const db = openDatabase();
    insertSessions(db, [{ id: "d5f81d79", chatId: CHAT, agentSessionId: "session-aac50194-0772-484c-88f9-27d359b8eb09" }]);

    expect(getSessionForAccess(db, "ffff", context)).toBeUndefined();
    expect(getSessionForAccess(db, "%", context)).toBeUndefined();
    expect(getSessionForAccess(db, "_", context)).toBeUndefined();
  });
});
