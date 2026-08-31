/**
 * 群聊历史同步：拉会话记录写入本地库当缓存。
 * 不注入模型上下文；需要时由 nbt messages list/search 先 sync 再查。
 */

import type Database from "better-sqlite3";
import {
  ensureUser,
  getChatHistoryCursor,
  getThreadHistoryCursor,
  getMessageByPlatformId,
  getUserIdentityByPlatformId,
  setChatHistoryCursor,
  setThreadHistoryCursor,
  setUserIsBot,
  storeMessage,
  updateMessageContent,
} from "../database/schema.js";
import { utcDateTimeForSql } from "../tz.js";
import {
  isUnresolvedInteractiveContent,
  type NormalizedMessage,
  type TransportClient,
} from "../transport/types.js";

export const GROUP_HISTORY_LIST_LIMIT = 50;
/** 增量同步最多入库条数（飞书单页 50，适配器会翻页）。 */
export const GROUP_HISTORY_INCREMENTAL_LIMIT = 1000;
/** 同一 chat 短间隔内不重复打历史接口，用本地库顶上。 */
export const GROUP_HISTORY_MIN_FETCH_INTERVAL_MS = 3_000;

export type GroupHistoryTransport = {
  listChatMessages: NonNullable<TransportClient["listChatMessages"]>;
};

export type GroupHistorySyncResult = {
  fetched: number;
  inserted: number;
  skippedFetch: boolean;
};

export type GroupChatSyncTarget = {
  platformChatId: string;
  platform: string;
};

export function getGroupChatSyncTarget(
  db: Database.Database,
  chatId: string,
): GroupChatSyncTarget | null {
  const row = db.prepare(
    "SELECT type, platform, platform_id FROM chats WHERE id = ?",
  ).get(chatId) as { type: string | null; platform: string; platform_id: string | null } | undefined;
  if (!row || row.type !== "group" || !row.platform_id) return null;
  return { platformChatId: row.platform_id, platform: row.platform };
}

export function shouldSkipHistoryFetch(
  lastFetchedAt: number | null | undefined,
  nowMs: number,
  minIntervalMs: number = GROUP_HISTORY_MIN_FETCH_INTERVAL_MS,
): boolean {
  if (!lastFetchedAt) return false;
  return nowMs - lastFetchedAt < minIntervalMs;
}

function platformTsForStore(msg: NormalizedMessage): string | undefined {
  if (!msg.platformTs) return undefined;
  const ms = msg.platformTs > 1e12 ? msg.platformTs : msg.platformTs * 1000;
  return utcDateTimeForSql(new Date(ms));
}

export function cacheHistoryMessages(
  db: Database.Database,
  chatId: string,
  platform: string,
  messages: NormalizedMessage[],
  selfUserId?: string | null,
): { inserted: number; ids: number[] } {
  return db.transaction(() => {
    let inserted = 0;
    const ids: number[] = [];
    for (const msg of messages) {
      const platformMsgId = msg.platformMsgId;
      if (!platformMsgId) continue;

      // 历史消息的正文稍后可能只从 platform_raw 重建，但参与者身份不能丢。
      // 先把带有结构化 app/bot 标记的 mention 写入本地目录，供协作路由校验。
      for (const mention of msg.mentions ?? []) {
        if (!mention.platformUserId || (!mention.isApp && !mention.isBot)) continue;
        const mentionUserId = ensureUser(
          db,
          platform,
          mention.platformUserId,
          mention.name || undefined,
          "bot_info",
        );
        setUserIsBot(db, mentionUserId);
      }

      const existing = getMessageByPlatformId(db, platform, platformMsgId);
      if (existing) {
        // 历史同步可能把实时入口留下的降级卡片补成原文；不能因 platform_msg_id
        // 去重而把已有的 [卡片消息] 永久保留下来。
        if (
          existing.contentType === "interactive"
          && msg.contentType === "interactive"
          && isUnresolvedInteractiveContent(existing.contentText ?? "")
          && !isUnresolvedInteractiveContent(msg.contentText)
        ) {
          updateMessageContent(db, existing.id, msg.contentText);
        }
        ids.push(existing.id);
        continue;
      }
      const senderId = ensureUser(
        db,
        platform,
        msg.senderPlatformId,
        msg.senderName,
        msg.senderIsBot ? "bot_sender" : "platform",
      );
      if (msg.senderIsBot) setUserIsBot(db, senderId);
      const isSelf = Boolean(selfUserId && senderId === selfUserId);
      const platformTs = platformTsForStore(msg);
      const id = storeMessage(db, {
        chatId,
        senderId,
        role: isSelf ? "assistant" : "user",
        contentText: msg.contentText,
        contentType: msg.contentType,
        platform,
        platformMsgId,
        threadId: msg.threadId,
        platformTs,
        createdAt: platformTs,
        platformRaw: msg.raw ? JSON.stringify(msg.raw) : undefined,
        agentSeen: isSelf,
      });
      inserted += 1;
      ids.push(id);
    }
    return { inserted, ids };
  })();
}

export async function syncGroupHistory(options: {
  db: Database.Database;
  transport: GroupHistoryTransport;
  chatId: string;
  platformChatId: string;
  platform: string;
  selfUserId?: string | null;
  threadId?: string;
  nowMs?: number;
}): Promise<GroupHistorySyncResult> {
  const empty: GroupHistorySyncResult = {
    fetched: 0,
    inserted: 0,
    skippedFetch: false,
  };

  const nowMs = options.nowMs ?? Date.now();
  const cursor = options.threadId
    ? getThreadHistoryCursor(options.db, options.chatId, options.threadId)
    : getChatHistoryCursor(options.db, options.chatId);
  const skipFetch = shouldSkipHistoryFetch(cursor.fetchedAt, nowMs);
  if (skipFetch) {
    return { ...empty, skippedFetch: true };
  }

  const incremental = cursor.syncTs != null;
  const fetched = await options.transport.listChatMessages(options.platformChatId, {
    // 往前一秒，避免 start_time 按秒截断漏掉同秒消息；重复由 platform_msg_id 去重。
    sinceUnixSec: incremental ? Math.max(0, cursor.syncTs! - 1) : undefined,
    // 首次只要最新一页；增量翻页把 cursor 之后的新消息都拿到。
    limit: incremental ? GROUP_HISTORY_INCREMENTAL_LIMIT : GROUP_HISTORY_LIST_LIMIT,
    threadId: options.threadId,
  });
  const cached = cacheHistoryMessages(
    options.db,
    options.chatId,
    options.platform,
    fetched,
    options.selfUserId,
  );
  const newestSec = fetched
    .map((msg) => {
      if (!msg.platformTs) return undefined;
      return msg.platformTs > 1e12 ? Math.floor(msg.platformTs / 1000) : Math.floor(msg.platformTs);
    })
    .filter((n): n is number => n !== undefined)
    .reduce((max, n) => Math.max(max, n), cursor.syncTs ?? 0);
  const nextCursor = { syncTs: newestSec || cursor.syncTs, fetchedAt: nowMs };
  if (options.threadId) {
    setThreadHistoryCursor(options.db, options.chatId, options.threadId, nextCursor);
  } else {
    setChatHistoryCursor(options.db, options.chatId, nextCursor);
  }
  return {
    fetched: fetched.length,
    inserted: cached.inserted,
    skippedFetch: false,
  };
}

export async function syncGroupChatToDb(
  db: Database.Database,
  chatId: string,
  options: {
    transport: GroupHistoryTransport;
    selfUserId?: string | null;
    threadId?: string;
    nowMs?: number;
  },
): Promise<GroupHistorySyncResult | null> {
  const target = getGroupChatSyncTarget(db, chatId);
  if (!target) return null;
  return syncGroupHistory({
    db,
    transport: options.transport,
    chatId,
    platformChatId: target.platformChatId,
    platform: target.platform,
    selfUserId: options.selfUserId,
    threadId: options.threadId,
    nowMs: options.nowMs,
  });
}

export function lookupSelfUserId(
  db: Database.Database,
  platform: string,
  platformUserIds: Array<string | undefined | null>,
): string | null {
  for (const platformId of platformUserIds) {
    if (!platformId) continue;
    const identity = getUserIdentityByPlatformId(db, platform, platformId);
    if (identity) return identity.id;
  }
  return null;
}
