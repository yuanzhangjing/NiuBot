import { describe, expect, test } from "vitest";
import {
  appendFuseNotice,
  BOT_COLLAB_FUSE_NOTICE,
  invertFeishuAtsToShortLabels,
  mapOutsideAtTags,
  rewriteOutboundMentions,
  type MentionUser,
} from "./mentions.js";

const self: MentionUser = { id: "u3", platformId: "ou_self", name: "NiuBot", isBot: true };
const cow: MentionUser = { id: "u4", platformId: "ou_cow", name: "CowBot", isBot: true };
const zen: MentionUser = { id: "u2", platformId: "ou_zen", name: "Zen", isBot: false };
const users = [self, cow, zen];

describe("rewriteOutboundMentions", () => {
  test("converts @U4(CowBot) and @U4 and @u4", () => {
    expect(rewriteOutboundMentions("hi @U4(CowBot)", users, { selfUserId: "u3" }).text)
      .toBe('hi <at user_id="ou_cow">CowBot</at>');
    expect(rewriteOutboundMentions("hi @U4", users, { selfUserId: "u3" }).text)
      .toBe('hi <at user_id="ou_cow">CowBot</at>');
    expect(rewriteOutboundMentions("hi @u4", users, { selfUserId: "u3" }).text)
      .toBe('hi <at user_id="ou_cow">CowBot</at>');
  });

  test("does not wrap existing Feishu at tags", () => {
    const text = 'see <at user_id="ou_cow">CowBot</at> please';
    expect(rewriteOutboundMentions(text, users, { selfUserId: "u3" }).text).toBe(text);
  });

  test("leaves unknown short ids unchanged", () => {
    expect(rewriteOutboundMentions("hi @U99", users, { selfUserId: "u3" }).text).toBe("hi @U99");
  });

  test("marks other-bot mentions and ignores self and humans", () => {
    expect(rewriteOutboundMentions("@U4", users, { selfUserId: "u3" }).mentionedOtherBot).toBe(true);
    expect(rewriteOutboundMentions("@U4", users, { selfUserId: "u3" }).mentionedNonSelf).toBe(true);
    expect(rewriteOutboundMentions("@U3", users, { selfUserId: "u3" }).mentionedOtherBot).toBe(false);
    expect(rewriteOutboundMentions("@U3", users, { selfUserId: "u3" }).mentionedNonSelf).toBe(false);
    expect(rewriteOutboundMentions("@U2", users, { selfUserId: "u3" }).mentionedOtherBot).toBe(false);
    expect(rewriteOutboundMentions("@U2", users, { selfUserId: "u3" }).mentionedNonSelf).toBe(true);
    expect(rewriteOutboundMentions("plain", users, { selfUserId: "u3" }).mentionedOtherBot).toBe(false);
  });

  test("strips other bot at tags but keeps humans and self", () => {
    const source = '@U4 and <at user_id="ou_cow">CowBot</at> and @U2 and @U3';
    const result = rewriteOutboundMentions(source, users, { selfUserId: "u3", stripOtherBotAts: true });
    expect(result.stripped).toBe(true);
    expect(result.mentionedOtherBot).toBe(true);
    expect(result.text).toBe(
      'CowBot and CowBot and <at user_id="ou_zen">Zen</at> and <at user_id="ou_self">NiuBot</at>',
    );
  });

  test("strip is a no-op when there is no other-bot at", () => {
    const result = rewriteOutboundMentions("hello @U2", users, { selfUserId: "u3", stripOtherBotAts: true });
    expect(result.stripped).toBe(false);
    expect(result.text).toBe('hello <at user_id="ou_zen">Zen</at>');
  });
});

describe("mapOutsideAtTags", () => {
  test("rewrites only plaintext segments", () => {
    const out = mapOutsideAtTags('a <at user_id="x">X</at> b', (chunk) => chunk.toUpperCase());
    expect(out).toBe('A <at user_id="x">X</at> B');
  });
});

describe("invertFeishuAtsToShortLabels", () => {
  test("turns Feishu ats back into short labels", () => {
    const sent = rewriteOutboundMentions("hi @U4(CowBot) and @U2", users, { selfUserId: "u3" }).text;
    expect(invertFeishuAtsToShortLabels(sent, users)).toBe("hi @U4(CowBot) and @U2(Zen)");
  });

  test("unknown at falls back to the inner name", () => {
    expect(invertFeishuAtsToShortLabels('<at user_id="ou_x">Mystery</at>', users)).toBe("@Mystery");
  });
});

describe("appendFuseNotice", () => {
  test("appends once", () => {
    expect(appendFuseNotice("done")).toBe(`done\n\n${BOT_COLLAB_FUSE_NOTICE}`);
    expect(appendFuseNotice(`done\n\n${BOT_COLLAB_FUSE_NOTICE}`)).toBe(`done\n\n${BOT_COLLAB_FUSE_NOTICE}`);
  });
});
