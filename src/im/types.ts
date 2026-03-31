/**
 * IM 平台适配层接口。
 * 新增平台只需实现 PlatformAdapter，不改 Core。
 */

export interface NormalizedMessage {
  senderPlatformId: string;
  senderName?: string;
  chatPlatformId: string;
  chatType: "p2p" | "group";
  contentText: string;
  contentType: "text" | "image" | "file" | "audio" | "mixed";
  replyToPlatformMsgId?: string;
  timestamp: Date;
  platformMsgId?: string;
  raw: unknown;
}

export type MessageHandler = (msg: NormalizedMessage) => void;

export interface PlatformAdapter {
  /** 注册消息回调 */
  onMessage(handler: MessageHandler): void;

  /** 启动（连接 WebSocket 等） */
  start(): Promise<void>;

  /** 停止 */
  stop(): Promise<void>;

  /** 发送文本消息，返回平台消息 ID */
  sendText(chatId: string, text: string): Promise<string>;

  /** 编辑已发送的消息 */
  editMessage(msgId: string, text: string): Promise<void>;

  /** 添加表情回应 */
  addReaction(chatId: string, msgId: string, emoji: string): Promise<void>;
}
