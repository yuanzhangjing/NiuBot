import type { ChatMetadata } from "../transport/types.js";

/** 一次隔离工作流。非话题群时 threadId 为空，scopeKey === chatId。 */
export interface SessionScope {
  chatId: string;
  platformChatId: string;
  threadId?: string;
  scopeKey: string;
  isolated: boolean;
}

export const CHAT_MODE_TTL_MS = 10 * 60 * 1_000;

/** 话题形式群与话题群同等隔离（D11）。整机 kill-switch 仍是 NIUBOT_TOPIC_ISOLATION=0。 */
export const ISOLATE_TOPIC_FORM_GROUPS = true;

export function buildScopeKey(chatId: string, threadId?: string): string {
  return threadId ? `${chatId}#${threadId}` : chatId;
}

export function parseScopeKey(key: string): { chatId: string; threadId?: string } {
  const separator = key.indexOf("#");
  if (separator <= 0) return { chatId: key };
  return {
    chatId: key.slice(0, separator),
    threadId: key.slice(separator + 1),
  };
}

export function shouldIsolateChat(meta: Pick<ChatMetadata, "chatMode" | "groupMessageType">): boolean {
  if (process.env.NIUBOT_TOPIC_ISOLATION === "0") return false;
  if (meta.chatMode === "topic") return true;
  if (
    ISOLATE_TOPIC_FORM_GROUPS
    && meta.chatMode === "group"
    && meta.groupMessageType === "thread"
  ) {
    return true;
  }
  return false;
}

export function resolveSessionScope(input: {
  chatId: string;
  platformChatId: string;
  chatType: "p2p" | "group";
  chatMode?: string | null;
  groupMessageType?: string | null;
  threadId?: string;
}): SessionScope {
  const isolated = input.chatType === "group"
    && shouldIsolateChat({
      chatMode: input.chatMode ?? undefined,
      groupMessageType: input.groupMessageType ?? undefined,
    })
    && Boolean(input.threadId);
  return {
    chatId: input.chatId,
    platformChatId: input.platformChatId,
    threadId: isolated ? input.threadId : undefined,
    scopeKey: isolated ? buildScopeKey(input.chatId, input.threadId) : input.chatId,
    isolated,
  };
}

export function scopeForMessage(
  scopeKey: string,
  platformChatId: string,
): SessionScope {
  const parsed = parseScopeKey(scopeKey);
  return {
    chatId: parsed.chatId,
    platformChatId,
    threadId: parsed.threadId,
    scopeKey,
    isolated: Boolean(parsed.threadId),
  };
}
