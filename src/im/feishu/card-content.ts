import type { MentionInfo } from "../types.js";
import { mapFeishuAtTags } from "../mentions.js";
import {
  isUnresolvedInteractiveContent,
  UNRESOLVED_INTERACTIVE_CONTENT,
} from "../../transport/types.js";

/** 卡片正文无法取得时的明确占位。它不能被当成已经解析完成的正文。 */
export const FEISHU_CARD_PLACEHOLDER = UNRESOLVED_INTERACTIVE_CONTENT;

export type FetchOriginalCardContent = () => Promise<string | undefined>;

/**
 * 飞书卡片在事件和 message.get 中可能返回“请升级客户端”的降级内容。
 * 空内容和本地占位也需要继续尝试取原卡片。
 */
export function isDegradedCardText(text: string): boolean {
  return isUnresolvedInteractiveContent(text);
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const node = value as Record<string, unknown>;
  if (typeof node.content === "string") return node.content;
  if (typeof node.text === "string") return node.text;
  if (node.text && typeof node.text === "object") return textValue(node.text);
  return "";
}

/** 抽取常见卡片 schema 的可读文字，不负责调用平台 API。 */
export function extractInteractiveText(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";

  const root = parsed as Record<string, unknown>;
  const parts: string[] = [];
  const take = (value: unknown): void => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const child of value) take(child);
      return;
    }
    if (typeof value !== "object") return;

    const node = value as Record<string, unknown>;
    const tag = typeof node.tag === "string" ? node.tag : "";
    switch (tag) {
      case "markdown":
      case "lark_md":
      case "plain_text": {
        const text = textValue(node.content ?? node.text);
        if (text) parts.push(text);
        break;
      }
      case "text":
      case "div":
      case "button": {
        const text = textValue(node.text ?? node.content);
        if (text) parts.push(text);
        break;
      }
    }

    // 覆盖 schema 1.0 的嵌套 elements，以及 schema 2.0 的 column/action 容器。
    take((node.body as Record<string, unknown> | undefined)?.elements);
    take(node.elements);
    take(node.columns);
    take(node.actions);
    take(node.children);
  };

  const headerTitle = textValue((root.header as Record<string, unknown> | undefined)?.title);
  const rootTitle = textValue(root.title);
  if (headerTitle || rootTitle) parts.push(headerTitle || rootTitle);

  const bodyElements = (root.body as Record<string, unknown> | undefined)?.elements;
  take(bodyElements);
  const hasBodyElements = Array.isArray(bodyElements) ? bodyElements.length > 0 : Boolean(bodyElements);
  if (!hasBodyElements || parts.length === (headerTitle || rootTitle ? 1 : 0)) {
    take(root.elements);
  }

  return parts.map((part) => part.trim()).filter(Boolean).join("\n");
}

type ParsedCard = {
  text: string;
  isJson: boolean;
};

function parseCard(rawContent: string | undefined | null): ParsedCard {
  const raw = rawContent?.trim() ?? "";
  try {
    return { text: extractInteractiveText(JSON.parse(raw)), isJson: true };
  } catch {
    // 某些事件只给占位字符串。仍保留原文，同时让异步入口继续尝试 message.get。
    return { text: raw, isJson: false };
  }
}

function replaceCardMentions(text: string, mentions: MentionInfo[]): string {
  let out = text;
  for (const mention of mentions) {
    if (!mention.key) continue;
    const replacement = mention.key === "@_all" || mention.platformUserId === "@_all"
      ? "@所有人"
      : `@${mention.name?.trim() || mention.platformUserId}`;
    out = out.replaceAll(mention.key, replacement);
  }
  return mapFeishuAtTags(out, (platformId, inner) => {
    if (platformId === "_all" || platformId === "@_all") return "@所有人";
    const mention = mentions.find((item) => item.platformUserId === platformId);
    const name = mention?.name?.trim() || inner.trim();
    return name ? `@${name}` : "";
  });
}

function formatCardText(text: string, mentions: MentionInfo[]): string {
  const normalized = text.trim();
  if (isDegradedCardText(normalized)) return FEISHU_CARD_PLACEHOLDER;
  return replaceCardMentions(normalized, mentions);
}

/** 只解析已有内容，用于同步 parser 和已经拿到完整 body 的子消息。 */
export function extractInteractiveCardContent(
  rawContent: string | undefined | null,
  mentions: MentionInfo[] = [],
): string {
  const parsed = parseCard(rawContent);
  return formatCardText(parsed.text, mentions);
}

/**
 * 入站卡片的统一解析入口。
 * 只有本地内容为空、是占位或不是合法 JSON 时才调用 resolver，避免重复 GET。
 */
export async function resolveInteractiveCardContent(
  rawContent: string | undefined | null,
  mentions: MentionInfo[] = [],
  fetchOriginal?: FetchOriginalCardContent,
): Promise<string> {
  const initial = parseCard(rawContent);
  let text = initial.text;

  if (fetchOriginal && (!initial.isJson || isDegradedCardText(text))) {
    let originalRaw: string | undefined;
    try {
      originalRaw = await fetchOriginal();
    } catch {
      originalRaw = undefined;
    }
    if (originalRaw) {
      const original = parseCard(originalRaw);
      if (!isDegradedCardText(original.text)) text = original.text;
    }
  }

  return formatCardText(text, mentions);
}
