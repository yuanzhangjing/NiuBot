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

  test("parses raw_card_content envelope, table, collapsible_panel, list, and code_block", () => {
    const rawCard = JSON.stringify({
      card_schema: 2,
      json_card: JSON.stringify({
        schema: "2.0",
        header: { property: { title: { tag: "plain_text", content: "当前测试版本" }, subtitle: { tag: "plain_text", content: "发布状态" } } },
        body: {
          property: {
            elements: [
              {
                tag: "markdown",
                property: {
                  elements: [
                    { tag: "plain_text", property: { content: "提交：" } },
                    { tag: "code_span", property: { content: "9f783de" } },
                    { tag: "br" },
                    { tag: "at", property: { userID: "ou_t_eli" } },
                  ],
                },
              },
              {
                tag: "table",
                property: {
                  columns: [
                    { name: "env", displayName: "环境" },
                    { name: "status", displayName: "状态" },
                  ],
                  rows: [{ env: { data: "prod" }, status: { data: "ok" } }],
                },
              },
              {
                tag: "collapsible_panel",
                property: {
                  header: { title: { tag: "plain_text", content: "详情" } },
                  elements: [{ tag: "blockquote", property: { content: "已通过" } }],
                },
              },
            ],
          },
        },
      }),
      json_attachment: JSON.stringify({
        at_users: {
          ou_t_eli: { content: "T.Eli", mention_key: "@_user_1", user_id: "123" },
        },
      }),
    });

    const text = extractInteractiveCardContent(rawCard, [
      { platformUserId: "ou_bot", name: "T.Eli", isBot: true, isApp: true, key: "@_user_1" },
    ]);
    expect(text).toContain("当前测试版本");
    expect(text).toContain("发布状态");
    expect(text).toContain("提交：`9f783de`");
    expect(text).toContain("@T.Eli");
    expect(text).toContain("| 环境 | 状态 |");
    expect(text).toContain("| prod | ok |");
    expect(text).toContain("详情");
    expect(text).toContain("已通过");
  });
});
