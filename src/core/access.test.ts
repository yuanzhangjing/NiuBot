import { describe, expect, it } from "vitest";
import { assertAllChatsAccess, assertChatAccess } from "./access.js";

describe("chat access rules", () => {
  it("allows private chats to access another chat", () => {
    expect(() => assertChatAccess({
      currentChatId: "c1",
      chatType: "p2p",
      targetChatId: "c2",
    })).not.toThrow();
  });

  it("blocks group chats from accessing another chat", () => {
    expect(() => assertChatAccess({
      currentChatId: "c1",
      chatType: "group",
      targetChatId: "c2",
    })).toThrow("cross-chat query is not allowed in group chat");
  });

  it("blocks group access when current chat is missing", () => {
    expect(() => assertChatAccess({
      chatType: "group",
      targetChatId: "c2",
    })).toThrow("NIUBOT_CHAT_ID not set");
  });

  it("blocks all-chat queries in group chats", () => {
    expect(() => assertAllChatsAccess({ chatType: "group" }))
      .toThrow("cross-chat query is not allowed in group chat");
  });
});
