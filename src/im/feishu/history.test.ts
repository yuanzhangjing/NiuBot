import { describe, expect, test } from "vitest";
import { feishuTimeToUnixSec, parseFeishuHistoryItem } from "./history.js";

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

  test("skips items without sender or body", () => {
    expect(parseFeishuHistoryItem({ message_id: "om-x" }, "oc-group")).toBeNull();
  });
});
