/**
 * 多 Bot 协作的入站分类。
 *
 * 这一步只判断当前 Bot 对一条群消息的协作身份；不读写状态，也不调用 Agent。
 * Pipeline 据此把协作消息和普通消息分流，避免未参与 Bot 落入观察者或普通触发路径。
 */

import {
  collectCollabParticipants,
  parseCollabProtocol,
  type CollabMention,
} from "./collab-loop.js";

export type CollabInboundRoute = "none" | "start" | "protocol" | "unrelated";
export type CollabParticipantMatcher = string | ((platformId: string) => boolean);

type CollabInboundMessage = {
  chatType: "p2p" | "group";
  senderIsBot?: boolean;
  contentText: string;
  mentions?: readonly CollabMention[];
};

/**
 * 返回当前 Bot 对协作消息的角色：
 * - start / protocol：当前 Bot 是被明确 @ 的参与者，交给协作状态机；
 * - unrelated：消息确实是协作消息，但当前 Bot 不在名单，直接止于入站层；
 * - none：不是可识别的协作消息，交给普通消息流程。
 */
export function classifyCollabInbound(
  message: CollabInboundMessage,
  currentBot: CollabParticipantMatcher | undefined | null,
): CollabInboundRoute {
  if (message.chatType !== "group") return "none";
  if (typeof currentBot !== "function" && !currentBot?.trim()) return "none";
  const matchesCurrentBot = typeof currentBot === "function"
    ? currentBot
    : (platformId: string) => platformId === currentBot?.trim();

  const participants = collectCollabParticipants(message.mentions);
  const isStart = !message.senderIsBot && participants.length >= 2;
  const isProtocol = Boolean(message.senderIsBot)
    && participants.length >= 2
    && Boolean(parseCollabProtocol(message.contentText));
  if (!isStart && !isProtocol) return "none";

  if (!participants.some((participant) => matchesCurrentBot(participant.platformId))) {
    return "unrelated";
  }
  return isStart ? "start" : "protocol";
}
