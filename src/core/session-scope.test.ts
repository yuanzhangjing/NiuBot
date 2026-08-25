import { describe, expect, test } from "vitest";
import {
  buildScopeKey,
  parseScopeKey,
  resolveSessionScope,
  shouldIsolateChat,
  shouldStrictTopicReply,
} from "./session-scope.js";

describe("session scope", () => {
  test("round-trips chat and isolated topic keys", () => {
    expect(buildScopeKey("c5")).toBe("c5");
    expect(buildScopeKey("c5", "omt_aaa")).toBe("c5#omt_aaa");
    expect(parseScopeKey("c5")).toEqual({ chatId: "c5" });
    expect(parseScopeKey("c5#omt_aaa")).toEqual({
      chatId: "c5",
      threadId: "omt_aaa",
    });
  });

  test("isolates topic groups and thread-form groups but not p2p thread replies", () => {
    expect(shouldIsolateChat({ chatMode: "topic" })).toBe(true);
    expect(shouldIsolateChat({ chatMode: "group", groupMessageType: "thread" })).toBe(true);
    expect(shouldIsolateChat({ chatMode: "group", groupMessageType: "chat" })).toBe(false);
    expect(shouldIsolateChat({ chatMode: "p2p" })).toBe(false);
  });

  test("kill switch disables isolation", () => {
    const old = process.env.NIUBOT_TOPIC_ISOLATION;
    process.env.NIUBOT_TOPIC_ISOLATION = "0";
    try {
      expect(shouldIsolateChat({ chatMode: "topic" })).toBe(false);
    } finally {
      if (old === undefined) delete process.env.NIUBOT_TOPIC_ISOLATION;
      else process.env.NIUBOT_TOPIC_ISOLATION = old;
    }
  });

  test("strict reply is independent from the isolation kill switch", () => {
    const old = process.env.NIUBOT_TOPIC_ISOLATION;
    process.env.NIUBOT_TOPIC_ISOLATION = "0";
    try {
      expect(shouldStrictTopicReply({ chatMode: "topic" })).toBe(true);
      expect(shouldStrictTopicReply({ chatMode: "group", groupMessageType: "thread" })).toBe(true);
      expect(shouldStrictTopicReply({ chatMode: "group", groupMessageType: "chat" })).toBe(false);
      expect(shouldStrictTopicReply({ chatMode: "p2p" })).toBe(false);
    } finally {
      if (old === undefined) delete process.env.NIUBOT_TOPIC_ISOLATION;
      else process.env.NIUBOT_TOPIC_ISOLATION = old;
    }
  });

  test("resolves scope key without using thread_id when chat mode is unknown", () => {
    const scope = resolveSessionScope({
      chatId: "c5",
      platformChatId: "oc-group",
      chatType: "group",
      threadId: "omt_aaa",
    });
    expect(scope).toMatchObject({
      chatId: "c5",
      scopeKey: "c5",
      isolated: false,
      strict: false,
    });
  });

  test("keeps strict reply when isolation is disabled", () => {
    const old = process.env.NIUBOT_TOPIC_ISOLATION;
    process.env.NIUBOT_TOPIC_ISOLATION = "0";
    try {
      const scope = resolveSessionScope({
        chatId: "c5",
        platformChatId: "oc-group",
        chatType: "group",
        chatMode: "topic",
        groupMessageType: "thread",
        threadId: "omt_aaa",
      });
      expect(scope).toMatchObject({
        scopeKey: "c5",
        threadId: undefined,
        isolated: false,
        strict: true,
      });
    } finally {
      if (old === undefined) delete process.env.NIUBOT_TOPIC_ISOLATION;
      else process.env.NIUBOT_TOPIC_ISOLATION = old;
    }
  });
});
