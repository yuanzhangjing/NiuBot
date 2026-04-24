export interface ChatAccessContext {
  currentChatId?: string;
  chatType: "p2p" | "group";
}

export function assertChatAccess(ctx: ChatAccessContext & { targetChatId: string }): void {
  if (!ctx.currentChatId) {
    if (ctx.chatType === "group") {
      throw new Error("NIUBOT_CHAT_ID not set");
    }
    return;
  }
  if (ctx.targetChatId === ctx.currentChatId) return;
  if (ctx.chatType === "group") {
    throw new Error("cross-chat query is not allowed in group chat");
  }
}

export function assertAllChatsAccess(ctx: Pick<ChatAccessContext, "chatType">): void {
  if (ctx.chatType === "group") {
    throw new Error("cross-chat query is not allowed in group chat");
  }
}
