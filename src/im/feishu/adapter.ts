import * as lark from "@larksuiteoapi/node-sdk";
import type { NormalizedMessage, MessageHandler, PlatformAdapter } from "../types.js";
import { createLogger } from "../../logger.js";

const log = createLogger("feishu");

/** 飞书单条消息长度限制（字符数） */
const MAX_MESSAGE_LENGTH = 4000;

export class FeishuAdapter implements PlatformAdapter {
  private client: lark.Client;
  private wsClient: lark.WSClient | null = null;
  private handler: MessageHandler | null = null;
  private appId: string;
  private appSecret: string;

  constructor(appId: string, appSecret: string) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.client = new lark.Client({
      appId,
      appSecret,
      appType: lark.AppType.SelfBuild,
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const eventDispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        try {
          const msg = this.normalize(data);
          if (msg) this.handler?.(msg);
        } catch (err) {
          log.error("failed to process message", { error: String(err) });
        }
      },
    });

    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    });

    await this.wsClient.start({ eventDispatcher });
    log.info("feishu websocket connected");
  }

  async stop(): Promise<void> {
    this.handler = null;
    if (this.wsClient) {
      try { (this.wsClient as any).close?.(); } catch { /* SDK 可能不暴露 close */ }
      this.wsClient = null;
    }
    log.info("feishu adapter stopped");
  }

  async sendText(chatId: string, text: string): Promise<string> {
    const chunks = splitMessage(text);

    let firstMsgId = "";
    for (const chunk of chunks) {
      const resp = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text: chunk }),
        },
      });
      if (!firstMsgId) {
        firstMsgId = resp?.data?.message_id ?? "";
      }
    }

    return firstMsgId;
  }

  async editMessage(msgId: string, text: string): Promise<void> {
    await this.client.im.message.patch({
      path: { message_id: msgId },
      data: {
        content: JSON.stringify({ text }),
      },
    });
  }

  async addReaction(chatId: string, msgId: string, emoji: string): Promise<void> {
    try {
      await this.client.im.messageReaction.create({
        path: { message_id: msgId },
        data: {
          reaction_type: { emoji_type: emoji },
        },
      });
    } catch (err) {
      // reaction 失败不影响主流程
      log.warn("addReaction failed", { chatId, msgId, emoji, error: String(err) });
    }
  }

  private normalize(data: unknown): NormalizedMessage | null {
    const event = data as {
      message?: {
        chat_id?: string;
        chat_type?: string;
        message_id?: string;
        message_type?: string;
        content?: string;
        create_time?: string;
      };
      sender?: { sender_id?: { open_id?: string }; sender_type?: string };
    };

    const msg = event?.message;
    if (!msg?.chat_id || !msg?.content) return null;

    const senderId = event.sender?.sender_id?.open_id;
    if (!senderId) {
      log.warn("skipping message without sender ID", { chatId: msg.chat_id });
      return null;
    }

    // 只处理文本消息（M1）
    if (msg.message_type !== "text") {
      log.debug("skipping non-text message", { type: msg.message_type });
      return null;
    }

    let contentText = "";
    try {
      const parsed = JSON.parse(msg.content) as { text?: string };
      contentText = parsed.text ?? "";
    } catch {
      contentText = msg.content;
    }

    if (!contentText.trim()) return null;

    return {
      senderPlatformId: senderId,
      chatPlatformId: msg.chat_id,
      chatType: msg.chat_type === "group" ? "group" : "p2p",
      contentText,
      contentType: "text",
      timestamp: parseTimestamp(msg.create_time),
      platformMsgId: msg.message_id,
      raw: data,
    };
  }
}

function parseTimestamp(val?: string): Date {
  if (!val) return new Date();
  const n = Number(val);
  return Number.isNaN(n) || n === 0 ? new Date() : new Date(n);
}

/** 按自然段落边界分割超长消息 */
function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_MESSAGE_LENGTH) {
    let splitIdx = remaining.lastIndexOf("\n\n", MAX_MESSAGE_LENGTH);
    if (splitIdx < MAX_MESSAGE_LENGTH * 0.3) {
      splitIdx = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    }
    if (splitIdx < MAX_MESSAGE_LENGTH * 0.3) {
      splitIdx = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, "");
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
