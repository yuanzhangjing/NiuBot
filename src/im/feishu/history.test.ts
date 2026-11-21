import { describe, expect, test, vi } from "vitest";
import {
  feishuTimeToUnixSec,
  parseFeishuHistoryItem,
  parseFeishuHistoryItemWithCardResolver,
} from "./history.js";
import {
  formatFeishuDurationSec,
  formatFeishuStructuredContent,
  isFeishuPostPayload,
} from "./message-content.js";

describe("feishu history parse", () => {
  test("converts millisecond timestamps to seconds", () => {
    expect(feishuTimeToUnixSec("1777532010676")).toBe(1777532010);
    expect(feishuTimeToUnixSec(1777532010)).toBe(1777532010);
  });

  test("parses a human text message and a bot card", () => {
    const human = parseFeishuHistoryItem({
      message_id: "om-human",
      chat_id: "oc-group",
      msg_type: "text",
      create_time: "1777532010676",
      sender: { id: "ou-user", id_type: "open_id", sender_type: "user" },
      body: { content: JSON.stringify({ text: "hello @_user_1" }) },
      mentions: [{ key: "@_user_1", id: "ou-bot", name: "NiuBot", id_type: "open_id" }],
    }, "oc-group", "ou-bot", "cli-bot");
    expect(human?.contentText).toBe("hello @NiuBot");
    expect(human?.senderIsBot).toBe(false);
    expect(human?.botMentioned).toBe(true);

    const bot = parseFeishuHistoryItem({
      message_id: "om-bot",
      msg_type: "interactive",
      create_time: "1777532011000",
      sender: { id: "cli_other", id_type: "app_id", sender_type: "app" },
      body: { content: JSON.stringify({ body: { elements: [{ tag: "markdown", content: "改完了" }] } }) },
    }, "oc-group");
    expect(bot?.senderIsBot).toBe(true);
    expect(bot?.contentText).toBe("改完了");
    expect(bot?.contentType).toBe("interactive");
  });

  test("preserves thread and root ids", () => {
    const item = parseFeishuHistoryItem({
      message_id: "om-reply",
      chat_id: "oc-group",
      msg_type: "text",
      create_time: "1777532010676",
      sender: { id: "ou-user", id_type: "open_id", sender_type: "user" },
      body: { content: JSON.stringify({ text: "hello" }) },
      thread_id: "omt_aaa",
      parent_id: "om-root",
      root_id: "om-root",
    }, "oc-group");
    expect(item).toMatchObject({
      threadId: "omt_aaa",
      rootId: "om-root",
      parentPlatformMsgId: "om-root",
    });
  });

  test("reads rich text from Feishu post content_v2", () => {
    const item = parseFeishuHistoryItem({
      message_id: "om-post-v2",
      chat_id: "oc-group",
      msg_type: "post",
      sender: { id: "ou-user", sender_type: "user" },
      body: {
        content: JSON.stringify({
          content: [[{ tag: "text", text: "旧版内容" }]],
          content_v2: [[{ tag: "text", text: "新版内容" }]],
        }),
      },
    }, "oc-group");
    expect(item?.contentText).toBe("新版内容");
  });

  test("falls back when content_v2 is empty", () => {
    const item = parseFeishuHistoryItem({
      message_id: "om-post-v2-empty",
      chat_id: "oc-group",
      msg_type: "post",
      sender: { id: "ou-user", sender_type: "user" },
      body: {
        content: JSON.stringify({
          content: [[{ tag: "text", text: "旧版内容" }]],
          content_v2: [],
        }),
      },
    }, "oc-group");
    expect(item?.contentText).toBe("旧版内容");
  });

  test("resolves a card when the history item has no body", async () => {
    const fetchOriginal = vi.fn(async (messageId: string) => {
      expect(messageId).toBe("om-card-no-body");
      return JSON.stringify({ body: { elements: [{ tag: "markdown", content: "补取的卡片正文" }] } });
    });

    const item = await parseFeishuHistoryItemWithCardResolver({
      message_id: "om-card-no-body",
      msg_type: "interactive",
      sender: { id: "ou-cow", sender_type: "app" },
    }, "oc-group", undefined, undefined, fetchOriginal);

    expect(item?.contentText).toBe("补取的卡片正文");
    expect(item?.contentType).toBe("interactive");
    expect(fetchOriginal).toHaveBeenCalledTimes(1);
  });

  test("skips items without sender or body", () => {
    expect(parseFeishuHistoryItem({ message_id: "om-x" }, "oc-group")).toBeNull();
  });

  test("parses locale-wrapped post tags and additional Feishu message types", () => {
    const richPost = parseFeishuHistoryItem({
      message_id: "om-post-rich",
      msg_type: "post",
      sender: { id: "ou-user", sender_type: "user" },
      body: {
        content: JSON.stringify({
          zh_cn: {
            title: "周报",
            content: [
              [{ tag: "md", text: "**要点** 1" }],
              [{ tag: "code_block", language: "ts", text: "const x = 1;" }],
              [{ tag: "hr" }],
            ],
          },
          files: [{ file_key: "f1", file_name: "report.pdf", is_folder: false }],
        }),
      },
    }, "oc-group");
    expect(richPost?.contentText).toContain("周报");
    expect(richPost?.contentText).toContain("**要点** 1");
    expect(richPost?.contentText).toContain("```ts\nconst x = 1;\n```");
    expect(richPost?.contentText).toContain("---");
    expect(richPost?.contentText).toContain("[文件: report.pdf]");

    expect(parseFeishuHistoryItem({
      message_id: "om-share-chat",
      msg_type: "share_chat",
      sender: { id: "ou-user", sender_type: "user" },
      body: { content: JSON.stringify({ chat_id: "oc_123" }) },
    }, "oc-group")?.contentText).toBe("[分享群聊: oc_123]");

    expect(parseFeishuHistoryItem({
      message_id: "om-share-user",
      msg_type: "share_user",
      sender: { id: "ou-user", sender_type: "user" },
      body: { content: JSON.stringify({ user_id: "ou_456" }) },
    }, "oc-group")?.contentText).toBe("[分享名片: ou_456]");

    expect(parseFeishuHistoryItem({
      message_id: "om-location",
      msg_type: "location",
      sender: { id: "ou-user", sender_type: "user" },
      body: { content: JSON.stringify({ name: "字节跳动广场" }) },
    }, "oc-group")?.contentText).toBe("[位置: 字节跳动广场]");

    expect(parseFeishuHistoryItem({
      message_id: "om-vote",
      msg_type: "vote",
      sender: { id: "ou-user", sender_type: "user" },
      body: { content: JSON.stringify({ topic: "聚餐时间", options: ["周五", "周六"], status: 1 }) },
    }, "oc-group")?.contentText).toBe("[投票] 聚餐时间 | • 周五 • 周六 | (已结束)");

    expect(parseFeishuHistoryItem({
      message_id: "om-sys",
      msg_type: "system",
      sender: { id: "ou-sys", sender_type: "user" },
      body: { content: JSON.stringify({ template: "{from_user} 邀请 {to_chatters} 加入群聊", from_user: ["张三"], to_chatters: ["李四"] }) },
    }, "oc-group")?.contentText).toBe("张三 邀请 李四 加入群聊");
  });

  test("guards post detection, system prototype keys, epochs, and durations", () => {
    expect(isFeishuPostPayload([])).toBe(false);
    expect(isFeishuPostPayload({ summary: { title: "task", content: [[{ tag: "text", text: "x" }]] }, due_time: "1795152000" })).toBe(false);
    expect(isFeishuPostPayload({ extra: { content: [[{ tag: "text", text: "x" }]] } })).toBe(false);
    expect(isFeishuPostPayload({ zh_tw: { content: [[{ tag: "text", text: "ok" }]] } })).toBe(true);

    expect(formatFeishuDurationSec(0)).toBe("");
    expect(formatFeishuDurationSec(-1000)).toBe("");
    expect(formatFeishuDurationSec("bad")).toBe("");
    expect(formatFeishuDurationSec(2500)).toBe("3秒");

    expect(formatFeishuStructuredContent("todo", { summary: { title: "任务" }, due_time: "9e18" }).text).toBe("[待办] 任务");
    expect(formatFeishuStructuredContent("system", { template: "{from_user} {toString}", from_user: ["A"] }).text).toBe("A {toString}");
  });
});
