import { describe, expect, test, vi } from "vitest";
import {
  extractInteractiveCardContent,
  FEISHU_CARD_PLACEHOLDER,
  resolveInteractiveCardContent,
} from "./card-content.js";

const botMention = {
  platformUserId: "ou-bot",
  name: "NiuBot",
  isBot: true,
  isApp: true,
  key: "@_bot",
};

describe("Feishu card content", () => {
  test("extracts schema 1.0 and schema 2.0 text through one parser", () => {
    expect(extractInteractiveCardContent(JSON.stringify({
      title: "旧卡片",
      elements: [[{ tag: "text", text: "正文" }]],
    }))).toBe("旧卡片\n正文");

    expect(extractInteractiveCardContent(JSON.stringify({
      schema: "2.0",
      header: { title: { tag: "plain_text", content: "新卡片" } },
      body: { elements: [{
        tag: "column_set",
        columns: [{ elements: [{ tag: "markdown", content: "正文" }] }],
      }] },
    }))).toBe("新卡片\n正文");
  });

  test("resolves an upgrade placeholder and maps card mentions", async () => {
    const fetchOriginal = vi.fn(async () => JSON.stringify({
      schema: "2.0",
      body: { elements: [{
        tag: "markdown",
        content: "<_invalid> <at id=ou-bot></at> 已完成",
      }] },
    }));

    await expect(resolveInteractiveCardContent(
      JSON.stringify({ elements: [[{ tag: "text", text: "请升级至最新版本客户端，以查看内容" }]] }),
      [botMention],
      fetchOriginal,
    )).resolves.toBe("<_invalid> @NiuBot 已完成");
    expect(fetchOriginal).toHaveBeenCalledTimes(1);
  });

  test("maps the all-members card mention", () => {
    expect(extractInteractiveCardContent(JSON.stringify({
      body: { elements: [{ tag: "markdown", content: "<at id=_all></at> 请看" }] },
    }))).toBe("@所有人 请看");
  });

  test("also resolves a non-JSON inbound card placeholder", async () => {
    const fetchOriginal = vi.fn(async () => JSON.stringify({
      body: { elements: [{ tag: "markdown", content: "原始卡片正文" }] },
    }));

    await expect(resolveInteractiveCardContent(FEISHU_CARD_PLACEHOLDER, [], fetchOriginal))
      .resolves.toBe("原始卡片正文");
    expect(fetchOriginal).toHaveBeenCalledTimes(1);
  });

  test("keeps an explicit placeholder when the original card cannot be fetched", async () => {
    await expect(resolveInteractiveCardContent(
      JSON.stringify({ elements: [[{ tag: "text", text: "请升级客户端" }]] }),
      [],
      async () => { throw new Error("api down"); },
    )).resolves.toBe(FEISHU_CARD_PLACEHOLDER);
  });

  test("does not fetch when the event already contains readable text", async () => {
    const fetchOriginal = vi.fn(async () => undefined);
    await expect(resolveInteractiveCardContent(
      JSON.stringify({ body: { elements: [{ tag: "markdown", content: "已有正文" }] } }),
      [],
      fetchOriginal,
    )).resolves.toBe("已有正文");
    expect(fetchOriginal).not.toHaveBeenCalled();
  });
});
