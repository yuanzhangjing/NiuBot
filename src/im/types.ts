/**
 * IM 平台适配层接口。
 * 新增平台只需实现 PlatformAdapter，不改 Core。
 */

/** 统一消息节点（用于 merge_forward 解析和渲染） */
export type MessageNode = {
  id?: string;
  sender: string;
  contentType: string;        // "text" | "image" | "file" | ... | "forward"
  content?: string;           // 叶子节点的文本内容
  children?: MessageNode[];   // forward 时的子节点列表
  quoted?: MessageNode;       // 引用的原始消息（完整内容）
};

export interface MentionInfo {
  /** 被 @ 的用户 platform ID */
  platformUserId: string;
  /** 显示名称 */
  name: string;
  /** 是否是 @bot 自身 */
  isBot: boolean;
  /** 原始占位符 key（如 @_user_1） */
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
  /** Mentions extracted from the message */
  mentions?: MentionInfo[];
  /** Whether bot was mentioned (for group chat trigger) */
  botMentioned?: boolean;
  /** Platform message ID of the quoted/replied-to message */
  parentPlatformMsgId?: string;
  /** @deprecated use parentPlatformMsgId */
  replyToPlatformMsgId?: string;
  /** Platform timestamp (ms since epoch) */
  platformTs?: number;
  timestamp: Date;
  platformMsgId?: string;
  /** Image attachments (binary data) — @deprecated 资源已改为下载到本地路径 */
  images?: Array<{ mimeType: string; data: Buffer }>;
  /** merge_forward 的结构化子消息树 */
  children?: MessageNode[];
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

  /** 发送文本消息作为回复（引用指定消息） */
  sendReply(chatId: string, text: string, replyToMsgId: string): Promise<string>;

  /** 发送 Markdown 卡片消息 */
  sendMarkdownCard(chatId: string, markdown: string): Promise<string>;

  /** 发送富文本卡片（header + markdown content + optional footer） */
  sendCard(chatId: string, header: string, content: string, footer?: string): Promise<string>;

  /** 回复富文本卡片（引用原消息） */
  replyCard(msgId: string, header: string, content: string, footer?: string): Promise<string>;

  /** 编辑已发送的消息 */
  editMessage(msgId: string, text: string): Promise<void>;

  /** 添加表情回应 */
  addReaction(chatId: string, msgId: string, emoji: string): Promise<void>;

  /** 删除表情回应 */
  removeReaction(chatId: string, msgId: string, emoji: string): Promise<void>;

  /** 发送文件 */
  sendFile(chatId: string, filePath: string, fileName?: string): Promise<string>;

  /** 获取 bot 自身的 open_id */
  getBotOpenId(): Promise<string>;

  /** 获取 bot 显示名称（从平台 API） */
  getBotName(): Promise<string | undefined>;

  /** 获取群聊名称 */
  getChatName(chatId: string): Promise<string | undefined>;

  /** 获取消息内容（用于 reply 上下文） */
  getMessageContent(msgId: string): Promise<string | undefined>;

  /** 获取 app creator user ID（用于 admin 检测） */
  getAppCreatorId(): Promise<string | undefined>;
}
