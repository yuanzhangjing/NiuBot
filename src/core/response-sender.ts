import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../logger.js";
import { hasFeishuAtTag } from "../im/mentions.js";
import { isDeliveryUncertainError } from "../transport/errors.js";
import type { DeliveryOptions, TransportClient } from "../transport/types.js";
import { TimeoutError, withTimeout } from "./timeout.js";

const log = createLogger("response-sender");

export type SendResult =
  | { ok: true; platformMsgId: string; method: "card" | "text" | "file"; deliveredContent: string }
  | { ok: false; error: string; methodsTried: string[]; uncertain?: boolean };

type ResponseSenderOptions = {
  timeoutMs?: number;
  tempDir?: string;
};

type SendFinalResponseOptions = {
  chatId: string;
  header: string;
  content: string;
  footer?: string;
  replyToMsgId?: string;
  replyInThread?: boolean;
  /** false 时禁止 create，只处理 reply；必须有 replyToMsgId。 */
  allowChatFallback?: boolean;
  signal?: AbortSignal;
  /** 跳过卡片，直接走文本。 */
  preferText?: boolean;
  /** 卡片发送失败后的文本降级内容（默认 = content）；可传函数按卡片失败原因动态构建（如「发送失败：<原因>」提示） */
  textFallback?: string | ((error: unknown) => string);
};

export class ResponseSender {
  private readonly timeoutMs: number;
  private readonly tempDir: string;

  constructor(private readonly transport: TransportClient, options: ResponseSenderOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.tempDir = options.tempDir ?? os.tmpdir();
  }

  sendText(chatId: string, text: string, signal?: AbortSignal): Promise<string> {
    return this.sendWithTelemetry("im.sendText", chatId, {
      contentLength: text.length,
    }, () => this.runDelivery("im.sendText", signal, (deliveryOptions) =>
      this.transport.sendText(chatId, text, deliveryOptions)));
  }

  sendReply(
    chatId: string,
    text: string,
    replyToMsgId: string,
    signal?: AbortSignal,
    replyInThread?: boolean,
  ): Promise<string> {
    return this.sendWithTelemetry("im.sendReply", chatId, {
      hasReply: true,
      contentLength: text.length,
    }, () => this.runDelivery("im.sendReply", signal, (deliveryOptions) =>
      this.transport.sendReply(chatId, text, replyToMsgId, {
        ...deliveryOptions,
        replyInThread,
      })));
  }

  sendCard(
    chatId: string,
    header: string,
    content: string,
    footer?: string,
    replyToMsgId?: string,
    signal?: AbortSignal,
    replyInThread?: boolean,
  ): Promise<string> {
    return this.sendWithTelemetry("im.sendCard", chatId, {
      hasReply: !!replyToMsgId,
      contentLength: content.length,
    }, () => this.runDelivery("im.sendCard", signal, (deliveryOptions) =>
      this.transport.sendCard(chatId, header, content, footer, replyToMsgId, {
        ...deliveryOptions,
        replyInThread,
      })));
  }

  sendFile(
    chatId: string,
    filePath: string,
    fileName?: string,
    signal?: AbortSignal,
    replyToMsgId?: string,
    replyInThread?: boolean,
  ): Promise<string> {
    return this.sendWithTelemetry("im.sendFile", chatId, {
      fileName: fileName ?? path.basename(filePath),
      hasReply: !!replyToMsgId,
    }, () => this.runDelivery("im.sendFile", signal, (deliveryOptions) =>
      this.transport.sendFile(chatId, filePath, fileName, {
        ...deliveryOptions,
        replyToMsgId,
        replyInThread,
      })));
  }

  addReaction(chatId: string, msgId: string, emoji: string, signal?: AbortSignal): Promise<void> {
    return withTimeout({
      label: "im.addReaction",
      timeoutMs: this.timeoutMs,
      signal,
      fn: (operationSignal) => this.transport.addReaction(chatId, msgId, emoji, { signal: operationSignal }),
    });
  }

  removeReaction(chatId: string, msgId: string, emoji: string, signal?: AbortSignal): Promise<void> {
    return withTimeout({
      label: "im.removeReaction",
      timeoutMs: this.timeoutMs,
      signal,
      fn: (operationSignal) => this.transport.removeReaction(chatId, msgId, emoji, { signal: operationSignal }),
    });
  }

  async sendFinalResponse(options: SendFinalResponseOptions): Promise<SendResult> {
    const methodsTried: string[] = [];
    let lastError: unknown;
    let uncertain = false;
    const allowChatFallback = options.allowChatFallback !== false;
    if (!allowChatFallback && !options.replyToMsgId) {
      return {
        ok: false,
        error: "No reply anchor available; create fallback is disabled",
        methodsTried,
      };
    }

    const trySend = async (
      methodLabel: string,
      method: "card" | "text" | "file",
      send: () => Promise<string>,
      deliveredContent: string,
    ): Promise<SendResult | undefined> => {
      methodsTried.push(methodLabel);
      log.info("send attempt", {
        method: methodLabel,
        chatId: options.chatId,
        hasReply: !!options.replyToMsgId,
        contentLength: options.content.length,
        timeoutMs: this.timeoutMs,
      });
      try {
        const platformMsgId = await send();
        log.info("send succeeded", {
          method: methodLabel,
          chatId: options.chatId,
          platformMsgId,
        });
        return { ok: true, platformMsgId, method, deliveredContent };
      } catch (err) {
        lastError = err;
        uncertain = isUncertainDelivery(err);
        log.warn("send failed", {
          method: methodLabel,
          chatId: options.chatId,
          error: errorMessage(err),
          uncertain,
        });
        return undefined;
      }
    };

    const uncertainResult = (): SendResult => ({
      ok: false,
      error: errorMessage(lastError),
      methodsTried,
      uncertain: true,
    });

    // 文本降级内容在降级发生时解析（此时 lastError 为卡片失败原因，可动态构建提示）
    const resolveFallbackText = (): string => typeof options.textFallback === "function"
      ? options.textFallback(lastError)
      : (options.textFallback ?? options.content);

    if (!options.preferText) {
      if (options.replyToMsgId) {
        const replyCard = await trySend("card:reply", "card", () =>
          this.sendCard(
            options.chatId,
            options.header,
            options.content,
            options.footer,
            options.replyToMsgId,
            options.signal,
            options.replyInThread,
          ),
          options.content);
        if (replyCard) return replyCard;
        if (uncertain) return uncertainResult();
      }

      if (allowChatFallback) {
        const createCard = await trySend("card:create", "card", () =>
          this.sendCard(options.chatId, options.header, options.content, options.footer, undefined, options.signal),
          options.content);
        if (createCard) return createCard;
        if (uncertain) return uncertainResult();
      }
    }

    // 带飞书 at 时正文必须原样走文本降级，不能换成「发送失败」提示，否则对方 Bot 收不到。
    const keepAtPayload = options.preferText || hasFeishuAtTag(options.content);
    const textBody = keepAtPayload ? options.content : resolveFallbackText();

    if (options.replyToMsgId) {
      const replyText = await trySend("text:reply", "text", () =>
        this.sendReply(
          options.chatId,
          textBody,
          options.replyToMsgId!,
          options.signal,
          options.replyInThread,
        ),
        textBody);
      if (replyText) return replyText;
      if (uncertain) return uncertainResult();
    }

    if (allowChatFallback) {
      const createText = await trySend("text:create", "text", () =>
        this.sendText(options.chatId, textBody, options.signal),
        textBody);
      if (createText) return createText;
      if (uncertain) return uncertainResult();
    }

    // 带 at 或主动要求纯文本时不要再降成文件（文件里的 at 叫不醒对方）。
    if (keepAtPayload) {
      return {
        ok: false,
        error: errorMessage(lastError),
        methodsTried,
      };
    }

    if (options.replyToMsgId) {
      const replyFile = await trySend("file:reply", "file", () =>
        this.sendResponseFile(
          options.chatId,
          options.content,
          options.footer,
          options.signal,
          options.replyToMsgId,
          options.replyInThread,
        ),
        options.content);
      if (replyFile) return replyFile;
      if (uncertain) return uncertainResult();
    }
    if (allowChatFallback) {
      const createFile = await trySend("file:create", "file", () =>
        this.sendResponseFile(options.chatId, options.content, options.footer, options.signal),
        // deliveredContent 只回写正文（不带 footer 拼装产物，避免污染历史/FTS）
        options.content);
      if (createFile) return createFile;
      if (uncertain) return uncertainResult();
    }

    return {
      ok: false,
      error: errorMessage(lastError),
      methodsTried,
    };
  }

  private async sendResponseFile(
    chatId: string,
    content: string,
    footer?: string,
    signal?: AbortSignal,
    replyToMsgId?: string,
    replyInThread?: boolean,
  ): Promise<string> {
    const dir = mkdtempSync(path.join(this.tempDir, "niubot-response-"));
    const filePath = path.join(dir, "reply.md");
    const fileContent = footer ? `${content}\n\n---\n${footer}` : content;
    writeFileSync(filePath, fileContent, "utf-8");
    try {
      return await this.sendFile(chatId, filePath, "reply.md", signal, replyToMsgId, replyInThread);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private async sendWithTelemetry(
    method: string,
    chatId: string,
    data: Record<string, unknown>,
    send: () => Promise<string>,
  ): Promise<string> {
    const startedAt = Date.now();
    log.info("send started", {
      method,
      chatId,
      ...data,
      timeoutMs: this.timeoutMs,
    });
    try {
      const platformMsgId = await send();
      log.info("send succeeded", {
        method,
        chatId,
        platformMsgId,
        durationMs: Date.now() - startedAt,
      });
      return platformMsgId;
    } catch (err) {
      log.warn("send failed", {
        method,
        chatId,
        error: errorMessage(err),
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  private runDelivery<T>(
    label: string,
    signal: AbortSignal | undefined,
    send: (options: DeliveryOptions) => Promise<T>,
  ): Promise<T> {
    if (this.transport.managedDelivery) {
      return send({ timeoutMs: this.timeoutMs, signal });
    }
    return withTimeout({
      label,
      timeoutMs: this.timeoutMs,
      signal,
      fn: (operationSignal) => send({ signal: operationSignal }),
    });
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isUncertainDelivery(error: unknown): boolean {
  return isDeliveryUncertainError(error) || error instanceof TimeoutError;
}
