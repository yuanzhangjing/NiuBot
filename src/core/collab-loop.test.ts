import { describe, expect, test } from "vitest";
import {
  appendCollabProtocolMessage,
  applyCollabDecision,
  buildCollabTurnContext,
  collectCollabParticipants,
  createCollabState,
  parseCollabProtocol,
  rebuildCollabState,
  stripCollabProtocols,
  validateCollabTurnDecision,
} from "./collab-loop.js";

const mentions = [
  { platformUserId: "bot-a", name: "A", isApp: true, isBot: true },
  { platformUserId: "bot-b", name: "B", isApp: true, isBot: true },
  { platformUserId: "human", name: "Human", isApp: false, isBot: false },
  { platformUserId: "bot-a", name: "A", isApp: true, isBot: true },
];

function state() {
  return createCollabState({
    scopeKey: "chat-1",
    chatId: "chat-1",
    startPlatformMsgId: "msg-1",
    mentions,
    currentBotId: "bot-a",
  })!;
}

describe("collab-loop protocol", () => {
  test("keeps ordered unique stable participant IDs and only accepts explicit apps", () => {
    expect(collectCollabParticipants(mentions)).toEqual([
      { platformId: "bot-a", name: "A" },
      { platformId: "bot-b", name: "B" },
    ]);
  });

  test("only the first mentioned Bot may create the initial state", () => {
    expect(state().currentBotId).toBe("bot-a");
    expect(createCollabState({
      scopeKey: "chat-1",
      chatId: "chat-1",
      startPlatformMsgId: "msg-1",
      mentions,
      currentBotId: "bot-b",
    })).toBeUndefined();
  });

  test("validates handoff target against the current turn", () => {
    expect(validateCollabTurnDecision({ action: "handoff", to: "bot-b" }, state(), "bot-a"))
      .toEqual({ ok: true, decision: { action: "handoff", to: "bot-b" } });
    expect(validateCollabTurnDecision({ action: "handoff", to: "bot-x" }, state(), "bot-a").code)
      .toBe("unknown-target");
    expect(validateCollabTurnDecision({ action: "handoff", to: "bot-a" }, state(), "bot-a").code)
      .toBe("self-target");
    expect(validateCollabTurnDecision({ action: "finish" }, state(), "bot-b").code)
      .toBe("not-current");
    expect(validateCollabTurnDecision(undefined, state(), "bot-a").code).toBe("missing");
  });

  test("advances only after the engine records a successful outbound message", () => {
    const next = applyCollabDecision(state(), { action: "handoff", to: "bot-b" }, "msg-2", "run-1");
    expect(next).toMatchObject({ currentBotId: "bot-b", turn: 2, lastPlatformMsgId: "msg-2", lastRunId: "run-1" });
    expect(applyCollabDecision(next, { action: "finish" }, "msg-3").status).toBe("finished");
  });

  test("rebuilds the next turn from the visible protocol on another device", () => {
    const rebuilt = rebuildCollabState({
      scopeKey: "chat-1",
      chatId: "chat-1",
      messages: [
        { senderPlatformId: "human", senderIsBot: false, platformMsgId: "msg-1", mentions },
        {
          senderPlatformId: "bot-a",
          senderIsBot: true,
          platformMsgId: "msg-2",
          contentText: appendCollabProtocolMessage("报告", state(), { action: "handoff", to: "bot-b" }),
          mentions: [
            { platformUserId: "bot-b", name: "B", isApp: true, isBot: true },
            { platformUserId: "bot-a", name: "A", isApp: true, isBot: true },
          ],
        },
      ],
    });
    expect(rebuilt).toMatchObject({ currentBotId: "bot-b", turn: 2, startPlatformMsgId: "msg-1", lastPlatformMsgId: "msg-2" });
  });

  test("renders an internal context and a visible all-participant protocol", () => {
    const text = buildCollabTurnContext(state(), "bot-a");
    expect(text).toContain("nbt collab turn --action handoff");
    expect(appendCollabProtocolMessage("报告", state(), { action: "handoff", to: "bot-b" }))
      .toBe('报告\n\n<at user_id="bot-b">B</at> <at user_id="bot-a">A</at>\n\n〔协作 #C3C954A7 · 第 2 回合〕');
  });

  test("only adds the requester mention when finishing", () => {
    expect(appendCollabProtocolMessage("总结", state(), { action: "finish" }, {
      requester: { platformId: "human", name: "Human" },
    })).toBe('总结\n\n<at user_id="human">Human</at>\n\n<at user_id="bot-a">A</at> <at user_id="bot-b">B</at>\n\n〔协作 #C3C954A7 · 第 1 回合 · 完成〕');
    expect(appendCollabProtocolMessage("报告", state(), { action: "handoff", to: "bot-b" }, {
      requester: { platformId: "human", name: "Human" },
    })).not.toContain('user_id="human"');
  });

  test("recognizes the last protocol and strips agent-forged protocol lines", () => {
    expect(parseCollabProtocol("旧 〔协作 #AAAAAAAA · 第 1 回合〕 新 〔协作 #BBBBBBBB · 第 2 回合 · 完成〕"))
      .toEqual({ chainId: "BBBBBBBB", turn: 2, finished: true });
    expect(stripCollabProtocols("报告\n〔协作 #AAAAAAAA · 第 99 回合〕"))
      .toBe("报告");
  });
});
