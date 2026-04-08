import * as lark from "@larksuiteoapi/node-sdk";
import fs from "node:fs";
import path from "node:path";
import type { NormalizedMessage, MessageHandler, PlatformAdapter, MentionInfo, MessageNode } from "../types.js";
import { renderMessageNodes } from "../render.js";
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

  /** 可选：通过 platform ID 查询发送者显示名称（只读，注入自 DB） */
  private nameLookup: ((platformId: string) => string | undefined) | null = null;

  /** 可选：注册未知用户并返回显示名称（写入，注入自 DB） */
  private nameRegister: ((platformId: string) => string) | null = null;

  /** 可选：通过 platform msg ID 查询已缓存的消息内容（注入自 DB） */
  private contentResolver: ((platformMsgId: string) => string | undefined) | null = null;

  /** 资源文件存储根目录（DB 同级，注入自 bot-instance） */
  private storageDir: string | null = null;

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

  /** 注入发送者名称查询（只读 DB），用于 merge_forward 等场景 */
  setNameLookup(fn: (platformId: string) => string | undefined): void {
    this.nameLookup = fn;
  }

  /** 注入未知用户注册（写 DB），用于 merge_forward 等场景 */
  setNameRegister(fn: (platformId: string) => string): void {
    this.nameRegister = fn;
  }

  /** 注入消息内容缓存查询（DB 查询），用于 merge_forward 等场景 */
  setContentResolver(fn: (platformMsgId: string) => string | undefined): void {
    this.contentResolver = fn;
  }

  /** 注入资源文件存储目录（DB 同级目录） */
  setStorageDir(dir: string): void {
    this.storageDir = dir;
  }

  /**
   * 下载图片资源到本地，返回绝对路径。失败返回 null。
   * 存储路径：{storageDir}/images/{imageKey}.{ext}
   */
  private async downloadImage(messageId: string, imageKey: string): Promise<string | null> {
    if (!this.storageDir) return null;
    const dir = path.join(this.storageDir, "images");
    fs.mkdirSync(dir, { recursive: true });
    try {
      const resp = await this.client.im.messageResource.get({
        params: { type: "image" },
        path: { message_id: messageId, file_key: imageKey },
      });
      // 从 Content-Type header 推断扩展名
      const contentType: string = resp?.headers?.["content-type"] ?? "";
      const ext = mimeToExt(contentType);
      const filePath = path.join(dir, `${imageKey}${ext}`);
      await resp.writeFile(filePath);
      return filePath;
    } catch (err) {
      log.warn("downloadImage failed", { messageId, imageKey, error: String(err) });
      return null;
    }
  }

  /**
   * 下载文件资源到本地，返回绝对路径。失败返回 null。
   * 存储路径：{storageDir}/files/{fileKey}_{fileName}
   */
  private async downloadFile(messageId: string, fileKey: string, fileName?: string): Promise<string | null> {
    if (!this.storageDir) return null;
    const dir = path.join(this.storageDir, "files");
    fs.mkdirSync(dir, { recursive: true });
    try {
      const resp = await this.client.im.messageResource.get({
        params: { type: "file" },
        path: { message_id: messageId, file_key: fileKey },
      });
      // sanitize fileName to prevent path traversal
      const safeName = (fileName || fileKey).replace(/[/\\]/g, "_");
      const filePath = path.join(dir, `${fileKey}_${safeName}`);
      await resp.writeFile(filePath);
      return filePath;
    } catch (err) {
      log.warn("downloadFile failed", { messageId, fileKey, error: String(err) });
      return null;
    }
  }

  async start(): Promise<void> {
    // Fetch bot identity before starting WebSocket
    await this.fetchBotIdentity();

    const eventDispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        try {
          const msg = await this.normalize(data);
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
    const startedAt = Date.now();
    try {
      await this.client.im.messageReaction.create({
        path: { message_id: msgId },
        data: {
          reaction_type: { emoji_type: emoji },
        },
      });
      log.info("reaction added", { chatId, msgId, emoji, durationMs: Date.now() - startedAt });
    } catch (err) {
      log.warn("addReaction failed", {
        chatId,
        msgId,
        emoji,
        durationMs: Date.now() - startedAt,
        error: String(err),
      });
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

  private async normalize(data: unknown): Promise<NormalizedMessage | null> {
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

    // 非 text 类型记录原始结构，便于排查解析问题
    if (msgType !== "text") {
      log.info("non-text message", {
        msgType,
        messageId: msg.message_id,
        contentLength: msg.content?.length,
        contentPreview: msg.content?.slice(0, 100),
      });
    }

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

    // Parse content based on message type (async: may download resources)
    let { text, contentType } = await this.parseContent(msgType, msg.content, mentions, msg.message_id);

    // For merge_forward, parse into structured tree + render to text
    let children: MessageNode[] | undefined;
    if (contentType === "merge_forward" && msg.message_id) {
      const { nodes, rendered } = await this.parseMergeForward(msg.message_id);
      text = rendered;
      children = nodes.length > 0 ? nodes : undefined;
    }

    // For non-text types with empty text, still store but mark appropriately
    if (!text) {
      log.debug("message has no extractable text", { type: msgType, chatId: msg.chat_id });
      return null;
    }

    return {
      senderPlatformId: senderId,
      chatPlatformId: msg.chat_id,
      chatType,
      contentText: text,
      contentType,
      children,
      mentions: mentions.length > 0 ? mentions : undefined,
      botMentioned,
      parentPlatformMsgId: msg.parent_id ?? undefined,
      platformTs,
      timestamp: platformTs ? new Date(platformTs) : new Date(),
      platformMsgId: msg.message_id,
      raw: data,
    };
  }

  /**
   * Parse message content based on type. Returns extracted text and content type.
   * Handles mention placeholder replacement in the text.
   * For image/file types, downloads the resource and injects the local path.
   */
  private async parseContent(
    msgType: string,
    rawContent: string,
    mentions: MentionInfo[],
    messageId?: string,
  ): Promise<{ text: string; contentType: NormalizedMessage["contentType"] }> {
    // merge_forward: content 是纯文本占位符（非 JSON），须在 JSON.parse 前处理
    if (msgType === "merge_forward") {
      return { text: "[合并转发消息]", contentType: "merge_forward" };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      // JSON 解析失败时保留原始 msgType（已知类型映射为对应 contentType）
      const knownTypes = new Set(["image", "audio", "file", "media", "post", "interactive"]);
      const contentType: NormalizedMessage["contentType"] = knownTypes.has(msgType) ? msgType as any : "text";
      return { text: rawContent, contentType };
    }

    switch (msgType) {
      case "text": {
        let text = parsed.text ?? "";
        text = this.replaceMentions(text, mentions);
        return { text, contentType: "text" };
      }

      case "post": {
        // Rich text: extract text from nested structure, download embedded images
        const text = await this.extractPostContent(parsed, mentions, messageId);
        const hasImages = text.includes("[图片:");
        return { text, contentType: hasImages ? "mixed" : "post" };
      }

      case "interactive": {
        // Card message: extract fallback text
        const text = this.extractInteractiveText(parsed);
        return { text, contentType: "interactive" };
      }

      case "image": {
        const imageKey: string = parsed.image_key ?? "";
        if (imageKey && messageId) {
          const filePath = await this.downloadImage(messageId, imageKey);
          if (filePath) {
            return { text: `用户发送了一张图片，请查看：${filePath}`, contentType: "image" };
          }
        }
        return { text: "[图片]", contentType: "image" };
      }

      case "file": {
        const fileKey: string = parsed.file_key ?? "";
        const fileName: string = parsed.file_name ?? "未知文件";
        if (fileKey && messageId) {
          const filePath = await this.downloadFile(messageId, fileKey, fileName);
          if (filePath) {
            return { text: `用户发送了文件，请查看：${filePath}`, contentType: "file" };
          }
        }
        return { text: `[文件: ${fileName}]`, contentType: "file" };
      }

      case "audio": {
        const duration = parsed.duration ? `${Math.round(parsed.duration / 1000)}秒` : "";
        const durationText = duration ? `（${duration}）` : "";
        return { text: `用户发送了一段语音${durationText}，当前不支持语音消息`, contentType: "audio" };
      }

      case "media": {
        const fileName = parsed.file_name ?? "视频";
        return { text: `用户发送了视频：${fileName}，当前不支持视频消息`, contentType: "media" };
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

  /**
   * Extract text from rich text (post) messages, downloading embedded images.
   * Used by parseContent (main flow) where image download is available.
   */
  private async extractPostContent(parsed: any, mentions: MentionInfo[], messageId?: string): Promise<string> {
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
            const imageKey: string = element.image_key ?? "";
            if (imageKey && messageId) {
              const filePath = await this.downloadImage(messageId, imageKey);
              if (filePath) {
                lineTexts.push(`[图片: ${filePath}]`);
                continue;
              }
            }
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

  /**
   * Extract text from rich text (post) messages without downloading images.
   * Used by extractChildMessageText (merge_forward) where image download is not supported.
   */
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

  /** Fetch and render merge_forward message content via API (recursive) */
  private async parseMergeForward(messageId: string): Promise<{ nodes: MessageNode[]; rendered: string }> {
    const visited = new Set<string>();
    const nodes = await this.parseForwardNodes(messageId, visited, 0);
    if (nodes.length === 0) return { nodes, rendered: "[merge_forward]" };
    return { nodes, rendered: "【合并转发消息】\n" + renderMessageNodes(nodes, 0) };
  }

  /** Parse merge_forward into structured MessageNode tree */
  private async parseForwardNodes(
    messageId: string,
    visited: Set<string>,
    depth: number,
  ): Promise<MessageNode[]> {
    if (depth > 5 || visited.has(messageId)) return [];
    visited.add(messageId);

    let items: any[];
    try {
      const resp = await this.client.im.message.get({
        path: { message_id: messageId },
      });
      items = (resp?.data as any)?.items ?? [];
      if (!Array.isArray(items) || items.length === 0) return [];
    } catch (err) {
      log.warn("parseForwardNodes fetch failed", { messageId, depth, error: String(err) });
      return [];
    }

    const nodes: MessageNode[] = [];
    // 已解析节点索引，用于解析 reply 引用
    const nodeMap = new Map<string, MessageNode>();

    for (const item of items) {
      const msgType: string = item.msg_type ?? "";
      const childId: string = item.message_id ?? "";
      if (!childId) continue;

      const senderName = this.resolveSenderFromItem(item);

      // Nested merge_forward: recurse
      if (msgType === "merge_forward") {
        const children = await this.parseForwardNodes(childId, visited, depth + 1);
        if (children.length > 0) {
          const node: MessageNode = { sender: senderName, contentType: "forward", children };
          nodes.push(node);
        }
        continue;
      }

      // Leaf message: extract content
      const text = this.extractChildMessageText(msgType, item);
      const content = text || `[${msgType || "unknown"}]`;
      const contentType = msgType || "unknown";

      const node: MessageNode = { id: childId, sender: senderName, contentType, content };

      // Resolve quoted message for reply
      const parentId: string | undefined = item.parent_id;
      if (parentId) {
        // 优先从当前转发组内查找
        const quotedNode = nodeMap.get(parentId);
        if (quotedNode) {
          node.quoted = quotedNode;
        } else if (this.contentResolver) {
          // Fallback: 从 DB 查找（跨组引用）
          const cachedText = this.contentResolver(parentId);
          if (cachedText) {
            node.quoted = { sender: "", contentType: "text", content: cachedText };
          }
        }
      }

      nodeMap.set(childId, node);
      nodes.push(node);
    }

    return nodes;
  }

  /** Resolve sender display name (对齐 cc-connect resolveSenderName: lookup → bot → register) */
  private resolveSenderFromItem(item: any): string {
    const sender = item.sender;
    if (!sender?.id) return "未知";

    // 1. DB 只读查询（已知用户直接返回）
    if (this.nameLookup) {
      const name = this.nameLookup(sender.id);
      if (name) return name;
    }

    // 2. App/Bot 识别
    if (sender.sender_type === "app") {
      if (sender.id === this.botOpenId || sender.id === this.appId) {
        // 用 bot 的 open_id 查 DB，保持 "U3(NiuBot)" 统一格式
        if (this.nameLookup && this.botOpenId) {
          const label = this.nameLookup(this.botOpenId);
          if (label) return label;
        }
        return this.botName ?? "Bot";
      }
      // 其他 app/bot：注册并返回 label
      // TODO: fetchAppName — 通过飞书 API 获取 app 名称
      if (this.nameRegister) {
        return this.nameRegister(sender.id);
      }
      return "Bot";
    }

    // 3. 未知用户：注册并返回 "U{n}(未知用户)"
    if (this.nameRegister) {
      return this.nameRegister(sender.id);
    }
    return "用户";
  }

  /** Fetch child message content: DB cache → API item body → type fallback */
  private extractChildMessageText(msgType: string, item: any): string {
    const childId: string = item.message_id ?? "";

    // DB 优先：查已缓存的消息内容
    if (childId && this.contentResolver) {
      const cached = this.contentResolver(childId);
      if (cached) return cached;
    }

    // Fallback: 从 API 响应体解析
    const raw = item.body?.content;
    if (!raw) return "";

    try {
      const parsed = JSON.parse(raw);
      let text: string;
      switch (msgType) {
        case "text":
          text = parsed.text ?? "";
          break;
        case "post":
          text = this.extractPostText(parsed, []);
          break;
        case "interactive":
          text = this.extractInteractiveText(parsed);
          break;
        case "image":
          return "[图片]";
        case "audio":
          return "[语音]";
        case "file":
          return `[文件: ${parsed.file_name ?? ""}]`;
        case "media":
          return `[视频: ${parsed.file_name ?? ""}]`;
        default:
          return `[${msgType}]`;
      }

      // Mention 替换（API 响应中携带 mentions 列表）
      if (text && Array.isArray(item.mentions) && item.mentions.length > 0) {
        text = this.applyItemMentions(text, item.mentions);
      }

      return text;
    } catch {
      return raw;
    }
  }

  /** Apply mention replacements from message.get() API response */
  private applyItemMentions(text: string, mentions: any[]): string {
    for (const m of mentions) {
      const key: string = m.key ?? "";
      if (!key) continue;
      const id: string = m.id ?? "";
      if (id && this.botOpenId && id === this.botOpenId) {
        text = text.replace(key, "").trim();
      } else {
        const name: string = m.name ?? "";
        text = text.replace(key, name ? `@${name}` : "");
      }
    }
    return text;
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

/** MIME type → file extension */
function mimeToExt(mime: string): string {
  if (mime.includes("jpeg")) return ".jpg";
  if (mime.includes("png")) return ".png";
  if (mime.includes("gif")) return ".gif";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("bmp")) return ".bmp";
  if (mime.includes("pdf")) return ".pdf";
  return ".bin";
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
