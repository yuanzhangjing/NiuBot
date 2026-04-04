import * as lark from "@larksuiteoapi/node-sdk";
import fs from "node:fs";
import path from "node:path";
import type { NormalizedMessage, MessageHandler, PlatformAdapter, MentionInfo } from "../types.js";
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

  /** Bot 自身的 open_id（启动时获取） */
  private botOpenId: string | null = null;

  /** Bot 显示名称（从 /bot/v3/info/ 获取） */
  private botName: string | null = null;

  /** App creator open_id（用于 admin 检测） */
  private appCreatorId: string | null = null;

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
    // Fetch bot identity before starting WebSocket
    await this.fetchBotIdentity();

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
    log.info("feishu websocket connected", { botOpenId: this.botOpenId });
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

  async sendReply(chatId: string, text: string, replyToMsgId: string): Promise<string> {
    const resp = await this.client.im.message.reply({
      path: { message_id: replyToMsgId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    return resp?.data?.message_id ?? "";
  }

  async sendMarkdownCard(chatId: string, markdown: string): Promise<string> {
    return this.sendCard(chatId, "", markdown);
  }

  async sendCard(chatId: string, header: string, content: string, footer?: string): Promise<string> {
    const cardJson = buildCardJSON(header, content, footer);
    const resp = await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: cardJson,
      },
    });
    return resp?.data?.message_id ?? "";
  }

  async replyCard(msgId: string, header: string, content: string, footer?: string): Promise<string> {
    const cardJson = buildCardJSON(header, content, footer);
    const resp = await this.client.im.message.reply({
      path: { message_id: msgId },
      data: {
        msg_type: "interactive",
        content: cardJson,
      },
    });
    return resp?.data?.message_id ?? "";
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
      log.warn("addReaction failed", { chatId, msgId, emoji, error: String(err) });
    }
  }

  async removeReaction(chatId: string, msgId: string, emoji: string): Promise<void> {
    try {
      // List reactions and find ours to delete
      const resp = await this.client.im.messageReaction.list({
        path: { message_id: msgId },
        params: { reaction_type: emoji },
      });
      const items = (resp?.data?.items ?? []) as Array<{
        reaction_id?: string;
        operator?: { operator_type?: string; operator_id?: { open_id?: string } };
      }>;
      for (const item of items) {
        if (item.operator?.operator_id?.open_id === this.botOpenId && item.reaction_id) {
          await this.client.im.messageReaction.delete({
            path: { message_id: msgId, reaction_id: item.reaction_id },
          });
        }
      }
    } catch (err) {
      log.warn("removeReaction failed", { chatId, msgId, emoji, error: String(err) });
    }
  }

  async sendFile(chatId: string, filePath: string, fileName?: string): Promise<string> {
    const name = fileName ?? path.basename(filePath);
    // Upload file first
    const uploadResp = await this.client.im.file.create({
      data: {
        file_type: "stream",
        file_name: name,
        file: fs.createReadStream(filePath) as any,
      },
    });
    const fileKey = (uploadResp as any)?.data?.file_key ?? (uploadResp as any)?.file_key;
    if (!fileKey) throw new Error("File upload failed: no file_key returned");

    // Send file message
    const resp = await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "file",
        content: JSON.stringify({ file_key: fileKey }),
      },
    });
    return resp?.data?.message_id ?? "";
  }

  async getBotOpenId(): Promise<string> {
    if (this.botOpenId) return this.botOpenId;
    await this.fetchBotIdentity();
    return this.botOpenId ?? "";
  }

  async getBotName(): Promise<string | undefined> {
    if (this.botName) return this.botName;
    await this.fetchBotIdentity();
    return this.botName ?? undefined;
  }

  async getChatName(chatId: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.chat.get({
        path: { chat_id: chatId },
      });
      return resp?.data?.name ?? undefined;
    } catch (err) {
      log.warn("getChatName failed", { chatId, error: String(err) });
      return undefined;
    }
  }

  async getMessageContent(msgId: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.message.get({
        path: { message_id: msgId },
      });
      const msg = resp?.data?.items?.[0] ?? resp?.data;
      const body = (msg as any)?.body?.content;
      if (!body) return undefined;
      try {
        const parsed = JSON.parse(body);
        return parsed.text ?? body;
      } catch {
        return body;
      }
    } catch (err) {
      log.warn("getMessageContent failed", { msgId, error: String(err) });
      return undefined;
    }
  }

  async getAppCreatorId(): Promise<string | undefined> {
    if (this.appCreatorId) return this.appCreatorId;
    try {
      const resp = await this.client.application.application.get({
        path: { app_id: this.appId },
        params: { lang: "zh_cn" },
      } as any);
      const owner = (resp?.data?.app as any)?.owner;
      const creatorId = owner?.owner_id ?? owner?.open_id;
      if (creatorId) {
        this.appCreatorId = creatorId;
        log.info("app creator detected", { creatorId });
      }
      return creatorId ?? undefined;
    } catch (err) {
      log.warn("getAppCreatorId failed", { error: String(err) });
      return undefined;
    }
  }

  private async fetchBotIdentity(): Promise<void> {
    try {
      // Fetch bot info via /open-apis/bot/v3/info/
      const resp = await (this.client as any).request?.({
        method: "GET",
        url: "/open-apis/bot/v3/info/",
      });
      const botInfo = resp?.bot ?? resp?.data?.bot;
      if (botInfo?.open_id) {
        this.botOpenId = botInfo.open_id;
        log.info("bot open_id fetched", { openId: this.botOpenId });
      }
      if (botInfo?.app_name) {
        this.botName = botInfo.app_name;
        log.info("bot name fetched", { name: this.botName });
      }
    } catch (err) {
      log.warn("failed to fetch bot open_id, will use app_id as fallback", { error: String(err) });
      // Fallback: construct a placeholder. Real bot_id will be detected from first mention.
    }

    // Also try to get app creator
    await this.getAppCreatorId().catch(() => {});
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
        mentions?: Array<{
          key?: string;
          id?: { open_id?: string };
          name?: string;
        }>;
        parent_id?: string;
        root_id?: string;
        thread_id?: string;
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

    const msgType = msg.message_type ?? "text";
    const chatType = msg.chat_type === "group" ? "group" as const : "p2p" as const;
    const platformTs = parsePlatformTs(msg.create_time);

    // Parse mentions
    const mentions: MentionInfo[] = [];
    let botMentioned = false;
    if (msg.mentions) {
      for (const m of msg.mentions) {
        const mentionOpenId = m.id?.open_id ?? "";
        const isBot = mentionOpenId === this.botOpenId;
        if (isBot) botMentioned = true;
        mentions.push({
          platformUserId: mentionOpenId,
          name: m.name ?? "",
          isBot,
          key: m.key ?? "",
        });
      }
    }

    // Parse content based on message type
    const { text, contentType, images } = this.parseContent(msgType, msg.content, mentions);

    // For non-text types with empty text, still store but mark appropriately
    if (!text && !images?.length) {
      log.debug("message has no extractable text", { type: msgType, chatId: msg.chat_id });
      return null;
    }

    return {
      senderPlatformId: senderId,
      chatPlatformId: msg.chat_id,
      chatType,
      contentText: text,
      contentType,
      mentions: mentions.length > 0 ? mentions : undefined,
      botMentioned,
      parentPlatformMsgId: msg.parent_id ?? undefined,
      platformTs,
      timestamp: platformTs ? new Date(platformTs) : new Date(),
      platformMsgId: msg.message_id,
      images,
      raw: data,
    };
  }

  /**
   * Parse message content based on type. Returns extracted text and content type.
   * Handles mention placeholder replacement in the text.
   */
  private parseContent(
    msgType: string,
    rawContent: string,
    mentions: MentionInfo[],
  ): { text: string; contentType: NormalizedMessage["contentType"]; images?: Array<{ mimeType: string; data: Buffer }> } {
    let parsed: any;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      return { text: rawContent, contentType: "text" };
    }

    switch (msgType) {
      case "text": {
        let text = parsed.text ?? "";
        text = this.replaceMentions(text, mentions);
        return { text, contentType: "text" };
      }

      case "post": {
        // Rich text: extract text from nested structure
        const text = this.extractPostText(parsed, mentions);
        return { text, contentType: "post" };
      }

      case "interactive": {
        // Card message: extract fallback text
        const text = this.extractInteractiveText(parsed);
        return { text, contentType: "interactive" };
      }

      case "image": {
        // Image: return placeholder text
        return { text: "[图片]", contentType: "image" };
      }

      case "file": {
        const fileName = parsed.file_name ?? "未知文件";
        return { text: `[文件: ${fileName}]`, contentType: "file" };
      }

      case "audio": {
        const duration = parsed.duration ? `${Math.round(parsed.duration / 1000)}秒` : "";
        return { text: `[语音${duration ? " " + duration : ""}]`, contentType: "audio" };
      }

      case "media": {
        const fileName = parsed.file_name ?? "视频";
        return { text: `[视频: ${fileName}]`, contentType: "media" };
      }

      case "merge_forward": {
        // Forwarded messages: extract all nested text
        const text = this.extractMergeForwardText(parsed);
        return { text, contentType: "merge_forward" };
      }

      default: {
        // Unknown type: store with type indicator
        return { text: `[${msgType}]`, contentType: "text" };
      }
    }
  }

  /** Replace @mention placeholders with display names, strip @bot */
  private replaceMentions(text: string, mentions: MentionInfo[]): string {
    for (const m of mentions) {
      if (m.isBot) {
        // Strip bot mention entirely
        text = text.replace(m.key, "").trim();
      } else if (m.key === "@_all" || m.platformUserId === "@_all") {
        // @all mention → @所有人 (key is @_all, open_id may be empty)
        text = text.replace(m.key, "@所有人");
      } else {
        // Replace placeholder with @name
        text = text.replace(m.key, `@${m.name}`);
      }
    }
    return text;
  }

  /** Extract text from rich text (post) messages */
  private extractPostText(parsed: any, mentions: MentionInfo[]): string {
    const parts: string[] = [];
    const title = parsed.title;
    if (title) parts.push(title);

    const content = parsed.content;
    if (Array.isArray(content)) {
      for (const paragraph of content) {
        if (!Array.isArray(paragraph)) continue;
        const lineTexts: string[] = [];
        for (const element of paragraph) {
          if (element.tag === "text") {
            lineTexts.push(element.text ?? "");
          } else if (element.tag === "a") {
            lineTexts.push(element.text ?? element.href ?? "");
          } else if (element.tag === "at") {
            const userId = element.user_id;
            if (userId === "@_all" || userId === "all") {
              lineTexts.push("@所有人");
            } else {
              const mention = mentions.find((m) => m.platformUserId === userId);
              if (mention?.isBot) {
                // Skip bot mention
              } else {
                lineTexts.push(`@${mention?.name ?? element.user_name ?? "用户"}`);
              }
            }
          } else if (element.tag === "img") {
            lineTexts.push("[图片]");
          } else if (element.tag === "emotion") {
            lineTexts.push(element.emoji_type ? `[${element.emoji_type}]` : "");
          }
        }
        if (lineTexts.length > 0) parts.push(lineTexts.join(""));
      }
    }

    return parts.join("\n");
  }

  /** Extract text from interactive card messages */
  private extractInteractiveText(parsed: any): string {
    const parts: string[] = [];

    // Try card v2 format
    if (parsed.body?.elements) {
      for (const el of parsed.body.elements) {
        if (el.tag === "markdown") {
          parts.push(el.content ?? "");
        } else if (el.tag === "div" && el.text?.content) {
          parts.push(el.text.content);
        }
      }
    }

    // Try header
    if (parsed.header?.title?.content) {
      parts.unshift(parsed.header.title.content);
    }

    // Fallback: try to extract any text
    if (parts.length === 0 && parsed.elements) {
      for (const el of parsed.elements) {
        if (el.tag === "div" && el.text?.content) {
          parts.push(el.text.content);
        } else if (el.tag === "markdown") {
          parts.push(el.content ?? "");
        }
      }
    }

    return parts.join("\n") || "[卡片消息]";
  }

  /** Extract text from merge_forward (forwarded) messages */
  private extractMergeForwardText(parsed: any): string {
    const parts: string[] = [];
    const messages = parsed.messages ?? parsed.msg_list ?? [];

    if (!Array.isArray(messages)) {
      return "[合并转发消息]";
    }

    for (const msg of messages) {
      const senderName = msg.sender_name ?? msg.from_name ?? "用户";
      let text = "";
      if (msg.content) {
        try {
          const content = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content;
          text = content.text ?? JSON.stringify(content);
        } catch {
          text = String(msg.content);
        }
      }
      parts.push(`[${senderName}]: ${text}`);
    }

    return parts.length > 0 ? parts.join("\n") : "[合并转发消息]";
  }
}

/** 构建飞书卡片 JSON（对齐 cc-connect buildRichCardJSON） */
function buildCardJSON(header: string, content: string, footer?: string): string {
  let mdContent = content;
  if (footer) {
    mdContent += `\n\n---\n<font color='grey'>${footer}</font>`;
  }
  const card: Record<string, unknown> = {
    schema: "2.0",
    config: { wide_screen_mode: true },
  };
  if (header) {
    card.header = {
      template: "blue",
      title: { tag: "plain_text", content: header },
    };
  }
  if (mdContent) {
    card.body = {
      direction: "vertical",
      elements: [{ tag: "markdown", content: mdContent }],
    };
  }
  return JSON.stringify(card);
}

function parsePlatformTs(val?: string): number | undefined {
  if (!val) return undefined;
  const n = Number(val);
  return Number.isNaN(n) || n === 0 ? undefined : n;
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

/** 检测文本是否包含 Markdown 格式 */
export function containsMarkdown(text: string): boolean {
  // Check for common markdown patterns
  const patterns = [
    /^#{1,6}\s/m,           // Headers
    /\*\*[\s\S]+?\*\*/,     // Bold (**text**)
    /__.+?__/,              // Bold (__text__)
    /(?<!\*)\*(?!\*)[^*\n]+\*(?!\*)/,  // Italic (*text*) — not bold
    /(?<!_)_(?!_)[^_\n]+_(?!_)/,       // Italic (_text_) — not bold
    /```[\s\S]*?```/,       // Code blocks
    /`[^`\n]+`/,            // Inline code
    /~~.+?~~/,              // Strikethrough
    /^\s*[-*+]\s/m,         // Unordered lists
    /^\s*\d+\.\s/m,         // Ordered lists
    /\[.+?\]\(.+?\)/,       // Links
    /^\|.*\|.*\|$/m,        // Tables
    /^>\s/m,                // Blockquotes
    /^---$/m,               // Horizontal rule
  ];
  return patterns.some((p) => p.test(text));
}
