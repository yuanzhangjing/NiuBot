/**
 * 飞书会话历史消息解析。只抽文本，不下载附件，给群聊 sync 入库用。
 */

import type { MentionInfo, NormalizedMessage } from "../types.js";
import { isAppIdentity } from "./message-identity.js";

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
      out = out.replace(mention.key, "@所有人");
    } else {
      out = out.replace(mention.key, `@${mention.name || mention.platformUserId}`);
    }
  }
  return out;
}

function extractCardText(parsed: unknown): string {
  const parts: string[] = [];
  const take = (el: unknown): void => {
    if (!el) return;
    if (Array.isArray(el)) {
      for (const child of el) take(child);
      return;
    }
    if (typeof el !== "object") return;
    const node = el as Record<string, any>;
    if (node.tag === "markdown" || node.tag === "lark_md") {
      parts.push(node.content ?? node.text?.content ?? "");
    } else if (node.tag === "div" && node.text?.content) {
      parts.push(node.text.content);
    } else if (node.tag === "text" && typeof node.text === "string" && node.text) {
      parts.push(node.text);
    }
    if (node.body?.elements) take(node.body.elements);
    if (node.elements) take(node.elements);
  };
  const root = parsed as Record<string, any> | null;
  if (root) {
    take(root.body?.elements);
    if (root.header?.title?.content) parts.unshift(root.header.title.content);
    if (parts.length === 0) take(root.elements);
  }
  return parts.map((part) => String(part).trim()).filter(Boolean).join("\n");
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
  let parsed: any;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    const known = new Set(["image", "audio", "file", "media", "post", "interactive"]);
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
    case "interactive": {
      const card = extractCardText(parsed) || "[卡片消息]";
      return { text: replaceMentionKeys(card, mentions), contentType: "interactive" };
    }
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

/** 把 GET /im/v1/messages 的一条 item 收成 NormalizedMessage。 */
export function parseFeishuHistoryItem(
  item: any,
  chatPlatformId: string,
  botOpenId?: string | null,
  appId?: string | null,
): NormalizedMessage | null {
  const messageId = item?.message_id;
  const content = item?.body?.content ?? item?.content;
  const senderId = item?.sender?.id || item?.sender?.sender_id?.open_id;
  if (!messageId || !senderId || typeof content !== "string") return null;

  const msgType = item.msg_type ?? item.message_type ?? "text";
  const { mentions, botMentioned } = parseMentions(item.mentions, botOpenId, appId);
  const { text, contentType } = extractText(msgType, content, mentions);
  if (!text) return null;

  const senderIsBot = isAppIdentity(item.sender?.id, item.sender?.id_type, item.sender?.sender_type)
    || String(senderId).startsWith("cli_");
  const platformTs = Number(item.create_time);
  const ts = Number.isFinite(platformTs) && platformTs > 0 ? platformTs : undefined;

  return {
    senderPlatformId: senderId,
    senderName: item.sender?.name,
    chatPlatformId: item.chat_id ?? chatPlatformId,
    chatType: "group",
    contentText: text,
    contentType,
    mentions: mentions.length > 0 ? mentions : undefined,
    botMentioned,
    senderIsBot,
    parentPlatformMsgId: item.parent_id ?? undefined,
    platformTs: ts,
    timestamp: ts ? new Date(ts > 1e12 ? ts : ts * 1000) : new Date(),
    platformMsgId: messageId,
    raw: item,
  };
}
