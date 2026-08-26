/**
 * nbt messages / sessions 共用的话题范围解析。
 *
 * 话题群的默认查询范围是“当前话题”，显式 `--all-threads` 才看整个群。
 * 切到另一个 chat 时不能继承当前话题，避免把别的聊天过滤成空。
 */

import type Database from "better-sqlite3";
import { shouldIsolateChat } from "../core/session-scope.js";
import { getChatMetadata } from "../database/schema.js";

export interface ResolvedHistoryThreadScope {
  threadId?: string;
  allThreads: boolean;
}

export function chatIsIsolatedTopic(db: Database.Database, chatId: string | undefined): boolean {
  if (!chatId) return false;
  return shouldIsolateChat(getChatMetadata(db, chatId) ?? {});
}

export function resolveHistoryThreadScope(
  flags: Record<string, string>,
  currentChatId: string | undefined,
  targetChatId: string | undefined,
  currentThreadId?: string,
  isolatedTopicChat = false,
): ResolvedHistoryThreadScope {
  const explicitThreadId = flags["thread-id"];
  const allThreads = flags["all-threads"] === "true";
  if (explicitThreadId !== undefined && allThreads) {
    throw new Error("--thread-id cannot be combined with --all-threads");
  }
  if (allThreads) return { allThreads: true };
  if (explicitThreadId !== undefined) {
    if (!explicitThreadId) throw new Error("--thread-id requires a non-empty value");
    return { threadId: explicitThreadId, allThreads: false };
  }
  // 只有仍查当前 chat 时才继承话题；显式切换 chat 后视为主会话/全群范围。
  if (targetChatId === currentChatId && currentThreadId) {
    return { threadId: currentThreadId, allThreads: false };
  }
  // 话题群主群默认 thread_id IS NULL；普通群/私聊不按话题过滤。
  return { allThreads: !isolatedTopicChat };
}

export function historyThreadLabel(threadId: string | null | undefined): string {
  return threadId ? `话题 ${threadId}` : "主群";
}
