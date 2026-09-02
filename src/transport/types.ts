export type MessageNode = {
  id?: string;
  sender: string;
  contentType: string;
  content?: string;
  children?: MessageNode[];
  quoted?: MessageNode;
};

export interface MentionInfo {
  platformUserId: string;
  name: string;
  /** at 的是本 Bot（给 botMentioned 用）。 */
  isBot: boolean;
  /** at 的对象是应用机器人（含其他 Bot）。与 isBot 分开，避免混用。 */
  isApp?: boolean;
  key: string;
}

export function mentionMarksApp(mention: MentionInfo): boolean {
  return mention.isApp === true || mention.isBot;
}

/** 交互消息还没有拿到可读正文时使用的统一占位。 */
export const UNRESOLVED_INTERACTIVE_CONTENT = "[卡片消息]";

export function isUnresolvedInteractiveContent(text: string): boolean {
  const normalized = text.trim();
  return !normalized
    || normalized === UNRESOLVED_INTERACTIVE_CONTENT
    || normalized.includes("请升级至最新版本客户端")
    || normalized.includes("请升级客户端");
}

export interface NormalizedMessage {
  senderPlatformId: string;
  senderName?: string;
  chatPlatformId: string;
  chatType: "p2p" | "group";
  chatName?: string;
  /** 飞书 sender_type=app。未设置视为人。 */
  senderIsBot?: boolean;
  /** 飞书话题 ID（omt_…）；普通群话题回复/P2P 回复也可能有。 */
  threadId?: string;
  /** 飞书根消息 ID（om_…），不是话题 ID。 */
  rootId?: string;
  contentText: string;
  contentType: "text" | "image" | "file" | "audio" | "media" | "post" | "interactive" | "merge_forward" | "mixed";
  mentions?: MentionInfo[];
  botMentioned?: boolean;
  parentPlatformMsgId?: string;
  /** @deprecated use parentPlatformMsgId */
  replyToPlatformMsgId?: string;
  platformTs?: number;
  timestamp: Date;
  platformMsgId?: string;
  /** @deprecated resources should be downloaded to local paths by the platform adapter */
  images?: Array<{ mimeType: string; data: Buffer }>;
  children?: MessageNode[];
  raw: unknown;
}

export type DeliveryOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  replyToMsgId?: string;
  /** 飞书 reply 时是否以话题形式回复（reply_in_thread）。 */
  replyInThread?: boolean;
};

export type ChatMetadata = {
  chatMode?: "group" | "topic" | string;
  groupMessageType?: "chat" | "thread" | string;
  fetchedAt?: number;
};

export type BotAtPermissionStatus = "granted" | "missing" | "unknown";

export type MessageReadError = {
  messageId?: string;
  chatPlatformId?: string;
  threadId?: string;
  error: unknown;
};

export type InboundTerminalStatus = "completed" | "failed" | "stopped" | "discarded";

export type InboundDelivery = {
  inboxId: number;
  claimToken: string;
  message: NormalizedMessage;
  replayed: boolean;
  /** Existing chat-history row when recovering work that had already reached Engine's queue. */
  messageId?: number;
};

export type InboundHandler = (delivery: InboundDelivery) => void | Promise<void>;

/** Engine-facing transport boundary. It has no connection lifecycle or platform SDK types. */
export interface TransportClient {
  /** True when the implementation persists sends and owns timeout/uncertain-result semantics. */
  readonly managedDelivery?: boolean;

  sendText(chatId: string, text: string, options?: DeliveryOptions): Promise<string>;
  sendReply(chatId: string, text: string, replyToMsgId: string, options?: DeliveryOptions): Promise<string>;
  sendMarkdownCard(chatId: string, markdown: string, options?: DeliveryOptions): Promise<string>;
  sendCard(
    chatId: string,
    header: string,
    content: string,
    footer?: string,
    replyToMsgId?: string,
    options?: DeliveryOptions,
  ): Promise<string>;
  editMessage(msgId: string, text: string, options?: DeliveryOptions): Promise<void>;
  addReaction(chatId: string, msgId: string, emoji: string, options?: DeliveryOptions): Promise<void>;
  removeReaction(chatId: string, msgId: string, emoji: string, options?: DeliveryOptions): Promise<void>;
  sendFile(chatId: string, filePath: string, fileName?: string, options?: DeliveryOptions): Promise<string>;

  getBotOpenId(): Promise<string>;
  getBotName(): Promise<string | undefined>;
  getChatName(chatId: string): Promise<string | undefined>;
  getChatMetadata?(chatId: string): Promise<ChatMetadata | undefined>;
  getMessageThreadId?(messageId: string, context?: { chatPlatformId?: string }): Promise<string | undefined>;
  getMessageContent(msgId: string, context?: { chatPlatformId?: string; threadId?: string }): Promise<string | undefined>;
  getAppCreatorId(): Promise<string | undefined>;
  /** 查询当前 Bot 的线上版本是否能接收其他 Bot 的群聊 @。 */
  getBotAtPermissionStatus?(): Promise<BotAtPermissionStatus>;
  /** 消息原文读取失败通知；没有事件订阅能力的平台可以不实现。 */
  onMessageReadError?(handler: (event: MessageReadError) => void): void;
  /**
   * 拉群会话历史。没有该能力的平台可以不实现。
   * sinceUnixSec：只取该秒之后（含）的消息，用于增量缓存；飞书实现会 ASC 翻页。
   * 不传 since 时只取最新一页。
   */
  listChatMessages?(
    chatId: string,
    options?: { sinceUnixSec?: number; limit?: number; threadId?: string },
  ): Promise<NormalizedMessage[]>;

  /** Reliable implementations use these hooks to connect Engine lifecycle to inbox state. */
  markInboundQueued?(inboxId: number, claimToken: string, messageId: number): void;
  markInboundProcessing?(inboxId: number, claimToken: string, messageId: number): void;
  markInboundTerminal?(inboxId: number, claimToken: string, status: InboundTerminalStatus, error?: string): void;
  markInboundRunState?(messageIds: number[], runId: string, stage: string, error?: string): void;
  discardInboundMessages?(messageIds: number[]): void;
}

export type OutboundKind = "text" | "reply" | "markdown_card" | "card" | "file" | "edit";

export type OutboundRequest =
  | { kind: "text"; chatId: string; text: string }
  | { kind: "reply"; chatId: string; text: string; replyToMsgId: string; replyInThread?: boolean }
  | { kind: "markdown_card"; chatId: string; markdown: string }
  | { kind: "card"; chatId: string; header: string; content: string; footer?: string; replyToMsgId?: string; replyInThread?: boolean }
  | { kind: "file"; chatId: string; filePath: string; fileName?: string; replyToMsgId?: string; replyInThread?: boolean }
  | { kind: "edit"; msgId: string; text: string };
