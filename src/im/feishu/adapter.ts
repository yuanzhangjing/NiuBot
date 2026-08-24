import * as lark from "@larksuiteoapi/node-sdk";
import fs from "node:fs";
import { mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NormalizedMessage, MessageHandler, PlatformAdapter, MentionInfo, MessageNode } from "../types.js";
import type { ChatMetadata, DeliveryOptions } from "../../transport/types.js";
import { renderMessageNodes } from "../render.js";
import { hasFeishuAtTag, mapFeishuAtTags, toCardAtTags } from "../mentions.js";
import { classifyFetchedMessage, type ClassifiedMessageIdentity } from "./message-identity.js";
import { parseFeishuHistoryItem } from "./history.js";
import { createLogger } from "../../logger.js";

const log = createLogger("feishu");

/** 超过此字节数的消息转为文件发送 */
const FILE_THRESHOLD_BYTES = 10_000;

/** 这些扩展名的文件按图片消息（msg_type=image）发送，其余按文件消息发送 */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

/** 飞书图片上传接口上限 10MB，超出时降级为文件消息 */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** 飞书会话消息列表单页上限。 */
const FEISHU_MESSAGE_PAGE_SIZE = 50;
/** 增量同步最多翻页数，避免 has_more 异常时打爆接口。 */
const FEISHU_MESSAGE_MAX_PAGES = 20;

function describeDownloadError(code: number | undefined, status: number | string | undefined): string | null {
  switch (code) {
    case 234037: return "文件超过飞书 API 100MB 下载上限";
    case 234038: return "消息处于防泄漏保护模式，无法下载";
    case 234043: return "不支持的消息类型（合并转发/卡片等）";
    case 234004: return "Bot 不在该会话中，无法下载";
  }
  const s = Number(status);
  if (s === 400) return "下载失败（飞书 API 400，可能文件超过 100MB 上限）";
  if (s >= 400) return `下载失败（HTTP ${s}）`;
  return null;
}

function isTopicReplyUnsupported(err: unknown): boolean {
  const candidate = err as { code?: number | string; message?: string };
  if (Number(candidate?.code) === 230071) return true;
  const message = String(candidate?.message ?? err ?? "");
  return /230071|不支持以话题形式回复/.test(message);
}

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
  private nameRegister: ((platformId: string, isBot?: boolean) => string) | null = null;

  /** GET 成功确认为人的 open_id。失败不写入，下一条还能再刷。 */
  private confirmedHumans = new Set<string>();

  /** 可选：通过 platform msg ID 查询已缓存的消息内容（注入自 DB） */
  private contentResolver: ((platformMsgId: string) => string | undefined) | null = null;

  /** 可选：查询本地 users 表身份。undefined 表示第一次遇见。 */
  private identityLookup: ((platformId: string) => { isBot: boolean } | undefined) | null = null;

  /** 可选：自身 open_id 就绪后通知同机其他 Bot。 */
  private onIdentity: ((identity: { openId: string; name: string | null }) => void) | null = null;

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
  setNameRegister(fn: (platformId: string, isBot?: boolean) => string): void {
    this.nameRegister = fn;
  }

  /** 注入消息内容缓存查询（DB 查询），用于 merge_forward 等场景 */
  setContentResolver(fn: (platformMsgId: string) => string | undefined): void {
    this.contentResolver = fn;
  }

  /** 注入本地用户身份查询，用于决定要不要 GET 消息补标 Bot。 */
  setIdentityLookup(fn: (platformId: string) => { isBot: boolean } | undefined): void {
    this.identityLookup = fn;
  }

  /** 自身飞书身份就绪后回调（open_id / 名称）。 */
  setOnIdentity(fn: (identity: { openId: string; name: string | null }) => void): void {
    this.onIdentity = fn;
  }

  /** 注入资源文件存储目录（DB 同级目录） */
  setStorageDir(dir: string): void {
    this.storageDir = dir;
  }

  private async streamDownload(resp: { headers: any; getReadableStream: () => Readable }, filePath: string, label: string): Promise<boolean> {
    const writable = fs.createWriteStream(filePath);
    try {
      const readable = resp.getReadableStream();
      await pipeline(readable, writable);
      const { size } = fs.statSync(filePath);
      log.info(`${label}: downloaded ${size} bytes to ${filePath}`);
      return true;
    } catch (err) {
      writable.destroy();
      try { unlinkSync(filePath); } catch {}
      log.warn(`${label}: stream download failed`, { error: String(err) });
      return false;
    }
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
      const contentType: string = resp?.headers?.["content-type"] ?? "";
      const ext = mimeToExt(contentType);
      const filePath = path.join(dir, `${imageKey}${ext}`);
      if (!await this.streamDownload(resp, filePath, `downloadImage(${imageKey})`)) return null;
      return filePath;
    } catch (err) {
      const status: number | undefined = (err as any)?.response?.status;
      log.warn("downloadImage failed", { messageId, imageKey, error: String(err), status });
      return null;
    }
  }

  /**
   * 下载文件资源到本地，返回绝对路径。失败返回 null。
   * 存储路径：{storageDir}/files/{fileKey}_{fileName}
   */
  private async downloadFile(messageId: string, fileKey: string, fileName?: string): Promise<{ path: string } | { error: string } | null> {
    if (!this.storageDir) return null;
    const dir = path.join(this.storageDir, "files");
    fs.mkdirSync(dir, { recursive: true });
    try {
      const resp = await this.client.im.messageResource.get({
        params: { type: "file" },
        path: { message_id: messageId, file_key: fileKey },
      });
      const safeName = (fileName || fileKey).replace(/[/\\]/g, "_");
      const filePath = path.join(dir, `${fileKey}_${safeName}`);
      if (!await this.streamDownload(resp, filePath, `downloadFile(${fileKey})`)) return null;
      return { path: filePath };
    } catch (err) {
      const resp = (err as any)?.response;
      const status: number | undefined = resp?.status;
      const code: number | undefined = typeof resp?.data === "object" && resp?.data !== null && !Buffer.isBuffer(resp.data) ? resp.data.code : undefined;
      const reason = describeDownloadError(code, status);
      log.warn("downloadFile failed", { messageId, fileKey, error: String(err), status, code, reason });
      if (reason) return { error: reason };
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
          if (msg) await this.handler?.(msg);
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

  async sendText(chatId: string, text: string, _options?: DeliveryOptions): Promise<string> {
    if (Buffer.byteLength(text, "utf-8") > FILE_THRESHOLD_BYTES && !hasFeishuAtTag(text)) {
      log.info("sendText: content exceeds threshold, sending as file", { chatId, bytes: Buffer.byteLength(text, "utf-8") });
      return this.sendContentAsFile(chatId, text);
    }
    const resp = await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    return resp?.data?.message_id ?? "";
  }

  async sendReply(chatId: string, text: string, replyToMsgId: string, options?: DeliveryOptions): Promise<string> {
    if (Buffer.byteLength(text, "utf-8") > FILE_THRESHOLD_BYTES && !hasFeishuAtTag(text)) {
      log.info("sendReply: content exceeds threshold, sending as file", { chatId, bytes: Buffer.byteLength(text, "utf-8") });
      return this.sendContentAsFile(chatId, text, replyToMsgId, options);
    }
    try {
      const resp = await this.client.im.message.reply({
        path: { message_id: replyToMsgId },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text }),
          ...(options?.replyInThread ? { reply_in_thread: true } : {}),
        },
      });
      return resp?.data?.message_id ?? "";
    } catch (err) {
      if (isTopicReplyUnsupported(err) && options?.replyInThread) throw err;
      throw err;
    }
  }

  async sendMarkdownCard(chatId: string, markdown: string, options?: DeliveryOptions): Promise<string> {
    return this.sendCard(chatId, "", markdown, undefined, undefined, options);
  }

  async sendCard(
    chatId: string,
    header: string,
    content: string,
    footer?: string,
    replyToMsgId?: string,
    options?: DeliveryOptions,
  ): Promise<string> {
    const hasAt = hasFeishuAtTag(content);
    if (!hasAt && Buffer.byteLength(content, "utf-8") > FILE_THRESHOLD_BYTES) {
      log.info("sendCard: content exceeds threshold, sending as file", { chatId, bytes: Buffer.byteLength(content, "utf-8") });
      const fileContent = footer ? `${content}\n\n---\n${footer}` : content;
      return this.sendContentAsFile(chatId, fileContent, replyToMsgId, options);
    }
    const cardJson = buildCardJSON(header, content, footer);
    try {
      if (replyToMsgId) {
        const resp = await this.client.im.message.reply({
          path: { message_id: replyToMsgId },
          data: {
            msg_type: "interactive",
            content: cardJson,
            ...(options?.replyInThread ? { reply_in_thread: true } : {}),
          },
        });
        return resp?.data?.message_id ?? "";
      }
      const resp = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "interactive",
          content: cardJson,
        },
      });
      return resp?.data?.message_id ?? "";
    } catch (err) {
      if (isTopicReplyUnsupported(err) && options?.replyInThread) throw err;
      if (hasAt) throw err;
      log.warn("sendCard: card API failed, fallback to file", { chatId, error: String(err) });
      const fileContent = footer ? `${content}\n\n---\n${footer}` : content;
      return this.sendContentAsFile(chatId, fileContent, replyToMsgId, options);
    }
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

  /** 将文本内容写入临时 .md 文件并发送 */
  private async sendContentAsFile(
    chatId: string,
    content: string,
    replyToMsgId?: string,
    options?: DeliveryOptions,
  ): Promise<string> {
    const dir = mkdtempSync(path.join(tmpdir(), "niubot-msg-"));
    const filePath = path.join(dir, "reply.md");
    writeFileSync(filePath, content, "utf-8");
    try {
      return await this.sendFile(
        chatId,
        filePath,
        "reply.md",
        replyToMsgId
          ? { replyToMsgId, replyInThread: options?.replyInThread }
          : undefined,
      );
    } finally {
      try { unlinkSync(filePath); } catch { /* ignore */ }
    }
  }

  async sendFile(chatId: string, filePath: string, fileName?: string, options?: DeliveryOptions): Promise<string> {
    const name = fileName ?? path.basename(filePath);
    const replyToMsgId = options?.replyToMsgId;
    if (IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())) {
      const bytes = fs.statSync(filePath).size;
      if (bytes > IMAGE_MAX_BYTES) {
        log.info("sendFile: image exceeds 10MB, sending as file", { chatId, fileName: name, bytes });
      } else {
        try {
          return await this.sendImage(chatId, filePath, replyToMsgId, options);
        } catch (err) {
          log.warn("sendFile: image API failed, fallback to file", { chatId, fileName: name, error: String(err) });
        }
      }
    }
    return withFileReadStream(filePath, async (file) => {
      const uploadResp = await this.client.im.file.create({
        data: {
          file_type: "stream",
          file_name: name,
          file: file as any,
        },
      });
      const fileKey = (uploadResp as any)?.data?.file_key ?? (uploadResp as any)?.file_key;
      if (!fileKey) throw new Error("File upload failed: no file_key returned");
      return this.postMessage(chatId, "file", JSON.stringify({ file_key: fileKey }), replyToMsgId, options);
    });
  }

  private async sendImage(
    chatId: string,
    filePath: string,
    replyToMsgId?: string,
    options?: DeliveryOptions,
  ): Promise<string> {
    return withFileReadStream(filePath, async (image) => {
      const uploadResp = await this.client.im.image.create({
        data: {
          image_type: "message",
          image: image as any,
        },
      });
      const imageKey = (uploadResp as any)?.data?.image_key ?? (uploadResp as any)?.image_key;
      if (!imageKey) throw new Error("Image upload failed: no image_key returned");
      return this.postMessage(chatId, "image", JSON.stringify({ image_key: imageKey }), replyToMsgId, options);
    });
  }

  private async postMessage(
    chatId: string,
    msgType: string,
    content: string,
    replyToMsgId?: string,
    options?: DeliveryOptions,
  ): Promise<string> {
    if (replyToMsgId) {
      try {
        const resp = await this.client.im.message.reply({
          path: { message_id: replyToMsgId },
          data: {
            msg_type: msgType,
            content,
            ...(options?.replyInThread ? { reply_in_thread: true } : {}),
          },
        });
        return resp?.data?.message_id ?? "";
      } catch (err) {
        if (isTopicReplyUnsupported(err) && options?.replyInThread) throw err;
        throw err;
      }
    }
    const resp = await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: msgType,
        content,
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

  async getChatMetadata(chatId: string): Promise<ChatMetadata | undefined> {
    try {
      const resp = await this.client.im.chat.get({
        path: { chat_id: chatId },
      });
      const data = resp?.data as any;
      return {
        chatMode: typeof data?.chat_mode === "string" ? data.chat_mode : undefined,
        groupMessageType: typeof data?.group_message_type === "string"
          ? data.group_message_type
          : undefined,
        fetchedAt: Date.now(),
      };
    } catch (err) {
      log.warn("getChatMetadata failed", { chatId, error: String(err) });
      return undefined;
    }
  }

  async getMessageThreadId(messageId: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.message.get({
        path: { message_id: messageId },
      });
      const data = resp?.data as any;
      const item = data?.items?.[0] ?? data?.message;
      if (typeof item?.thread_id === "string" && item.thread_id) return item.thread_id;
      if (typeof data?.thread_id === "string" && data.thread_id) return data.thread_id;
      return undefined;
    } catch (err) {
      log.warn("getMessageThreadId failed", { messageId, error: String(err) });
      return undefined;
    }
  }

  async listChatMessages(
    chatId: string,
    options?: { sinceUnixSec?: number; limit?: number; threadId?: string },
  ): Promise<NormalizedMessage[]> {
    const sinceUnixSec = options?.sinceUnixSec;
    const incremental = sinceUnixSec != null;
    const maxTotal = Math.min(
      Math.max(
        options?.limit ?? (incremental ? FEISHU_MESSAGE_PAGE_SIZE * FEISHU_MESSAGE_MAX_PAGES : FEISHU_MESSAGE_PAGE_SIZE),
        1,
      ),
      FEISHU_MESSAGE_PAGE_SIZE * FEISHU_MESSAGE_MAX_PAGES,
    );
    const sortType = incremental ? "ByCreateTimeAsc" : "ByCreateTimeDesc";
    const collected: NormalizedMessage[] = [];
    let pageToken: string | undefined;
    try {
      for (let page = 0; page < FEISHU_MESSAGE_MAX_PAGES && collected.length < maxTotal; page += 1) {
        const resp = await this.client.im.message.list({
          params: {
            container_id_type: options?.threadId ? "thread" : "chat",
            container_id: options?.threadId ?? chatId,
            page_size: FEISHU_MESSAGE_PAGE_SIZE,
            sort_type: sortType,
            ...(incremental ? { start_time: String(sinceUnixSec) } : {}),
            ...(pageToken ? { page_token: pageToken } : {}),
            // SDK 类型未声明，运行时带上以便 mention 能区分 Bot
            user_id_type: "open_id",
          } as {
            container_id_type: string;
            container_id: string;
            start_time?: string;
            page_token?: string;
            sort_type?: "ByCreateTimeAsc" | "ByCreateTimeDesc";
            page_size?: number;
          },
        });
        const data = resp?.data as { items?: unknown[]; has_more?: boolean; page_token?: string } | undefined;
        const items = Array.isArray(data?.items) ? data.items : [];
        for (const item of items) {
          const msg = parseFeishuHistoryItem(item, chatId, this.botOpenId, this.appId);
          if (!msg) continue;
          collected.push(msg);
          if (collected.length >= maxTotal) break;
        }
        // 无 cursor 时只要最新一页；增量 ASC 才翻页，否则会漏掉 cursor 之后的新消息。
        if (!incremental) break;
        const hasMore = data?.has_more === true;
        pageToken = typeof data?.page_token === "string" && data.page_token ? data.page_token : undefined;
        if (!hasMore || !pageToken) break;
      }
    } catch (err) {
      log.warn("listChatMessages failed", { chatId, error: String(err) });
      throw err;
    }
    if (!incremental) collected.reverse();
    return collected;
  }

  async getMessageContent(msgId: string): Promise<string | undefined> {
    try {
      const body = await this.fetchMessageBody(msgId, true);
      if (!body) return undefined;

      try {
        const parsed = JSON.parse(body);
        if (typeof parsed.text === "string") return parsed.text;

        if (Array.isArray(parsed.content)) {
          const post = this.extractPostText(parsed, []);
          if (post) return post;
        }

        if (parsed.schema === "2.0" || parsed.header || parsed.body?.elements || parsed.elements) {
          const card = this.extractInteractiveText(parsed);
          return card === "[卡片消息]" ? undefined : card;
        }
      } catch {
        // Keep the original body for non-JSON message content.
      }

      return body;
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
      this.emitIdentity();
    } catch (err) {
      log.warn("failed to fetch bot open_id, will use app_id as fallback", { error: String(err) });
      // Fallback: construct a placeholder. Real bot_id will be detected from first mention.
    }

    // Also try to get app creator
    await this.getAppCreatorId().catch(() => {});
  }

  private emitIdentity(): void {
    if (!this.botOpenId || !this.onIdentity) return;
    this.onIdentity({ openId: this.botOpenId, name: this.botName });
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
          id?: { open_id?: string; app_id?: string } | string;
          id_type?: string;
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
    const rawChatType = msg.chat_type ?? "p2p";
    const chatType = (rawChatType === "group" || rawChatType === "topic_group")
      ? "group" as const
      : "p2p" as const;
    const platformTs = parsePlatformTs(msg.create_time);
    if (chatType === "group") {
      log.debug("feishu incoming group message", {
        rawChatType,
        threadId: msg.thread_id,
        rootId: msg.root_id,
        parentId: msg.parent_id,
      });
    }

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
        const mentionId = typeof m.id === "string" ? m.id : (m.id?.open_id || m.id?.app_id || "");
        const isBot = mentionId === this.botOpenId || mentionId === this.appId;
        if (isBot) botMentioned = true;
        mentions.push({
          platformUserId: mentionId,
          name: m.name ?? "",
          isBot,
          isApp: isBot || m.id_type === "app_id" || mentionId.startsWith("cli_"),
          key: m.key ?? "",
        });
      }
    }

    let senderIsBot = event.sender?.sender_type === "app"
      || event.sender?.sender_id?.open_id?.startsWith("cli_") === true;
    this.applyKnownIdentities(senderId, mentions, (isBot) => {
      if (isBot) senderIsBot = true;
    });
    if (msg.message_id && this.needsIdentityFetch(chatType, senderId, senderIsBot, event.sender?.sender_type, mentions)) {
      const fetched = await this.fetchMessageIdentity(msg.message_id);
      if (fetched) {
        if (fetched.senderIsApp) senderIsBot = true;
        else this.rememberHuman(senderId);
        for (const mention of mentions) {
          if (fetched.appMentionKeys.has(mention.key)) mention.isApp = true;
          else if (fetched.fetchedMentionKeys.has(mention.key)) this.rememberHuman(mention.platformUserId);
        }
      }
    }

    // Parse content based on message type (async: may download resources)
    let { text, contentType, downloadError } = await this.parseContent(msgType, msg.content, mentions, msg.message_id);

    if (downloadError) {
      log.info("file download error, notifying user", { downloadError, messageId: msg.message_id, chatId: msg.chat_id });
      if (msg.message_id && msg.chat_id) {
        this.sendReply(msg.chat_id, downloadError, msg.message_id).catch((e) =>
          log.warn("failed to send download error reply", { error: String(e) }),
        );
      }
    }

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
      senderIsBot,
      parentPlatformMsgId: msg.parent_id ?? undefined,
      threadId: msg.thread_id ?? undefined,
      rootId: msg.root_id ?? undefined,
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
  ): Promise<{ text: string; contentType: NormalizedMessage["contentType"]; downloadError?: string }> {
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
        let text = this.extractInteractiveText(parsed);
        if (this.isDegradedCardText(text) && messageId) {
          const original = await this.fetchOriginalCardParsed(messageId);
          if (original) text = this.extractInteractiveText(original);
        }
        if (this.isDegradedCardText(text)) text = "[卡片消息]";
        text = this.replaceCardMentions(text, mentions);
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
          const result = await this.downloadFile(messageId, fileKey, fileName);
          if (result && "path" in result) {
            return { text: `用户发送了文件，请查看：${result.path}`, contentType: "file" };
          }
          if (result && "error" in result) {
            return { text: `[文件: ${fileName}]`, contentType: "file", downloadError: result.error };
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

  /** Replace @mention placeholders with display names */
  private replaceMentions(text: string, mentions: MentionInfo[]): string {
    for (const m of mentions) {
      if (m.key === "@_all" || m.platformUserId === "@_all") {
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
              lineTexts.push(`@${mention?.name ?? element.user_name ?? "用户"}`);
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
              lineTexts.push(`@${mention?.name ?? element.user_name ?? "用户"}`);
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

  /** 事件/默认 GET 里的 schema 2.0 卡片是「请升级客户端」占位，不是原文。 */
  private isDegradedCardText(text: string): boolean {
    if (!text || text === "[卡片消息]") return true;
    return text.includes("请升级至最新版本客户端") || text.includes("请升级客户端");
  }

  private async fetchOriginalCardParsed(messageId: string): Promise<any | null> {
    try {
      const raw = await this.fetchMessageBody(messageId, true);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    } catch (err) {
      log.warn("fetch original card failed", { messageId, error: String(err) });
      return null;
    }
  }

  private async fetchMessageBody(messageId: string, originalCardContent: boolean): Promise<string | undefined> {
    const request: any = { path: { message_id: messageId } };
    if (originalCardContent) {
      request.params = { card_msg_content_type: "user_card_content" };
    }
    const resp = await this.client.im.message.get(request);
    const msg = (resp?.data as any)?.items?.[0] ?? (resp?.data as any);
    const body = msg?.body?.content;
    return typeof body === "string" ? body : undefined;
  }

  private rememberHuman(platformId: string): void {
    if (platformId) this.confirmedHumans.add(platformId);
  }

  private isConfirmedHuman(platformId: string): boolean {
    return this.confirmedHumans.has(platformId);
  }

  private isKnownBot(platformId: string): boolean {
    return this.identityLookup?.(platformId)?.isBot === true;
  }

  private applyKnownIdentities(
    senderId: string,
    mentions: MentionInfo[],
    setSenderIsBot: (isBot: boolean) => void,
  ): void {
    if (this.isKnownBot(senderId)) setSenderIsBot(true);
    for (const mention of mentions) {
      if (mention.isBot || mention.isApp || !mention.platformUserId) continue;
      if (this.isKnownBot(mention.platformUserId)) mention.isApp = true;
    }
  }

  private needsIdentityFetch(
    chatType: "p2p" | "group",
    senderId: string,
    senderIsBot: boolean,
    senderType: string | undefined,
    mentions: MentionInfo[],
  ): boolean {
    if (chatType !== "group" || !this.identityLookup) return false;
    const senderNeedsFetch = !senderIsBot
      && senderType !== "user"
      && !this.isKnownBot(senderId)
      && !this.isConfirmedHuman(senderId);
    if (senderNeedsFetch) return true;
    return mentions.some((mention) => {
      if (!mention.platformUserId || mention.isBot || mention.isApp) return false;
      if (this.isKnownBot(mention.platformUserId) || this.isConfirmedHuman(mention.platformUserId)) return false;
      return true;
    });
  }

  private async fetchMessageIdentity(messageId: string): Promise<ClassifiedMessageIdentity | null> {
    try {
      // 必须带 user_id_type。缺省时 Bot mention 会收成 open_id，带上后才是 app_id。
      const resp = await this.client.im.message.get({
        path: { message_id: messageId },
        params: { user_id_type: "open_id" },
      });
      const item = (resp?.data as any)?.items?.[0] ?? (resp?.data as any);
      if (!item) return null;
      const classified = classifyFetchedMessage({
        sender: item.sender,
        mentions: Array.isArray(item.mentions) ? item.mentions : [],
      });
      log.info("message identity fetched", {
        messageId,
        senderIsApp: classified.senderIsApp,
        appMentions: classified.appMentionKeys.size,
        fetchedMentions: classified.fetchedMentionKeys.size,
      });
      return classified;
    } catch (err) {
      log.warn("fetch message identity failed", { messageId, error: String(err) });
      return null;
    }
  }

  private replaceCardMentions(text: string, mentions: MentionInfo[]): string {
    let out = this.replaceMentions(text, mentions);
    out = mapFeishuAtTags(out, (platformId, inner) => {
      const mention = mentions.find((m) => m.platformUserId === platformId);
      const name = mention?.name?.trim() || inner.trim();
      return name ? `@${name}` : "";
    });
    return out;
  }

  /** Extract text from interactive card messages */
  private extractInteractiveText(parsed: any): string {
    const parts: string[] = [];

    const take = (el: any): void => {
      if (!el) return;
      if (Array.isArray(el)) {
        for (const child of el) take(child);
        return;
      }
      if (typeof el !== "object") return;
      if (el.tag === "markdown" || el.tag === "lark_md") {
        parts.push(el.content ?? el.text?.content ?? "");
      } else if (el.tag === "div" && el.text?.content) {
        parts.push(el.text.content);
      } else if (el.tag === "text" && typeof el.text === "string" && el.text) {
        parts.push(el.text);
      }
      if (el.body?.elements) take(el.body.elements);
      if (el.elements) take(el.elements);
    };

    take(parsed.body?.elements);
    if (parsed.header?.title?.content) {
      parts.unshift(parsed.header.title.content);
    }
    if (parts.length === 0) take(parsed.elements);

    const text = parts.map((part) => part.trim()).filter(Boolean).join("\n");
    return text || "[卡片消息]";
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

  /** Resolve sender display name: lookup -> bot -> register. */
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
        return this.nameRegister(sender.id, true);
      }
      return "Bot";
    }

    // 3. 未知用户：注册并返回 "U{n}(未知用户)"
    if (this.nameRegister) {
      return this.nameRegister(sender.id, false);
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

/** 飞书卡片 header 模板颜色（与飞书 schema 2.0 一致） */
const CARD_HEADER_TEMPLATES = new Set([
  "blue", "wathet", "turquoise", "indigo", "violet", "red", "orange", "green", "grey",
]);

/** 构建飞书卡片 JSON。header 支持 "标题|颜色" 语法选择 header 模板颜色。 */
function buildCardJSON(header: string, content: string, footer?: string): string {
  let mdContent = toCardAtTags(content);
  if (footer) {
    mdContent += `\n\n---\n<font color='grey'>${footer}</font>`;
  }
  const card: Record<string, unknown> = {
    schema: "2.0",
    config: { wide_screen_mode: true },
  };
  if (header) {
    const { title, template } = parseCardHeader(header);
    card.header = {
      template,
      title: { tag: "plain_text", content: title },
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

function parseCardHeader(header: string): { title: string; template: string } {
  const sep = header.lastIndexOf("|");
  if (sep > 0) {
    const color = header.slice(sep + 1).trim();
    if (CARD_HEADER_TEMPLATES.has(color)) {
      return { title: header.slice(0, sep).trim(), template: color };
    }
  }
  return { title: header, template: "blue" };
}

function parsePlatformTs(val?: string): number | undefined {
  if (!val) return undefined;
  const n = Number(val);
  return Number.isNaN(n) || n === 0 ? undefined : n;
}

/** Close the fd even if the upload API throws before consuming the stream. */
async function withFileReadStream<T>(
  filePath: string,
  use: (stream: fs.ReadStream) => Promise<T>,
): Promise<T> {
  const stream = fs.createReadStream(filePath);
  try {
    return await use(stream);
  } finally {
    stream.destroy();
  }
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
