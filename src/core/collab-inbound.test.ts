import { describe, expect, test } from "vitest";
import { classifyCollabInbound } from "./collab-inbound.js";

const participants = [
  { platformUserId: "bot-a", name: "A", isApp: true },
  { platformUserId: "bot-b", name: "B", isApp: true },
];

describe("collaboration inbound router", () => {
  test("only explicitly mentioned Bots enter a collaboration start", () => {
    const message = {
      chatType: "group" as const,
      contentText: "@A @B 讨论一下",
      mentions: participants,
    };
    expect(classifyCollabInbound(message, "bot-a")).toBe("start");
    expect(classifyCollabInbound(message, "bot-b")).toBe("start");
    expect(classifyCollabInbound(message, "bot-c")).toBe("unrelated");
  });

  test("only explicitly mentioned Bots synchronize a protocol message", () => {
    const message = {
      chatType: "group" as const,
      senderIsBot: true,
      contentText: "报告\n\n〔协作 #A1B2C3D4 · 第 2 回合〕",
      mentions: participants,
    };
    expect(classifyCollabInbound(message, "bot-a")).toBe("protocol");
    expect(classifyCollabInbound(message, "bot-c")).toBe("unrelated");
  });

  test("leaves ordinary messages to the normal inbound flow", () => {
    expect(classifyCollabInbound({
      chatType: "group",
      contentText: "@A 你好",
      mentions: [participants[0]!],
    }, "bot-a")).toBe("none");
  });

  test("accepts the caller's compatibility identity matcher", () => {
    expect(classifyCollabInbound({
      chatType: "group",
      contentText: "@旧 A @B 讨论一下",
      mentions: [
        { platformUserId: "legacy-a", name: "旧 A", isApp: true },
        participants[1]!,
      ],
    }, (platformId) => platformId === "legacy-a")).toBe("start");
  });
});
