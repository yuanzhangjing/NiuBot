import { describe, expect, test } from "vitest";
import {
  appendFuseNotice,
  BOT_COLLAB_FUSE_NOTICE,
  hasFeishuAtTag,
  invertFeishuAtsToShortLabels,
  mapFeishuAtTags,
  mapOutsideAtTags,
  rewriteOutboundMentions,
  supplementMissingBotMention,
  extractBuiltinCommandText,
  stripLeadingAtMentions,
  toCardAtTags,
  type MentionUser,
} from "./mentions.js";

const self: MentionUser = { id: "u3", platformId: "ou_self", name: "NiuBot", isBot: true };
const cow: MentionUser = { id: "u4", platformId: "ou_cow", name: "CowBot", isBot: true };
const zen: MentionUser = { id: "u2", platformId: "ou_zen", name: "Zen", isBot: false };
const users = [self, cow, zen];

describe("stripLeadingAtMentions", () => {
  test("strips leading short labels and Feishu at tags before a command", () => {
    expect(stripLeadingAtMentions("@U3(NiuBot) /help")).toBe("/help");
    expect(stripLeadingAtMentions("@U3(NiuBot) @U4(CowBot) /new")).toBe("/new");
    expect(stripLeadingAtMentions("@NiuBot /status")).toBe("/status");
    expect(stripLeadingAtMentions("@U3(NiuBot)/help")).toBe("/help");
    expect(stripLeadingAtMentions("@U3(John Smith) /help")).toBe("/help");
    expect(stripLeadingAtMentions('<at user_id="ou_self">NiuBot</at> /help')).toBe("/help");
    expect(stripLeadingAtMentions("/help")).toBe("/help");
  });

  test("does not strip mentions after the command or ordinary text", () => {
    expect(stripLeadingAtMentions("看看 /help")).toBe("看看 /help");
    expect(stripLeadingAtMentions("/help @U4")).toBe("/help @U4");
    expect(stripLeadingAtMentions("@U3(NiuBot) 帮我 /help")).toBe("帮我 /help");
  });
});

describe("extractBuiltinCommandText", () => {
  test("accepts mention before, after, or glued to the command", () => {
    expect(extractBuiltinCommandText("@U3(NiuBot) /status")).toBe("/status");
    expect(extractBuiltinCommandText("/status@U3(NiuBot)")).toBe("/status");
    expect(extractBuiltinCommandText("/status@@U3(NiuBot)")).toBe("/status");
    expect(extractBuiltinCommandText("/status @U3(NiuBot)")).toBe("/status");
    expect(extractBuiltinCommandText("/model grok @U3")).toBe("/model grok");
  });
});

describe("rewriteOutboundMentions", () => {
  test("converts @U4(CowBot) and @U4 and @u4", () => {
    expect(rewriteOutboundMentions("hi @U4(CowBot)", users, { selfUserId: "u3" }).text)
      .toBe('hi <at user_id="ou_cow">CowBot</at>');
    expect(rewriteOutboundMentions("hi @U4", users, { selfUserId: "u3" }).text)
      .toBe('hi <at user_id="ou_cow">CowBot</at>');
    expect(rewriteOutboundMentions("hi @u4", users, { selfUserId: "u3" }).text)
      .toBe('hi <at user_id="ou_cow">CowBot</at>');
  });

  test("converts a unique display-name at into a Feishu at tag", () => {
    expect(rewriteOutboundMentions("请 @CowBot review", users, { selfUserId: "u3" }).text)
      .toBe('请 <at user_id="ou_cow">CowBot</at> review');
  });

  test("does not wrap existing Feishu at tags", () => {
    const text = 'see <at user_id="ou_cow">CowBot</at> please';
    expect(rewriteOutboundMentions(text, users, { selfUserId: "u3" }).text).toBe(text);
    const card = 'see <at id="ou_cow"></at> please';
    expect(rewriteOutboundMentions(card, users, { selfUserId: "u3" }).text).toBe(card);
    expect(rewriteOutboundMentions(card, users, { selfUserId: "u3" }).mentionedOtherBot).toBe(true);
  });

  test("does not convert short ats inside markdown code", () => {
    expect(rewriteOutboundMentions("用 `@U2` 这种短号", users, { selfUserId: "u3" }).text)
      .toBe("用 `@U2` 这种短号");
    expect(rewriteOutboundMentions("```\n@U4\n```", users, { selfUserId: "u3" }).text)
      .toBe("```\n@U4\n```");
    expect(rewriteOutboundMentions("plain @U2 and `@U4`", users, { selfUserId: "u3" }).text)
      .toBe('plain <at user_id="ou_zen">Zen</at> and `@U4`');
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
    const cardStrip = rewriteOutboundMentions('<at id="ou_cow"></at> ping', users, {
      selfUserId: "u3",
      stripOtherBotAts: true,
    });
    expect(cardStrip.text).toBe("CowBot ping");
  });

  test("strip is a no-op when there is no other-bot at", () => {
    const result = rewriteOutboundMentions("hello @U2", users, { selfUserId: "u3", stripOtherBotAts: true });
    expect(result.stripped).toBe(false);
    expect(result.text).toBe('hello <at user_id="ou_zen">Zen</at>');
  });

  test("stripAllBotAts removes every bot at including self", () => {
    const result = rewriteOutboundMentions("@U4 and @U3 and @U2", users, {
      selfUserId: "u3",
      stripAllBotAts: true,
    });
    expect(result.stripped).toBe(true);
    expect(result.mentionedOtherBot).toBe(true);
    expect(result.text).toBe("CowBot and NiuBot and <at user_id=\"ou_zen\">Zen</at>");
  });
});

describe("supplementMissingBotMention", () => {
  const sheep: MentionUser = { id: "u5", platformId: "ou_sheep", name: "SheepBot", isBot: true };

  test("supplements one clear handoff in the same outbound message", () => {
    expect(supplementMissingBotMention("请 CowBot review 这版", users, {
      selfUserId: "u3",
      candidateBotIds: ["u4"],
    })).toBe('请 <at user_id="ou_cow">CowBot</at> review 这版');
    expect(supplementMissingBotMention("CowBot，请 review 这版", users, {
      selfUserId: "u3",
      candidateBotIds: ["u4"],
    })).toBe('<at user_id="ou_cow">CowBot</at>，请 review 这版');
    expect(supplementMissingBotMention("交给 CowBot", users, {
      selfUserId: "u3",
      candidateBotIds: ["u4"],
    })).toBe('交给 <at user_id="ou_cow">CowBot</at>');
  });

  test("does not guess when the target or intent is unclear", () => {
    expect(supplementMissingBotMention("CowBot 已完成", users, {
      selfUserId: "u3",
      candidateBotIds: ["u4"],
    })).toBe("CowBot 已完成");
    expect(supplementMissingBotMention("请看一下", users, {
      selfUserId: "u3",
      candidateBotIds: ["u4"],
    })).toBe("请看一下");
    expect(supplementMissingBotMention("请 CowBot review，随后 SheepBot 检查", [...users, sheep], {
      selfUserId: "u3",
      candidateBotIds: ["u4", "u5"],
    })).toBe("请 CowBot review，随后 SheepBot 检查");
  });

  test("ignores code, quoted text, and an existing other-Bot at", () => {
    const source = [
      "> 请 CowBot review",
      "`请 CowBot review`",
      '<quoted speaker="U2(Zen)">请 CowBot review</quoted>',
      '请 CowBot review <at user_id="ou_sheep">SheepBot</at>',
    ].join("\n");
    expect(supplementMissingBotMention(source, [...users, sheep], {
      selfUserId: "u3",
      candidateBotIds: ["u4", "u5"],
    })).toBe(source);
  });
});

describe("mapOutsideAtTags", () => {
  test("rewrites only plaintext segments", () => {
    const out = mapOutsideAtTags('a <at user_id="x">X</at> b', (chunk) => chunk.toUpperCase());
    expect(out).toBe('A <at user_id="x">X</at> B');
  });

  test("does not rewrite inside card at tags", () => {
    const out = mapOutsideAtTags('a <at id="ou_cow"></at> b', (chunk) => chunk.toUpperCase());
    expect(out).toBe('A <at id="ou_cow"></at> B');
  });
});

describe("mapFeishuAtTags", () => {
  test("rewrites text and card at tags", () => {
    const out = mapFeishuAtTags(
      'hi <at user_id="ou_cow">CowBot</at> and <at id="ou_zen"></at>',
      (id, inner) => `@${inner || id}`,
    );
    expect(out).toBe("hi @CowBot and @ou_zen");
  });
});

describe("hasFeishuAtTag", () => {
  test("requires a complete Feishu at tag", () => {
    expect(hasFeishuAtTag('ping <at user_id="ou_cow">CowBot</at>')).toBe(true);
    expect(hasFeishuAtTag('<at id="ou_cow"></at>')).toBe(true);
    expect(hasFeishuAtTag("see <at ")).toBe(false);
    expect(hasFeishuAtTag("plain")).toBe(false);
  });
});

describe("toCardAtTags", () => {
  test("converts text at tags into card at tags", () => {
    expect(toCardAtTags('hi <at user_id="ou_cow">CowBot</at>')).toBe('hi <at id="ou_cow"></at>');
  });

  test("normalizes quoted and bare card at tags", () => {
    expect(toCardAtTags('<at id="ou_cow"></at>')).toBe('<at id="ou_cow"></at>');
    expect(toCardAtTags("<at id=ou_cow></at>")).toBe('<at id="ou_cow"></at>');
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

  test("inverts card at tags using the user table", () => {
    expect(invertFeishuAtsToShortLabels('<at id="ou_cow"></at>', users)).toBe("@U4(CowBot)");
    expect(invertFeishuAtsToShortLabels("<at id=ou_zen></at>", users)).toBe("@U2(Zen)");
  });
});

describe("appendFuseNotice", () => {
  test("appends once", () => {
    expect(appendFuseNotice("done")).toBe(`done\n\n${BOT_COLLAB_FUSE_NOTICE}`);
    expect(appendFuseNotice(`done\n\n${BOT_COLLAB_FUSE_NOTICE}`)).toBe(`done\n\n${BOT_COLLAB_FUSE_NOTICE}`);
  });
});
