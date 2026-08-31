/** 群聊 Bot 互叫：短号转飞书 at、检测其他 Bot at、保险丝剥 at。 */

export const BOT_COLLAB_FUSE_LIMIT = 20;
export const BOT_COLLAB_FUSE_NOTICE = "互叫已停，需要人接手。";

export type MentionUser = {
  id: string;
  platformId: string;
  name: string | null;
  isBot: boolean;
};

export type RewriteOutboundMentionsOptions = {
  selfUserId?: string | null;
  stripOtherBotAts?: boolean;
  /** 保险丝：剥掉所有 Bot at（含自己）。 */
  stripAllBotAts?: boolean;
};

export type SupplementMissingBotMentionOptions = {
  selfUserId?: string | null;
  /** 只允许补当前群已知的 Bot，避免把同名的别的群 Bot 叫醒。 */
  candidateBotIds?: readonly string[];
};

export type RewriteOutboundMentionsResult = {
  text: string;
  /** 转换后、剥 at 前，是否 at 了其他 Bot */
  mentionedOtherBot: boolean;
  /** 转换后是否 at 了自己以外的人（未标 is_bot 的对方 Bot 也算） */
  mentionedNonSelf: boolean;
  stripped: boolean;
};

function shortAtPattern(): RegExp {
  return /@U(\d+)(?:\(([^)]*)\))?/gi;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeMentionAlias(text: string): string {
  return text.trim().toLocaleLowerCase();
}

function feishuAtPattern(): RegExp {
  return /<at\s+(?:user_id="([^"]*)"|id="([^"]*)"|id=([^\s>"']+))>([\s\S]*?)<\/at>/gi;
}

export function hasFeishuAtTag(text: string): boolean {
  return feishuAtPattern().test(text);
}

const LEADING_AT_MENTION = /^(?:@U\d+(?:\([^)]*\))?|@[^\s/]+|<at\b[^>]*>[\s\S]*?<\/at>)[\s]*/i;

/** 去掉开头连续的 @某人，让群聊 `@Bot /help` 仍能识别为内置命令。 */
export function stripLeadingAtMentions(text: string): string {
  let result = text.trimStart();
  while (LEADING_AT_MENTION.test(result)) {
    result = result.replace(LEADING_AT_MENTION, "");
  }
  return result;
}

const TRAILING_AT_MENTION = /(?:[\s@]*@U\d+(?:\([^)]*\))?|[\s@]*@[^\s/]+|[\s]*<at\b[^>]*>[\s\S]*?<\/at>)+$/i;

/** 群聊认命令：剥开头/结尾的 at，以及 `/status@U3` 这种粘在命令上的 at。 */
export function extractBuiltinCommandText(text: string): string {
  let result = stripLeadingAtMentions(text.trim()).replace(TRAILING_AT_MENTION, "").replace(/@+$/g, "").trim();
  const glued = result.match(/^(\/\/?[A-Za-z0-9_-]+)@([\s\S]*)$/);
  if (!glued) return result;
  const rest = extractBuiltinCommandText(`@${glued[2]}`);
  return rest ? `${glued[1]} ${rest}` : glued[1];
}

export function mapFeishuAtTags(
  text: string,
  replace: (platformId: string, inner: string) => string,
): string {
  return text.replace(feishuAtPattern(), (full, userId?: string, idQuoted?: string, idBare?: string, inner?: string) => {
    const id = userId || idQuoted || idBare || "";
    return replace(id, inner ?? "");
  });
}

function feishuAtOuterPattern(): RegExp {
  return /<at\s+(?:user_id="[^"]*"|id="[^"]*"|id=[^\s>"']+)>[\s\S]*?<\/at>/gi;
}

function atPlatformId(match: RegExpMatchArray): string {
  return match[1] || match[2] || match[3] || "";
}

/** 卡片 markdown 用官方 `<at id>`；文本消息仍用 `<at user_id>`。 */
export function toCardAtTags(text: string): string {
  return text.replace(feishuAtPattern(), (full, userId?: string, idQuoted?: string, idBare?: string) => {
    const id = userId || idQuoted || idBare;
    if (!id) return full;
    return `<at id="${id}"></at>`;
  });
}

function isOtherBot(user: MentionUser | undefined, selfUserId?: string | null): boolean {
  return !!user?.isBot && user.id !== selfUserId;
}

/** 只改 at 标签外的文本，避免把已有 `<at>` 再包一层。 */
export function mapOutsideAtTags(text: string, rewrite: (chunk: string) => string): string {
  const parts: string[] = [];
  const re = feishuAtOuterPattern();
  let last = 0;
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0;
    parts.push(rewrite(text.slice(last, index)));
    parts.push(match[0]);
    last = index + match[0].length;
  }
  parts.push(rewrite(text.slice(last)));
  return parts.join("");
}

/** 代码块里的 @U2 是在讲语法，不要转成飞书 at。 */
function mapOutsideCode(text: string, rewrite: (chunk: string) => string): string {
  const parts: string[] = [];
  const fence = /```[\s\S]*?```/g;
  let last = 0;
  for (const match of text.matchAll(fence)) {
    const index = match.index ?? 0;
    parts.push(mapOutsideInlineCode(text.slice(last, index), rewrite));
    parts.push(match[0]);
    last = index + match[0].length;
  }
  parts.push(mapOutsideInlineCode(text.slice(last), rewrite));
  return parts.join("");
}

function mapOutsideInlineCode(text: string, rewrite: (chunk: string) => string): string {
  const parts: string[] = [];
  const inline = /`[^`]*`/g;
  let last = 0;
  for (const match of text.matchAll(inline)) {
    const index = match.index ?? 0;
    parts.push(rewrite(text.slice(last, index)));
    parts.push(match[0]);
    last = index + match[0].length;
  }
  parts.push(rewrite(text.slice(last)));
  return parts.join("");
}

function convertShortAts(text: string, byId: Map<string, MentionUser>): string {
  return mapOutsideAtTags(text, (chunk) =>
    mapOutsideCode(chunk, (plain) =>
      plain.replace(shortAtPattern(), (full, num: string) => {
        const user = byId.get(`u${num}`);
        if (!user?.platformId) return full;
        const name = user.name?.trim() || `U${num}`;
        return `<at user_id="${user.platformId}">${name}</at>`;
      }),
    ),
  );
}

/** 显示名也是真实 at 的一种写法；只转换唯一名称，重名时保留原文。 */
function convertNamedAts(text: string, users: MentionUser[]): string {
  const byName = new Map<string, MentionUser | null>();
  for (const user of users) {
    const name = normalizeMentionAlias(user.name ?? "");
    if (!name || /[\r\n]/u.test(name) || !user.platformId) continue;
    const existing = byName.get(name);
    if (existing && existing.id !== user.id) {
      byName.set(name, null);
    } else if (!byName.has(name)) {
      byName.set(name, user);
    }
  }

  const names = [...byName.entries()]
    .filter((entry): entry is [string, MentionUser] => entry[1] !== null)
    .sort((a, b) => b[0].length - a[0].length)
    .map(([name]) => escapeRegExp(name));
  if (names.length === 0) return text;

  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])@(${names.join("|")})(?![\\p{L}\\p{N}_])`,
    "giu",
  );
  return mapOutsideAtTags(text, (chunk) =>
    mapOutsideCode(chunk, (plain) => plain.replace(pattern, (full, rawName: string) => {
      const user = byName.get(normalizeMentionAlias(rawName));
      if (!user?.platformId) return full;
      const name = user.name?.trim() || rawName.trim();
      return `<at user_id="${user.platformId}">${name}</at>`;
    })),
  );
}

type TextRange = { start: number; end: number };

function mergeTextRanges(ranges: TextRange[]): TextRange[] {
  const sorted = [...ranges]
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }
  return merged;
}

/** 代码和引用里的文字不算交棒意图。 */
function protectedCodeQuoteRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (const match of text.matchAll(/<quoted\b[\s\S]*?<\/quoted>/gi)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }
  for (const match of text.matchAll(/```[\s\S]*?(?:```|$)/g)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }
  for (const match of text.matchAll(/`[^`]*`/g)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }

  let lineStart = 0;
  for (const lineBreak of text.matchAll(/\r?\n/g)) {
    const lineEnd = lineBreak.index ?? lineStart;
    if (/^\s*>/.test(text.slice(lineStart, lineEnd))) {
      ranges.push({ start: lineStart, end: lineEnd + lineBreak[0].length });
    }
    lineStart = lineEnd + lineBreak[0].length;
  }
  if (/^\s*>/.test(text.slice(lineStart))) {
    ranges.push({ start: lineStart, end: text.length });
  }
  return mergeTextRanges(ranges);
}

/** 代码、引用和已有 at 里的文字不算交棒意图。 */
function protectedMentionRanges(text: string): TextRange[] {
  const ranges = protectedCodeQuoteRanges(text);
  for (const match of text.matchAll(feishuAtOuterPattern())) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }
  return mergeTextRanges(ranges);
}

function unprotectedTextRanges(text: string, protectedRanges: TextRange[]): TextRange[] {
  const ranges: TextRange[] = [];
  let cursor = 0;
  for (const range of protectedRanges) {
    if (range.start > cursor) ranges.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < text.length) ranges.push({ start: cursor, end: text.length });
  return ranges;
}

function botAliases(
  users: MentionUser[],
  candidateBotIds: readonly string[] | undefined,
  selfUserId?: string | null,
): Map<string, MentionUser | null> {
  const candidates = new Set((candidateBotIds ?? []).map((id) => id.toLowerCase()));
  if (candidates.size === 0) return new Map();

  const aliases = new Map<string, MentionUser | null>();
  const addAlias = (alias: string, user: MentionUser) => {
    const normalized = normalizeMentionAlias(alias);
    if (!normalized || /[\r\n]/u.test(normalized)) return;
    const existing = aliases.get(normalized);
    if (existing && existing.id !== user.id) {
      aliases.set(normalized, null);
    } else if (!aliases.has(normalized)) {
      aliases.set(normalized, user);
    }
  };

  for (const user of users) {
    if (!user.isBot || !user.platformId || !candidates.has(user.id.toLowerCase())) continue;
    if (selfUserId && user.id === selfUserId) continue;
    addAlias(user.id, user);
    if (user.name) addAlias(user.name, user);
  }
  return aliases;
}

function hasOtherBotAtOutsideRanges(
  text: string,
  ranges: TextRange[],
  byPlatformId: Map<string, MentionUser>,
  selfUserId?: string | null,
): boolean {
  for (const range of unprotectedTextRanges(text, ranges)) {
    for (const match of text.slice(range.start, range.end).matchAll(feishuAtPattern())) {
      const user = byPlatformId.get(atPlatformId(match));
      if (isOtherBot(user, selfUserId)) return true;
    }
  }
  return false;
}

function hasHandoffCue(text: string, start: number, end: number): boolean {
  const boundary = /[。！？!?；;\n]/g;
  let clauseStart = 0;
  for (const match of text.slice(0, start).matchAll(boundary)) {
    clauseStart = (match.index ?? 0) + match[0].length;
  }
  const nextBoundary = text.slice(end).search(/[。！？!?；;\n]/);
  const clauseEnd = nextBoundary < 0 ? text.length : end + nextBoundary;
  const before = text.slice(clauseStart, start).trim();
  const after = text.slice(end, clauseEnd).trim();

  // “交给/下一棒/转给 CowBot”本身已经是明确交棒；“请/让/由 CowBot”还要有动作。
  if (/(?:交给|交棒给|转给|下一棒(?:是)?|轮到)[\s,，:：]*$/u.test(before)) return true;
  const action = /^(?:[,，:：]\s*)?(?:请\s*)?(?:你\s*)?(?:来\s*|去\s*)?(?:review(?:\s*一下)?|审阅|审核|审查|检查|看看|看一下|评审|确认|处理(?:一下)?|接着|继续|回复|接手|接棒)/iu;
  if (!action.test(after)) return false;
  return /(?:请|麻烦|让|由)\s*$/u.test(before) || before.length === 0;
}

/** 对唯一、明确的 Bot 交棒意图补真实 at；不确定时保持原文。 */
export function supplementMissingBotMention(
  text: string,
  users: MentionUser[],
  options: SupplementMissingBotMentionOptions = {},
): string {
  const aliases = botAliases(users, options.candidateBotIds, options.selfUserId);
  if (aliases.size === 0) return text;

  const aliasNames = [...aliases.entries()]
    .filter((entry): entry is [string, MentionUser] => entry[1] !== null)
    .sort((a, b) => b[0].length - a[0].length)
    .map(([alias]) => escapeRegExp(alias));
  if (aliasNames.length === 0) return text;

  const protectedRanges = protectedMentionRanges(text);
  const byPlatformId = new Map(users.filter((user) => user.platformId).map((user) => [user.platformId, user]));
  if (hasOtherBotAtOutsideRanges(text, protectedCodeQuoteRanges(text), byPlatformId, options.selfUserId)) return text;

  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_@])@?(${aliasNames.join("|")})(?![\\p{L}\\p{N}_])`,
    "giu",
  );
  const matches: Array<{ user: MentionUser; start: number; end: number }> = [];
  for (const range of unprotectedTextRanges(text, protectedRanges)) {
    const chunk = text.slice(range.start, range.end);
    for (const match of chunk.matchAll(pattern)) {
      const user = aliases.get(normalizeMentionAlias(match[1] ?? ""));
      if (!user?.platformId) continue;
      matches.push({
        user,
        start: range.start + (match.index ?? 0),
        end: range.start + (match.index ?? 0) + match[0].length,
      });
    }
  }
  if (matches.length !== 1) return text;
  const match = matches[0]!;
  if (!hasHandoffCue(text, match.start, match.end)) return text;

  const name = match.user.name?.trim() || match.user.id.toUpperCase();
  const tag = `<at user_id="${match.user.platformId}">${name}</at>`;
  return `${text.slice(0, match.start)}${tag}${text.slice(match.end)}`;
}

function mentionedOtherBotIn(text: string, byPlatformId: Map<string, MentionUser>, selfUserId?: string | null): boolean {
  for (const match of text.matchAll(feishuAtPattern())) {
    const user = byPlatformId.get(atPlatformId(match));
    if (isOtherBot(user, selfUserId)) return true;
  }
  return false;
}

function mentionedNonSelfIn(text: string, byPlatformId: Map<string, MentionUser>, selfUserId?: string | null): boolean {
  for (const match of text.matchAll(feishuAtPattern())) {
    const user = byPlatformId.get(atPlatformId(match));
    if (selfUserId && user?.id === selfUserId) continue;
    return true;
  }
  return false;
}

function stripOtherBotAtTags(text: string, byPlatformId: Map<string, MentionUser>, selfUserId?: string | null): string {
  return text.replace(feishuAtPattern(), (full, userId?: string, idQuoted?: string, idBare?: string, name?: string) => {
    const platformId = userId || idQuoted || idBare || "";
    const user = byPlatformId.get(platformId);
    if (isOtherBot(user, selfUserId)) return user?.name?.trim() || name?.trim() || "";
    return full;
  });
}

function stripAllBotAtTags(text: string, byPlatformId: Map<string, MentionUser>): string {
  return text.replace(feishuAtPattern(), (full, userId?: string, idQuoted?: string, idBare?: string, name?: string) => {
    const platformId = userId || idQuoted || idBare || "";
    const user = byPlatformId.get(platformId);
    if (user?.isBot) return user.name?.trim() || name?.trim() || "";
    return full;
  });
}

export function rewriteOutboundMentions(
  text: string,
  users: MentionUser[],
  options: RewriteOutboundMentionsOptions = {},
): RewriteOutboundMentionsResult {
  const byId = new Map(users.map((user) => [user.id.toLowerCase(), user]));
  const byPlatformId = new Map(users.filter((user) => user.platformId).map((user) => [user.platformId, user]));
  const converted = convertNamedAts(convertShortAts(text, byId), users);
  const mentionedOtherBot = mentionedOtherBotIn(converted, byPlatformId, options.selfUserId);
  const mentionedNonSelf = mentionedNonSelfIn(converted, byPlatformId, options.selfUserId);
  if (options.stripAllBotAts) {
    const strippedText = stripAllBotAtTags(converted, byPlatformId);
    return {
      text: strippedText,
      mentionedOtherBot,
      mentionedNonSelf,
      stripped: strippedText !== converted,
    };
  }
  if (!options.stripOtherBotAts) {
    return { text: converted, mentionedOtherBot, mentionedNonSelf, stripped: false };
  }
  const strippedText = stripOtherBotAtTags(converted, byPlatformId, options.selfUserId);
  const stripped = strippedText !== converted;
  return { text: strippedText, mentionedOtherBot, mentionedNonSelf, stripped };
}

export function appendFuseNotice(text: string): string {
  if (text.includes(BOT_COLLAB_FUSE_NOTICE)) return text;
  const trimmed = text.trimEnd();
  return trimmed ? `${trimmed}\n\n${BOT_COLLAB_FUSE_NOTICE}` : BOT_COLLAB_FUSE_NOTICE;
}

function shortLabel(id: string, name: string | null): string {
  const shortId = id.toUpperCase();
  return name?.trim() ? `${shortId}(${name.trim()})` : shortId;
}

/** 发出去的飞书 at 转回 @U4(Name)，供会话历史使用。 */
export function invertFeishuAtsToShortLabels(text: string, users: MentionUser[]): string {
  const byPlatformId = new Map(users.filter((user) => user.platformId).map((user) => [user.platformId, user]));
  return text.replace(feishuAtPattern(), (full, userId?: string, idQuoted?: string, idBare?: string, name?: string) => {
    const platformId = userId || idQuoted || idBare || "";
    const inner = name?.trim() ?? "";
    const user = byPlatformId.get(platformId);
    if (!user) return inner ? `@${inner}` : full;
    return `@${shortLabel(user.id, user.name ?? inner ?? null)}`;
  });
}
