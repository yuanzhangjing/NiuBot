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

type CardObj = Record<string, unknown>;

type CardAttachmentContext = {
  atUsers?: CardObj;
  persons?: CardObj;
  mentionsByKey: Map<string, MentionInfo>;
};

const IGNORED_CARD_TAGS = new Set(["card_header", "custom_icon", "standard_icon"]);

function asCardObj(value: unknown): CardObj | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as CardObj : undefined;
}

function unwrapProperty(obj: CardObj): CardObj {
  return asCardObj(obj.property) ?? obj;
}

function extractI18nOrText(value: unknown): string {
  if (typeof value === "string") return value;
  const obj = asCardObj(value);
  if (!obj) return "";
  const prop = unwrapProperty(obj);
  const i18n = asCardObj(prop.i18nContent);
  if (i18n) {
    for (const lang of ["zh_cn", "en_us", "ja_jp"]) {
      if (typeof i18n[lang] === "string" && i18n[lang]) return i18n[lang] as string;
    }
  }
  if (typeof prop.content === "string") return prop.content;
  if (Array.isArray(prop.elements)) {
    return prop.elements.map((el) => extractI18nOrText(el)).filter(Boolean).join("");
  }
  if (typeof prop.text === "string") return prop.text;
  if (prop.text) return extractI18nOrText(prop.text);
  return "";
}

function resolveAtTagText(prop: CardObj, ctx: CardAttachmentContext): string {
  const userId = typeof prop.userID === "string"
    ? prop.userID
    : (typeof prop.user_id === "string" ? prop.user_id : "");
  if (!userId) return "";
  if (userId === "_all" || userId === "@_all") return "@所有人";
  const info = asCardObj(ctx.atUsers?.[userId]);
  if (info) {
    const mentionKey = typeof info.mention_key === "string" ? info.mention_key : "";
    const mention = mentionKey ? ctx.mentionsByKey.get(mentionKey) : undefined;
    const name = mention?.name?.trim() || (typeof info.content === "string" ? info.content.trim() : "");
    if (name) return `@${name}`;
  }
  return `@${userId}`;
}

function resolvePersonText(prop: CardObj, ctx: CardAttachmentContext): string {
  const userId = typeof prop.userID === "string" ? prop.userID : "";
  if (!userId) return "";
  const personInfo = asCardObj(ctx.persons?.[userId]);
  if (typeof personInfo?.content === "string" && personInfo.content) return personInfo.content;
  const notation = extractI18nOrText(prop.notation);
  return notation || userId;
}

function renderInlineElements(elements: unknown[], ctx: CardAttachmentContext): string {
  let out = "";
  for (const el of elements) {
    const obj = asCardObj(el);
    if (!obj) continue;
    const tag = typeof obj.tag === "string" ? obj.tag : "";
    const prop = unwrapProperty(obj);
    switch (tag) {
      case "br":
        out += "\n";
        break;
      case "hr":
        out += "\n---\n";
        break;
      case "plain_text":
      case "text":
      case "lark_md":
        out += extractI18nOrText(prop);
        break;
      case "code_span":
        out += typeof prop.content === "string" ? `\`${prop.content}\`` : "";
        break;
      case "link": {
        const text = typeof prop.content === "string" ? prop.content : "Link";
        const url = asCardObj(prop.url)?.url;
        out += typeof url === "string" && url ? `[${text}](${url})` : text;
        break;
      }
      case "at":
        out += resolveAtTagText(prop, ctx);
        break;
      case "at_all":
        out += "@所有人";
        break;
      default:
        out += extractElementText(obj, ctx);
        break;
    }
  }
  return out.trim();
}

function formatTableCell(data: unknown): string {
  if (typeof data === "string") return data;
  if (typeof data === "number") return String(data);
  if (Array.isArray(data)) {
    return data
      .map((item) => {
        const obj = asCardObj(item);
        return typeof obj?.text === "string" ? obj.text : "";
      })
      .filter(Boolean)
      .join(", ");
  }
  return extractI18nOrText(data);
}

function renderTable(prop: CardObj): string {
  const columns = Array.isArray(prop.columns) ? prop.columns.map(asCardObj).filter((c): c is CardObj => Boolean(c)) : [];
  if (columns.length === 0) return "";
  const colNames = columns.map((c) => String(c.displayName || c.name || ""));
  const colKeys = columns.map((c) => String(c.name || ""));
  const rows = Array.isArray(prop.rows) ? prop.rows.map(asCardObj).filter((r): r is CardObj => Boolean(r)) : [];
  const lines = [
    `| ${colNames.join(" | ")} |`,
    `|${colNames.map(() => "------").join("|")}|`,
  ];
  for (const row of rows) {
    const cells = colKeys.map((key) => {
      const cell = asCardObj(row[key]);
      return cell && cell.data !== undefined ? formatTableCell(cell.data) : "";
    });
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

function renderCodeBlock(prop: CardObj): string {
  const lang = typeof prop.language === "string" ? prop.language : "";
  if (typeof prop.content === "string") return `\`\`\`${lang}\n${prop.content}\n\`\`\``;
  if (Array.isArray(prop.contents)) {
    const lines: string[] = [];
    for (const line of prop.contents) {
      const lm = asCardObj(line);
      const chunks = Array.isArray(lm?.contents) ? lm.contents : [];
      const lineStr = chunks.map((c) => {
        const cm = asCardObj(c);
        return typeof cm?.content === "string" ? cm.content : "";
      }).join("");
      lines.push(lineStr);
    }
    return `\`\`\`${lang}\n${lines.join("")}\n\`\`\``;
  }
  return "";
}

function extractElementText(value: unknown, ctx: CardAttachmentContext): string {
  if (!value) return "";
  if (Array.isArray(value)) {
    return value.map((child) => extractElementText(child, ctx)).filter(Boolean).join("\n");
  }
  const node = asCardObj(value);
  if (!node) return "";

  const tag = typeof node.tag === "string" ? node.tag : "";
  if (IGNORED_CARD_TAGS.has(tag)) return "";
  const prop = unwrapProperty(node);

  switch (tag) {
    case "markdown":
    case "markdown_v1": {
      if (Array.isArray(prop.elements) && prop.elements.length > 0) {
        return renderInlineElements(prop.elements, ctx);
      }
      if (typeof prop.content === "string" && prop.content) return prop.content;
      const fallback = asCardObj(node.fallback);
      return fallback ? extractElementText(fallback, ctx) : "";
    }
    case "lark_md":
    case "plain_text":
    case "text":
      return extractI18nOrText(prop);
    case "div": {
      const parts: string[] = [];
      if (prop.text) parts.push(extractElementText(prop.text, ctx) || extractI18nOrText(prop.text));
      if (Array.isArray(prop.fields)) {
        for (const f of prop.fields) {
          const fm = asCardObj(f);
          if (fm?.text) parts.push(extractElementText(fm.text, ctx) || extractI18nOrText(fm.text));
        }
      }
      if (prop.extra) parts.push(extractElementText(prop.extra, ctx));
      return parts.filter(Boolean).join("\n");
    }
    case "note":
    case "actions":
    case "action":
    case "form":
    case "interactive_container":
    case "repeat":
      return Array.isArray(prop.elements)
        ? prop.elements.map((el) => extractElementText(el, ctx)).filter(Boolean).join("\n")
        : "";
    case "column_set":
      return Array.isArray(prop.columns)
        ? prop.columns.map((col) => extractElementText(col, ctx)).filter(Boolean).join("\n")
        : "";
    case "column":
      return Array.isArray(prop.elements)
        ? prop.elements.map((el) => extractElementText(el, ctx)).filter(Boolean).join("\n")
        : "";
    case "collapsible_panel": {
      const parts: string[] = [];
      const header = asCardObj(prop.header);
      const title = header?.title ? extractI18nOrText(header.title) : "";
      if (title) parts.push(title);
      if (Array.isArray(prop.elements)) {
        const inner = prop.elements.map((el) => extractElementText(el, ctx)).filter(Boolean).join("\n");
        if (inner) parts.push(inner);
      }
      return parts.join("\n");
    }
    case "table":
      return renderTable(prop);
    case "list":
      return Array.isArray(prop.items)
        ? prop.items.map((item) => {
          const im = asCardObj(item);
          if (!im || !Array.isArray(im.elements)) return "";
          const marker = im.type === "ol" && typeof im.order === "number" ? `${Math.floor(im.order)}.` : "-";
          return `${marker} ${renderInlineElements(im.elements, ctx)}`;
        }).filter(Boolean).join("\n")
        : "";
    case "blockquote":
      return typeof prop.content === "string"
        ? prop.content
        : (Array.isArray(prop.elements) ? renderInlineElements(prop.elements, ctx) : "");
    case "heading": {
      const level = typeof prop.level === "number" ? Math.min(Math.max(Math.floor(prop.level), 1), 6) : 1;
      const content = typeof prop.content === "string"
        ? prop.content
        : (Array.isArray(prop.elements) ? renderInlineElements(prop.elements, ctx) : "");
      return content ? `${"#".repeat(level)} ${content}` : "";
    }
    case "code_block":
      return renderCodeBlock(prop);
    case "code_span":
      return typeof prop.content === "string" ? `\`${prop.content}\`` : "";
    case "button": {
      const label = extractI18nOrText(prop.text ?? prop.content);
      return label;
    }
    case "at":
      return resolveAtTagText(prop, ctx);
    case "at_all":
      return "@所有人";
    case "person":
    case "person_v1":
      return resolvePersonText(prop, ctx);
    case "person_list":
      return Array.isArray(prop.persons)
        ? prop.persons.map((p) => {
          const pm = asCardObj(p);
          const id = typeof pm?.id === "string" ? pm.id : "";
          const info = asCardObj(ctx.persons?.[id]);
          return (typeof info?.content === "string" && info.content) || id;
        }).filter(Boolean).join(", ")
        : "";
    case "local_datetime": {
      const ms = Number(prop.milliseconds);
      if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
      return typeof prop.fallbackText === "string" ? prop.fallbackText : "";
    }
    case "text_tag":
    case "number_tag":
      return extractI18nOrText(prop.text);
    case "fallback_text":
      return prop.text
        ? extractI18nOrText(prop.text)
        : (Array.isArray(prop.elements) ? renderInlineElements(prop.elements, ctx) : "");
    case "hr":
      return "---";
    case "br":
      return "";
    default: {
      // 递归常见容器字段，覆盖未知或自定义嵌套卡片结构。
      const parts: string[] = [];
      for (const key of ["content", "text", "title", "label", "placeholder"]) {
        const extracted = extractI18nOrText(prop[key]);
        if (extracted) {
          parts.push(extracted);
          break;
        }
      }
      if (Array.isArray(prop.elements)) {
        const nested = prop.elements.map((el) => extractElementText(el, ctx)).filter(Boolean).join("\n");
        if (nested) parts.push(nested);
      }
      if (Array.isArray(prop.columns)) {
        const nested = prop.columns.map((el) => extractElementText(el, ctx)).filter(Boolean).join("\n");
        if (nested) parts.push(nested);
      }
      if (Array.isArray(prop.children)) {
        const nested = prop.children.map((el) => extractElementText(el, ctx)).filter(Boolean).join("\n");
        if (nested) parts.push(nested);
      }
      return parts.filter(Boolean).join("\n");
    }
  }
}

/** 抽取常见卡片 schema（1.0 / 2.0 / raw_card_content）的可读文字，不负责调用平台 API。 */
export function extractInteractiveText(parsed: unknown, mentions: MentionInfo[] = []): string {
  const outer = asCardObj(parsed);
  if (!outer) return "";

  const ctx: CardAttachmentContext = {
    mentionsByKey: new Map(mentions.filter((m) => m.key).map((m) => [m.key, m])),
  };

  let root = outer;
  if (typeof outer.json_card === "string") {
    try {
      const inner = asCardObj(JSON.parse(outer.json_card));
      if (inner) root = inner;
    } catch {
      // Keep outer when json_card cannot be parsed.
    }
    let attObj = asCardObj(outer.json_attachment);
    if (!attObj && typeof outer.json_attachment === "string" && outer.json_attachment.trim()) {
      try {
        attObj = asCardObj(JSON.parse(outer.json_attachment));
      } catch {
        attObj = undefined;
      }
    }
    if (attObj) {
      ctx.atUsers = asCardObj(attObj.at_users);
      ctx.persons = asCardObj(attObj.persons);
    }
  }

  const parts: string[] = [];
  const header = asCardObj(root.header);
  const headerProp = header ? unwrapProperty(header) : undefined;
  const headerTitle = headerProp ? extractI18nOrText(headerProp.title) : "";
  const rootTitle = extractI18nOrText(root.title);
  const titleText = (headerTitle || rootTitle).trim();
  if (titleText) parts.push(titleText);

  const headerSubtitle = headerProp ? extractI18nOrText(headerProp.subtitle).trim() : "";
  if (headerSubtitle) parts.push(headerSubtitle);

  const body = asCardObj(root.body);
  const bodyProp = body ? unwrapProperty(body) : undefined;
  const bodyElements = bodyProp?.elements;
  const bodyText = Array.isArray(bodyElements)
    ? bodyElements.map((el) => extractElementText(el, ctx)).filter(Boolean).join("\n")
    : "";
  if (bodyText) parts.push(bodyText);

  const hasBodyElements = Array.isArray(bodyElements) ? bodyElements.length > 0 : Boolean(bodyElements);
  if ((!hasBodyElements || !bodyText) && Array.isArray(root.elements)) {
    const rootElementsText = root.elements.map((el) => extractElementText(el, ctx)).filter(Boolean).join("\n");
    if (rootElementsText) parts.push(rootElementsText);
  }

  return parts.map((part) => part.trim()).filter(Boolean).join("\n");
}

type ParsedCard = {
  text: string;
  isJson: boolean;
};

function parseCard(rawContent: string | undefined | null, mentions: MentionInfo[] = []): ParsedCard {
  const raw = rawContent?.trim() ?? "";
  try {
    return { text: extractInteractiveText(JSON.parse(raw), mentions), isJson: true };
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
  const parsed = parseCard(rawContent, mentions);
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
  const initial = parseCard(rawContent, mentions);
  let text = initial.text;

  if (fetchOriginal && (!initial.isJson || isDegradedCardText(text))) {
    let originalRaw: string | undefined;
    try {
      originalRaw = await fetchOriginal();
    } catch {
      originalRaw = undefined;
    }
    if (originalRaw) {
      const original = parseCard(originalRaw, mentions);
      if (!isDegradedCardText(original.text)) text = original.text;
    }
  }

  return formatCardText(text, mentions);
}
