/**
 * 飞书全消息类型通用文本抽取与格式化（参考官方 lark-cli convert_lib）。
 * 供实时入站（adapter.ts）、合并转发子节点与历史同步（history.ts）共享。
 */

import type { MentionInfo, NormalizedMessage } from "../types.js";
import { dateTimeInTimeZone } from "../../tz.js";

/** 替换文本中的飞书 @_user_k / @_all 占位符。 */
export function replaceFeishuMentionKeys(text: string, mentions: MentionInfo[]): string {
  let out = text;
  for (const mention of mentions) {
    if (!mention.key) continue;
    const replacement = mention.key === "@_all" || mention.platformUserId === "@_all"
      ? "@所有人"
      : `@${mention.name?.trim() || mention.platformUserId}`;
    out = out.replaceAll(mention.key, replacement);
  }
  return out;
}

/** 从 API 响应的 raw mentions 数组规范化为 MentionInfo[]。 */
export function parseRawFeishuMentions(
  raw: unknown,
  botOpenId?: string | null,
  appId?: string | null,
): { mentions: MentionInfo[]; botMentioned: boolean } {
  const mentions: MentionInfo[] = [];
  let botMentioned = false;
  if (!Array.isArray(raw)) return { mentions, botMentioned };
  for (const item of raw) {
    const rawId = item?.id;
    const mentionId = typeof rawId === "string"
      ? rawId
      : (rawId?.open_id || rawId?.app_id || rawId?.user_id || "");
    const isBot = Boolean(mentionId && (mentionId === botOpenId || mentionId === appId));
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

const POST_LOCALE_KEY_RE = /^[a-z]{2}(?:_[a-z0-9]{2,4})?$/i;

function hasPostBlocks(obj: unknown): boolean {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const candidate = obj as Record<string, any>;
  return Array.isArray(candidate.content_v2) || Array.isArray(candidate.content);
}

/** 展开飞书富文本（post）的语言包装层，兼容直接 body 与 { zh_cn / en_us / ... } 结构。 */
export function unwrapPostLocale(parsed: unknown): Record<string, any> | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const root = parsed as Record<string, any>;
  if (hasPostBlocks(root)) return root;
  if ("summary" in root && ("due_time" in root || "task_id" in root)) return undefined;
  for (const locale of ["zh_cn", "en_us", "ja_jp"]) {
    if (hasPostBlocks(root[locale])) return root[locale];
  }
  for (const key of Object.keys(root).sort()) {
    if (!POST_LOCALE_KEY_RE.test(key)) continue;
    if (hasPostBlocks(root[key])) return root[key];
  }
  if (typeof root.title === "string" && !("summary" in root) && !("template" in root)) return root;
  return undefined;
}

/** 判断解析后的 JSON 是否像飞书 post 富文本结构。 */
export function isFeishuPostPayload(parsed: unknown): boolean {
  return hasPostBlocks(unwrapPostLocale(parsed));
}

function selectPostBlocks(body: Record<string, any>): unknown[] {
  if (Array.isArray(body.content_v2) && body.content_v2.length > 0) return body.content_v2;
  return Array.isArray(body.content) ? body.content : [];
}

function applyPostStyle(text: string, style: unknown): string {
  if (!text || !Array.isArray(style) || style.length === 0) return text;
  let out = text;
  if (style.includes("bold")) out = `**${out}**`;
  if (style.includes("italic")) out = `*${out}*`;
  if (style.includes("underline")) out = `<u>${out}</u>`;
  if (style.includes("lineThrough")) out = `~~${out}~~`;
  return out;
}

function renderPostSyncElement(element: Record<string, any>, mentions: MentionInfo[]): string {
  switch (element.tag) {
    case "text":
      return applyPostStyle(typeof element.text === "string" ? element.text : "", element.style);
    case "a":
      return applyPostStyle(String(element.text ?? element.href ?? ""), element.style);
    case "at": {
      const userId = element.user_id;
      if (userId === "@_all" || userId === "all") return "@所有人";
      const mention = mentions.find((m) => m.platformUserId === userId);
      const label = mention?.name || element.user_name || (userId ? String(userId) : "用户");
      return `@${label}`;
    }
    case "emotion":
      return element.emoji_type ? `[${element.emoji_type}]` : "";
    case "md":
      return typeof element.text === "string" ? element.text : "";
    case "code_block": {
      const lang = typeof element.language === "string" ? element.language : "";
      const code = typeof element.text === "string" ? element.text : "";
      return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
    }
    case "hr":
      return "\n---\n";
    case "media":
      return element.file_name
        ? `[视频: ${element.file_name}]`
        : (element.file_key ? `[视频: ${element.file_key}]` : "[视频]");
    case "img":
      return "[图片]";
    default:
      return typeof element.text === "string" ? element.text : "";
  }
}

function renderPostFilesZone(parsed: Record<string, any>): string[] {
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) return [];
  const lines: string[] = [];
  for (const f of parsed.files) {
    if (!f || typeof f !== "object") continue;
    const file = f as Record<string, any>;
    const name = file.file_name || file.file_key;
    if (!name) continue;
    lines.push(file.is_folder ? `[文件夹: ${name}]` : `[文件: ${name}]`);
  }
  return lines;
}

/** 同步提取 post 富文本内容（不下载图片；适用于合并转发与历史同步）。 */
export function extractPostTextSync(parsed: unknown, mentions: MentionInfo[] = []): string {
  const root = parsed && typeof parsed === "object" ? parsed as Record<string, any> : {};
  const body = unwrapPostLocale(root);
  const parts: string[] = [];
  if (body?.title) parts.push(String(body.title));
  if (body) {
    for (const paragraph of selectPostBlocks(body)) {
      if (!Array.isArray(paragraph)) continue;
      const lineTexts: string[] = [];
      for (const item of paragraph) {
        if (!item || typeof item !== "object") continue;
        const rendered = renderPostSyncElement(item as Record<string, any>, mentions);
        if (rendered) lineTexts.push(rendered);
      }
      const line = lineTexts.join("").trim();
      if (line) parts.push(line);
    }
  }
  parts.push(...renderPostFilesZone(root));
  return replaceFeishuMentionKeys(parts.join("\n").trim(), mentions);
}

/** 异步提取 post 富文本内容，支持为内嵌 img 元素下载图片并注入本地路径。 */
export async function extractPostContentAsync(
  parsed: unknown,
  mentions: MentionInfo[],
  downloadImage?: (imageKey: string) => Promise<string | null | undefined>,
): Promise<string> {
  const root = parsed && typeof parsed === "object" ? parsed as Record<string, any> : {};
  const body = unwrapPostLocale(root);
  const parts: string[] = [];
  if (body?.title) parts.push(String(body.title));
  if (body) {
    for (const paragraph of selectPostBlocks(body)) {
      if (!Array.isArray(paragraph)) continue;
      const lineTexts: string[] = [];
      for (const item of paragraph) {
        if (!item || typeof item !== "object") continue;
        const element = item as Record<string, any>;
        if (element.tag === "img") {
          const imageKey = typeof element.image_key === "string" ? element.image_key : "";
          const filePath = imageKey && downloadImage ? await downloadImage(imageKey) : undefined;
          lineTexts.push(filePath ? `[图片: ${filePath}]` : "[图片]");
          continue;
        }
        const rendered = renderPostSyncElement(element, mentions);
        if (rendered) lineTexts.push(rendered);
      }
      const line = lineTexts.join("").trim();
      if (line) parts.push(line);
    }
  }
  parts.push(...renderPostFilesZone(root));
  return replaceFeishuMentionKeys(parts.join("\n").trim(), mentions);
}

/** 格式化音视频毫秒时长为秒数标签；非法或非正数返回空串。 */
export function formatFeishuDurationSec(raw: unknown): string {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? `${Math.round(n / 1000)}秒` : "";
}

/** 把飞书秒/毫秒时间戳字符串格式化为配置时区的时间文本。 */
function formatFeishuEpoch(raw: unknown): string {
  const str = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!str) return "";
  const num = Number(str);
  if (!Number.isFinite(num) || num <= 0) return "";
  const ms = num > 1e12 ? num : num * 1000;
  if (!Number.isFinite(ms) || ms > 8.64e15) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return dateTimeInTimeZone(d);
}

function formatCalendarSummary(parsed: Record<string, any>): string {
  const lines: string[] = [];
  if (typeof parsed.summary === "string" && parsed.summary.trim()) lines.push(parsed.summary.trim());
  const start = formatFeishuEpoch(parsed.start_time);
  const end = formatFeishuEpoch(parsed.end_time);
  if (start && end) lines.push(`${start} ~ ${end}`);
  else if (start) lines.push(start);
  return lines.length > 0 ? `[日程] ${lines.join(" · ")}` : "[日程]";
}

function formatTodoSummary(parsed: Record<string, any>): string {
  const lines: string[] = [];
  const summary = parsed.summary && typeof parsed.summary === "object"
    ? parsed.summary as Record<string, any>
    : undefined;
  if (summary?.title) lines.push(String(summary.title));
  if (Array.isArray(summary?.content)) {
    const bodyText = extractPostTextSync({ content: summary.content });
    if (bodyText) lines.push(bodyText);
  }
  const due = formatFeishuEpoch(parsed.due_time);
  if (due) lines.push(`截止: ${due}`);
  return lines.length > 0 ? `[待办] ${lines.join(" | ")}` : "[待办]";
}

function formatVoteSummary(parsed: Record<string, any>): string {
  const parts: string[] = [];
  if (typeof parsed.topic === "string" && parsed.topic.trim()) parts.push(parsed.topic.trim());
  if (Array.isArray(parsed.options)) {
    const opts = parsed.options.filter((o): o is string => typeof o === "string" && o.length > 0);
    if (opts.length > 0) parts.push(opts.map((o) => `• ${o}`).join(" "));
  }
  if (typeof parsed.status === "number" && parsed.status !== 0) parts.push("(已结束)");
  return parts.length > 0 ? `[投票] ${parts.join(" | ")}` : "[投票]";
}

function formatSystemMessage(parsed: Record<string, any>): string {
  const template = typeof parsed.template === "string" ? parsed.template : "";
  if (!template) return "[系统消息]";
  const joinList = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0).join(", ") : "";
  const dividerText = parsed.divider_text && typeof parsed.divider_text === "object"
    ? String((parsed.divider_text as Record<string, any>).text ?? "")
    : "";
  const fixedFields: Record<string, string> = {
    from_user: joinList(parsed.from_user),
    to_chatters: joinList(parsed.to_chatters),
    divider_text: dividerText,
  };
  const out = template
    .replace(/\{(\w+)\}/g, (match, key: string) => {
      if (Object.hasOwn(fixedFields, key)) return fixedFields[key];
      return Object.hasOwn(parsed, key) && typeof parsed[key] === "string" && parsed[key] ? parsed[key] : match;
    })
    .trim();
  return out || "[系统消息]";
}

/**
 * 将已完成 JSON.parse 的非下载类飞书消息统一转为可读文本与 contentType。
 * 供实时入站（非下载回退/杂项类型）、合并转发子节点与群历史同步共享。
 */
export function formatFeishuStructuredContent(
  msgType: string,
  parsed: Record<string, any>,
  mentions: MentionInfo[] = [],
  options?: { audioVerbose?: boolean },
): { text: string; contentType: NormalizedMessage["contentType"] } {
  switch (msgType) {
    case "text":
      return {
        text: replaceFeishuMentionKeys(typeof parsed.text === "string" ? parsed.text : "", mentions),
        contentType: "text",
      };
    case "post": {
      const text = extractPostTextSync(parsed, mentions);
      return { text, contentType: text.includes("[图片:") ? "mixed" : "post" };
    }
    case "image":
      return { text: "[图片]", contentType: "image" };
    case "file":
      return { text: parsed.file_name ? `[文件: ${parsed.file_name}]` : "[文件]", contentType: "file" };
    case "folder":
      return { text: parsed.file_name ? `[文件夹: ${parsed.file_name}]` : "[文件夹]", contentType: "file" };
    case "audio": {
      const dur = formatFeishuDurationSec(parsed.duration);
      if (options?.audioVerbose) {
        return {
          text: `用户发送了一段语音${dur ? `（${dur}）` : ""}，当前不支持语音消息`,
          contentType: "audio",
        };
      }
      return { text: dur ? `[语音（${dur}）]` : "[语音]", contentType: "audio" };
    }
    case "video":
    case "media":
      return { text: parsed.file_name ? `[视频: ${parsed.file_name}]` : "[视频]", contentType: "media" };
    case "sticker":
      return { text: "[表情]", contentType: "text" };
    case "share_chat":
      return { text: parsed.chat_id ? `[分享群聊: ${parsed.chat_id}]` : "[分享群聊]", contentType: "text" };
    case "share_user":
      return { text: parsed.user_id ? `[分享名片: ${parsed.user_id}]` : "[分享名片]", contentType: "text" };
    case "location":
      return { text: parsed.name ? `[位置: ${parsed.name}]` : "[位置]", contentType: "text" };
    case "share_calendar_event":
    case "calendar":
    case "general_calendar":
      return { text: formatCalendarSummary(parsed), contentType: "text" };
    case "video_chat":
      return { text: parsed.topic ? `[视频会议: ${parsed.topic}]` : "[视频会议]", contentType: "text" };
    case "todo":
      return { text: formatTodoSummary(parsed), contentType: "text" };
    case "vote":
      return { text: formatVoteSummary(parsed), contentType: "text" };
    case "hongbao":
      return { text: parsed.text ? `[红包: ${parsed.text}]` : "[红包]", contentType: "text" };
    case "system":
      return { text: formatSystemMessage(parsed), contentType: "text" };
    default:
      return {
        text: typeof parsed.text === "string" && parsed.text
          ? replaceFeishuMentionKeys(parsed.text, mentions)
          : `[${msgType || "unknown"}]`,
        contentType: "text",
      };
  }
}
