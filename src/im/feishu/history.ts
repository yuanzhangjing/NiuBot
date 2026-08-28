/**
 * 飞书会话历史消息解析。只抽文本，不下载附件，给群聊 sync 入库用。
 */

import type { MentionInfo, NormalizedMessage } from "../types.js";
import { isAppIdentity } from "./message-identity.js";
import {
  extractInteractiveCardContent,
  resolveInteractiveCardContent,
} from "./card-content.js";

export function feishuTimeToUnixSec(raw?: string | number): number | undefined {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

function replaceMentionKeys(text: string, mentions: MentionInfo[]): string {
  let out = text;
  for (const mention of mentions) {
    if (!mention.key) continue;
    if (mention.key === "@_all" || mention.platformUserId === "@_all") {
      out = out.replaceAll(mention.key, "@所有人");
    } else {
      out = out.replaceAll(mention.key, `@${mention.name || mention.platformUserId}`);
    }
  }
  return out;
}

function extractPostText(parsed: Record<string, any>): string {
  const parts: string[] = [];
  if (parsed.title) parts.push(String(parsed.title));
  const walk = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node !== "object") return;
    const el = node as Record<string, any>;
    if (typeof el.text === "string") parts.push(el.text);
    else if (el.text?.content) parts.push(el.text.content);
    if (el.elements) walk(el.elements);
    if (el.content) walk(el.content);
  };
  walk(parsed.content);
  return parts.join("");
}

function parseMentions(
  raw: unknown,
  botOpenId?: string | null,
  appId?: string | null,
): { mentions: MentionInfo[]; botMentioned: boolean } {
  const mentions: MentionInfo[] = [];
  let botMentioned = false;
  if (!Array.isArray(raw)) return { mentions, botMentioned };
  for (const item of raw) {
    const mentionId = typeof item?.id === "string"
      ? item.id
      : (item?.id?.open_id || item?.id?.app_id || "");
    const isBot = Boolean(
      mentionId && (mentionId === botOpenId || mentionId === appId),
    );
    if (isBot) botMentioned = true;
    mentions.push({
      platformUserId: mentionId,
      name: item?.name ?? "",
      isBot,
      isApp: isBot || item?.id_type === "app_id" || String(mentionId).startsWith("cli_"),
      key: item?.key ?? "",
    });
  }
  return { mentions, botMentioned };
}

function extractText(
  msgType: string,
  rawContent: string,
  mentions: MentionInfo[],
): { text: string; contentType: NormalizedMessage["contentType"] } {
  if (msgType === "merge_forward") {
    return { text: "[合并转发消息]", contentType: "merge_forward" };
  }
  // 卡片必须走公共解析器；即使列表接口给的是非 JSON 占位，也保留可供异步入口补取的结果。
  if (msgType === "interactive") {
    return { text: extractInteractiveCardContent(rawContent, mentions), contentType: "interactive" };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    const known = new Set(["image", "audio", "file", "media", "post"]);
    const contentType: NormalizedMessage["contentType"] = known.has(msgType)
      ? msgType as NormalizedMessage["contentType"]
      : "text";
    return { text: rawContent || `[${msgType}]`, contentType };
  }

  switch (msgType) {
    case "text":
      return { text: replaceMentionKeys(parsed.text ?? "", mentions), contentType: "text" };
    case "post":
      return { text: replaceMentionKeys(extractPostText(parsed) || "[富文本]", mentions), contentType: "post" };
    case "image":
      return { text: "[图片]", contentType: "image" };
    case "file":
      return { text: parsed.file_name ? `[文件: ${parsed.file_name}]` : "[文件]", contentType: "file" };
    case "audio":
      return { text: "[音频]", contentType: "audio" };
    case "media":
      return { text: "[视频]", contentType: "media" };
    default:
      return { text: parsed.text ?? `[${msgType}]`, contentType: "text" };
  }
}

async function extractTextWithCardResolver(
  msgType: string,
  rawContent: string,
  mentions: MentionInfo[],
  messageId: string,
  fetchOriginalCard?: (messageId: string) => Promise<string | undefined>,
): Promise<{ text: string; contentType: NormalizedMessage["contentType"] }> {
  if (msgType !== "interactive" || !fetchOriginalCard) {
    return extractText(msgType, rawContent, mentions);
  }
  return {
    text: await resolveInteractiveCardContent(
      rawContent,
      mentions,
      () => fetchOriginalCard(messageId),
    ),
    contentType: "interactive",
  };
}

function getHistoryItemData(item: any): {
  messageId: string;
  content: string;
  senderId: string;
} | null {
  const messageId = item?.message_id;
  const msgType = item?.msg_type ?? item?.message_type ?? "text";
  const bodyContent = item?.body?.content;
  const rawContent = typeof bodyContent === "string" ? bodyContent : item?.content;
  const content = typeof rawContent === "string"
    ? rawContent
    : msgType === "interactive" ? "" : undefined;
  const senderId = item?.sender?.id || item?.sender?.sender_id?.open_id;
  if (!messageId || !senderId || content === undefined) return null;
  return { messageId, content, senderId };
}

function buildHistoryMessage(
  item: any,
  chatPlatformId: string,
  data: { messageId: string; senderId: string },
  mentions: MentionInfo[],
  botMentioned: boolean,
  text: string,
  contentType: NormalizedMessage["contentType"],
): NormalizedMessage | null {
  if (!text) return null;

  const senderIsBot = isAppIdentity(item.sender?.id, item.sender?.id_type, item.sender?.sender_type)
    || String(data.senderId).startsWith("cli_");
  const platformTs = Number(item.create_time);
  const ts = Number.isFinite(platformTs) && platformTs > 0 ? platformTs : undefined;

  return {
    senderPlatformId: data.senderId,
    senderName: item.sender?.name,
    chatPlatformId: item.chat_id ?? chatPlatformId,
    chatType: "group",
    contentText: text,
    contentType,
    mentions: mentions.length > 0 ? mentions : undefined,
    botMentioned,
    senderIsBot,
    parentPlatformMsgId: item.parent_id ?? undefined,
    threadId: item.thread_id ?? undefined,
    rootId: item.root_id ?? undefined,
    platformTs: ts,
    timestamp: ts ? new Date(ts > 1e12 ? ts : ts * 1000) : new Date(),
    platformMsgId: data.messageId,
    raw: item,
  };
}

/** 把 GET /im/v1/messages 的一条 item 收成 NormalizedMessage。 */
export function parseFeishuHistoryItem(
  item: any,
  chatPlatformId: string,
  botOpenId?: string | null,
  appId?: string | null,
): NormalizedMessage | null {
  const data = getHistoryItemData(item);
  if (!data) return null;

  const msgType = item.msg_type ?? item.message_type ?? "text";
  const { mentions, botMentioned } = parseMentions(item.mentions, botOpenId, appId);
  const { text, contentType } = extractText(msgType, data.content, mentions);
  return buildHistoryMessage(item, chatPlatformId, data, mentions, botMentioned, text, contentType);
}

/**
 * 历史同步专用入口：与实时事件共用卡片解析，降级卡片才补取原始 body。
 * 其它消息保持同步 parser 的行为，不额外调用平台接口。
 */
export async function parseFeishuHistoryItemWithCardResolver(
  item: any,
  chatPlatformId: string,
  botOpenId?: string | null,
  appId?: string | null,
  fetchOriginalCard?: (messageId: string) => Promise<string | undefined>,
): Promise<NormalizedMessage | null> {
  const data = getHistoryItemData(item);
  if (!data) return null;

  const msgType = item.msg_type ?? item.message_type ?? "text";
  const { mentions, botMentioned } = parseMentions(item.mentions, botOpenId, appId);
  const { text, contentType } = await extractTextWithCardResolver(
    msgType,
    data.content,
    mentions,
    data.messageId,
    fetchOriginalCard,
  );
  return buildHistoryMessage(item, chatPlatformId, data, mentions, botMentioned, text, contentType);
}
