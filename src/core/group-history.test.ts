import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import {
  initDatabase,
  ensureChat,
  ensureUser,
  getChatHistoryCursor,
  getThreadHistoryCursor,
  getMessageByPlatformId,
  storeMessage,
} from "../database/schema.js";
import {
  cacheHistoryMessages,
  getGroupChatSyncTarget,
  GROUP_HISTORY_INCREMENTAL_LIMIT,
  GROUP_HISTORY_LIST_LIMIT,
  shouldSkipHistoryFetch,
  syncGroupChatToDb,
  syncGroupHistory,
} from "./group-history.js";
import type { NormalizedMessage } from "../transport/types.js";

const tempDirs: string[] = [];
const openDatabases = new Set<Database.Database>();

function openTestDatabase(filePath: string): Database.Database {
  const db = initDatabase(filePath);
  openDatabases.add(db);
  return db;
}

afterEach(() => {
  for (const db of openDatabases) {
    if (db.open) db.close();
  }
  openDatabases.clear();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function historyMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    senderPlatformId: "ou-cow",
    senderName: "CowBot",
    chatPlatformId: "oc-group",
    chatType: "group",
    contentText: "我改完了",
    contentType: "text",
    senderIsBot: true,
    timestamp: new Date(),
    platformTs: 1_777_532_010_000,
    platformMsgId: "om-cow-1",
    raw: {},
    ...overrides,
  };
}

describe("group history sync", () => {
  test("skips fetch inside the cache interval", () => {
    expect(shouldSkipHistoryFetch(undefined, 1000)).toBe(false);
    expect(shouldSkipHistoryFetch(500, 1000, 3000)).toBe(true);
    expect(shouldSkipHistoryFetch(500, 4000, 3000)).toBe(false);
  });

  test("only syncs group chats that have a platform id", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "group-history-target-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "t.db"));
    const groupId = ensureChat(db, "feishu", "oc-group", "group", "bots");
    const p2pId = ensureChat(db, "feishu", "oc-p2p", "p2p", "zen");
    expect(getGroupChatSyncTarget(db, groupId)).toEqual({
      platformChatId: "oc-group",
      platform: "feishu",
    });
    expect(getGroupChatSyncTarget(db, p2pId)).toBeNull();
    expect(getGroupChatSyncTarget(db, "missing")).toBeNull();
  });

  test("caches by platform_msg_id and does not insert duplicates", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "group-history-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "t.db"));
    const chatId = ensureChat(db, "feishu", "oc-group", "group", "bots");
    const first = cacheHistoryMessages(db, chatId, "feishu", [historyMsg()]);
    const second = cacheHistoryMessages(db, chatId, "feishu", [historyMsg(), historyMsg({
      platformMsgId: "om-cow-2",
      contentText: "第二句",
    })]);
    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(1);
    expect(second.ids).toHaveLength(2);
    const stored = db.prepare(
      "SELECT created_at, platform_ts FROM messages WHERE platform_msg_id = ?",
    ).get("om-cow-1") as { created_at: string; platform_ts: string };
    expect(stored.created_at).toBe(stored.platform_ts);
  });

  test("sync writes unseen messages and skips the already stored trigger", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "group-history-sync-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "t.db"));
    const chatId = ensureChat(db, "feishu", "oc-group", "group", "bots");
    const selfId = ensureUser(db, "feishu", "ou-self", "NiuBot", "bot_sender");
    storeMessage(db, {
      chatId,
      senderId: ensureUser(db, "feishu", "ou-human", "Zen"),
      role: "user",
      contentText: "@NiuBot 看看刚才",
      platform: "feishu",
      platformMsgId: "om-trigger",
    });

    const listed: NormalizedMessage[] = [
      historyMsg(),
      historyMsg({
        platformMsgId: "om-self",
        senderPlatformId: "ou-self",
        senderName: "NiuBot",
        contentText: "我自己说的",
        senderIsBot: true,
      }),
      historyMsg({
        platformMsgId: "om-trigger",
        senderPlatformId: "ou-human",
        senderName: "Zen",
        contentText: "@NiuBot 看看刚才",
        senderIsBot: false,
      }),
    ];
    let listCalls = 0;
    const transport = {
      listChatMessages: async () => {
        listCalls += 1;
        return listed;
      },
    };

    const first = await syncGroupHistory({
      db,
      transport,
      chatId,
      platformChatId: "oc-group",
      platform: "feishu",
      selfUserId: selfId,
      nowMs: 10_000,
    });
    expect(first.fetched).toBe(3);
    expect(first.inserted).toBe(2); // cow + self; trigger already stored
    expect(getMessageByPlatformId(db, "feishu", "om-cow-1")?.contentText).toBe("我改完了");
    const selfRow = db.prepare("SELECT role FROM messages WHERE platform_msg_id = ?").get("om-self") as { role: string };
    expect(selfRow.role).toBe("assistant");

    const second = await syncGroupHistory({
      db,
      transport,
      chatId,
      platformChatId: "oc-group",
      platform: "feishu",
      selfUserId: selfId,
      nowMs: 11_000,
    });
    expect(second.skippedFetch).toBe(true);
    expect(listCalls).toBe(1);
  });

  test("syncGroupChatToDb no-ops for p2p chats", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "group-history-p2p-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "t.db"));
    const chatId = ensureChat(db, "feishu", "oc-p2p", "p2p", "zen");
    let listCalls = 0;
    const result = await syncGroupChatToDb(db, chatId, {
      transport: {
        listChatMessages: async () => {
          listCalls += 1;
          return [];
        },
      },
    });
    expect(result).toBeNull();
    expect(listCalls).toBe(0);
  });

  test("does not advance the fetch cursor when listChatMessages throws", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "group-history-throw-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "t.db"));
    const chatId = ensureChat(db, "feishu", "oc-group", "group", "bots");
    await expect(syncGroupHistory({
      db,
      transport: {
        listChatMessages: async () => {
          throw new Error("feishu down");
        },
      },
      chatId,
      platformChatId: "oc-group",
      platform: "feishu",
      nowMs: 10_000,
    })).rejects.toThrow("feishu down");
    expect(getChatHistoryCursor(db, chatId).fetchedAt).toBeNull();
  });

  test("incremental sync requests more than one Feishu page", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "group-history-incremental-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "t.db"));
    const chatId = ensureChat(db, "feishu", "oc-group", "group", "bots");
    const limits: Array<number | undefined> = [];
    await syncGroupHistory({
      db,
      transport: {
        listChatMessages: async (_id, options) => {
          limits.push(options?.limit);
          return [historyMsg({ platformTs: 1_000 })];
        },
      },
      chatId,
      platformChatId: "oc-group",
      platform: "feishu",
      nowMs: 10_000,
    });
    await syncGroupHistory({
      db,
      transport: {
        listChatMessages: async (_id, options) => {
          limits.push(options?.limit);
          return [];
        },
      },
      chatId,
      platformChatId: "oc-group",
      platform: "feishu",
      nowMs: 20_000,
    });
    expect(limits).toEqual([GROUP_HISTORY_LIST_LIMIT, GROUP_HISTORY_INCREMENTAL_LIMIT]);
  });

  test("thread sync writes thread cursor and does not move chat cursor", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "group-history-thread-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "t.db"));
    const chatId = ensureChat(db, "feishu", "oc-group", "group", "bots");
    const listed = [historyMsg({
      platformMsgId: "om-thread-reply",
      threadId: "omt_aaa",
      rootId: "om-root",
      platformTs: 1_500,
    })];
    const seenOptions: Array<{ threadId?: string }> = [];

    await syncGroupHistory({
      db,
      transport: {
        listChatMessages: async (_id, options) => {
          seenOptions.push({ threadId: options?.threadId });
          return listed;
        },
      },
      chatId,
      platformChatId: "oc-group",
      platform: "feishu",
      threadId: "omt_aaa",
      nowMs: 12_000,
    });

    expect(seenOptions).toEqual([{ threadId: "omt_aaa" }]);
    expect(getChatHistoryCursor(db, chatId).fetchedAt).toBeNull();
    expect(getThreadHistoryCursor(db, chatId, "omt_aaa")).toMatchObject({
      syncTs: 1_500,
      fetchedAt: 12_000,
    });
    expect(getMessageByPlatformId(db, "feishu", "om-thread-reply")?.threadId).toBe("omt_aaa");
  });
});
