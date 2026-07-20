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
  isBot: boolean;
  key: string;
}

export interface NormalizedMessage {
  senderPlatformId: string;
  senderName?: string;
  chatPlatformId: string;
  chatType: "p2p" | "group";
  chatName?: string;
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
};

export type InboundTerminalStatus = "completed" | "failed" | "stopped" | "discarded";

export type InboundDelivery = {
  inboxId: number;
  message: NormalizedMessage;
  replayed: boolean;
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
  getMessageContent(msgId: string): Promise<string | undefined>;
  getAppCreatorId(): Promise<string | undefined>;

  /** Reliable implementations use these hooks to connect Engine lifecycle to inbox state. */
  markInboundQueued?(inboxId: number, messageId: number): void;
  markInboundTerminal?(inboxId: number, status: InboundTerminalStatus, error?: string): void;
  markInboundRunState?(messageIds: number[], runId: string, stage: string, error?: string): void;
  discardInboundMessages?(messageIds: number[]): void;
}

export type OutboundKind = "text" | "reply" | "markdown_card" | "card" | "file" | "edit";

export type OutboundRequest =
  | { kind: "text"; chatId: string; text: string }
  | { kind: "reply"; chatId: string; text: string; replyToMsgId: string }
  | { kind: "markdown_card"; chatId: string; markdown: string }
  | { kind: "card"; chatId: string; header: string; content: string; footer?: string; replyToMsgId?: string }
  | { kind: "file"; chatId: string; filePath: string; fileName?: string }
  | { kind: "edit"; msgId: string; text: string };

