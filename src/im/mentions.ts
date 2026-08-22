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
};

export type RewriteOutboundMentionsResult = {
  text: string;
  /** 转换后、剥 at 前，是否 at 了其他 Bot */
  mentionedOtherBot: boolean;
  /** 转换后是否 at 了自己以外的人（未标 is_bot 的对方 Bot 也算，避免首跳仍走卡片） */
  mentionedNonSelf: boolean;
  stripped: boolean;
};

function shortAtPattern(): RegExp {
  return /@U(\d+)(?:\(([^)]*)\))?/gi;
}

function feishuAtPattern(): RegExp {
  return /<at\s+user_id="([^"]*)">([\s\S]*?)<\/at>/gi;
}

function isOtherBot(user: MentionUser | undefined, selfUserId?: string | null): boolean {
  return !!user?.isBot && user.id !== selfUserId;
}

/** 只改 at 标签外的文本，避免把已有 `<at>` 再包一层。 */
export function mapOutsideAtTags(text: string, rewrite: (chunk: string) => string): string {
  const parts: string[] = [];
  const re = /<at\s+user_id="[^"]*">[\s\S]*?<\/at>/gi; // local instance, safe for matchAll
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

function convertShortAts(text: string, byId: Map<string, MentionUser>): string {
  return mapOutsideAtTags(text, (chunk) =>
    chunk.replace(shortAtPattern(), (full, num: string) => {
      const user = byId.get(`u${num}`);
      if (!user?.platformId) return full;
      const name = user.name?.trim() || `U${num}`;
      return `<at user_id="${user.platformId}">${name}</at>`;
    }),
  );
}

function mentionedOtherBotIn(text: string, byPlatformId: Map<string, MentionUser>, selfUserId?: string | null): boolean {
  for (const match of text.matchAll(feishuAtPattern())) {
    const user = byPlatformId.get(match[1] ?? "");
    if (isOtherBot(user, selfUserId)) return true;
  }
  return false;
}

function mentionedNonSelfIn(text: string, byPlatformId: Map<string, MentionUser>, selfUserId?: string | null): boolean {
  for (const match of text.matchAll(feishuAtPattern())) {
    const platformId = match[1] ?? "";
    const user = byPlatformId.get(platformId);
    if (selfUserId && user?.id === selfUserId) continue;
    return true;
  }
  return false;
}

function stripOtherBotAtTags(text: string, byPlatformId: Map<string, MentionUser>, selfUserId?: string | null): string {
  return text.replace(feishuAtPattern(), (full, platformId: string, name: string) => {
    const user = byPlatformId.get(platformId);
    if (isOtherBot(user, selfUserId)) return name;
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
  const converted = convertShortAts(text, byId);
  const mentionedOtherBot = mentionedOtherBotIn(converted, byPlatformId, options.selfUserId);
  const mentionedNonSelf = mentionedNonSelfIn(converted, byPlatformId, options.selfUserId);
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
  return text.replace(feishuAtPattern(), (full, platformId: string, name: string) => {
    const user = byPlatformId.get(platformId);
    if (!user) return name?.trim() ? `@${name.trim()}` : full;
    return `@${shortLabel(user.id, user.name ?? name ?? null)}`;
  });
}
