import { describe, expect, it } from "vitest";
import {
  isStructuredImPayload,
  renderForward,
  renderMessageNodes,
  renderMsg,
  renderQuotedText,
} from "./render.js";
import type { MessageNode } from "./types.js";

describe("IM tag render", () => {
  it("renders a one-level reply as sibling msg and quoted", () => {
    expect(renderMsg("U2(Zen)", "这个对吗")).toBe('<msg speaker="U2(Zen)">这个对吗</msg>');
    expect(renderQuotedText("U3(NiuBot)", "已经按这个思路改完了"))
      .toBe('<quoted speaker="U3(NiuBot)">已经按这个思路改完了</quoted>');
  });

  it("nests quoted inside quoted for a two-level reply tree", () => {
    const tree: MessageNode = {
      sender: "U2(Zen)",
      contentType: "text",
      content: "那按标签改",
      quoted: {
        sender: "U3(NiuBot)",
        contentType: "text",
        content: "假 YAML 没必要留",
        quoted: {
          sender: "U2(Zen)",
          contentType: "text",
          content: "你有更好的 format 思路吗",
        },
      },
    };
    expect(renderMessageNodes([tree])).toBe(
      `<msg speaker="U2(Zen)">
那按标签改
<quoted speaker="U3(NiuBot)">
假 YAML 没必要留
<quoted speaker="U2(Zen)">你有更好的 format 思路吗</quoted>
</quoted>
</msg>`,
    );
  });

  it("renders a merge-forward list", () => {
    expect(renderForward("U2(Zen)", [
      { sender: "U2(Zen)", contentType: "text", content: "第一条" },
      { sender: "U4(CowBot)", contentType: "text", content: "第二条" },
    ])).toBe(
      `<forward speaker="U2(Zen)">
<msg speaker="U2(Zen)">第一条</msg>
<msg speaker="U4(CowBot)">第二条</msg>
</forward>`,
    );
  });

  it("quotes a forward", () => {
    const tree: MessageNode = {
      sender: "U2(Zen)",
      contentType: "text",
      content: "这段转发里哪句是关键",
      quoted: {
        sender: "U4(CowBot)",
        contentType: "forward",
        children: [
          { sender: "U2(Zen)", contentType: "text", content: "方案 A" },
          { sender: "U3(NiuBot)", contentType: "text", content: "用标签" },
        ],
      },
    };
    expect(renderMessageNodes([tree])).toBe(
      `<msg speaker="U2(Zen)">
这段转发里哪句是关键
<quoted>
<forward speaker="U4(CowBot)">
<msg speaker="U2(Zen)">方案 A</msg>
<msg speaker="U3(NiuBot)">用标签</msg>
</forward>
</quoted>
</msg>`,
    );
  });

  it("keeps a quoted child inside a forwarded message", () => {
    expect(renderForward("U2(Zen)", [
      {
        sender: "U4(CowBot)",
        contentType: "text",
        content: "同意",
        quoted: { sender: "U3(NiuBot)", contentType: "text", content: "按标签改" },
      },
      { sender: "U2(Zen)", contentType: "text", content: "那就改" },
    ])).toBe(
      `<forward speaker="U2(Zen)">
<msg speaker="U4(CowBot)">
同意
<quoted speaker="U3(NiuBot)">按标签改</quoted>
</msg>
<msg speaker="U2(Zen)">那就改</msg>
</forward>`,
    );
  });

  it("keeps quotes and newlines in text without YAML escaping", () => {
    expect(renderMsg("U2(Zen)", '他说 "按这个改"\n然后列了两步')).toBe(
      `<msg speaker="U2(Zen)">
他说 "按这个改"
然后列了两步
</msg>`,
    );
  });

  it("escapes markup in text and attributes", () => {
    expect(renderMsg('A<"B', "1 < 2 & 3")).toBe(
      '<msg speaker="A&lt;&quot;B">1 &lt; 2 &amp; 3</msg>',
    );
  });

  it("detects structured payloads for queue merging", () => {
    expect(isStructuredImPayload('<msg speaker="U2(Zen)">hi</msg>')).toBe(true);
    expect(isStructuredImPayload('<forward speaker="U2(Zen)">\n<msg speaker="U2(Zen)">a</msg>\n</forward>')).toBe(true);
    expect(isStructuredImPayload("列一下目前注入的信息")).toBe(false);
  });
});
