import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../logger.js";
import { isDeliveryUncertainError } from "../transport/errors.js";
import type { DeliveryOptions, TransportClient } from "../transport/types.js";
import { TimeoutError, withTimeout } from "./timeout.js";

const log = createLogger("response-sender");

export type SendResult =
  | { ok: true; platformMsgId: string; method: "card" | "text" | "file" }
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
  signal?: AbortSignal;
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

  sendReply(chatId: string, text: string, replyToMsgId: string, signal?: AbortSignal): Promise<string> {
    return this.sendWithTelemetry("im.sendReply", chatId, {
      hasReply: true,
      contentLength: text.length,
    }, () => this.runDelivery("im.sendReply", signal, (deliveryOptions) =>
      this.transport.sendReply(chatId, text, replyToMsgId, deliveryOptions)));
  }

  sendCard(
    chatId: string,
    header: string,
    content: string,
    footer?: string,
    replyToMsgId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.sendWithTelemetry("im.sendCard", chatId, {
      hasReply: !!replyToMsgId,
      contentLength: content.length,
    }, () => this.runDelivery("im.sendCard", signal, (deliveryOptions) =>
      this.transport.sendCard(chatId, header, content, footer, replyToMsgId, deliveryOptions)));
  }

  sendFile(chatId: string, filePath: string, fileName?: string, signal?: AbortSignal): Promise<string> {
    return this.sendWithTelemetry("im.sendFile", chatId, {
      fileName: fileName ?? path.basename(filePath),
    }, () => this.runDelivery("im.sendFile", signal, (deliveryOptions) =>
      this.transport.sendFile(chatId, filePath, fileName, deliveryOptions)));
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

    const trySend = async (
      methodLabel: string,
      method: "card" | "text" | "file",
      send: () => Promise<string>,
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
        return { ok: true, platformMsgId, method };
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

    if (options.replyToMsgId) {
      const replyCard = await trySend("card:reply", "card", () =>
        this.sendCard(options.chatId, options.header, options.content, options.footer, options.replyToMsgId, options.signal));
      if (replyCard) return replyCard;
      if (uncertain) return uncertainResult();
    }

    const createCard = await trySend("card:create", "card", () =>
      this.sendCard(options.chatId, options.header, options.content, options.footer, undefined, options.signal));
    if (createCard) return createCard;
    if (uncertain) return uncertainResult();

    if (options.replyToMsgId) {
      const replyText = await trySend("text:reply", "text", () =>
        this.sendReply(options.chatId, options.content, options.replyToMsgId!, options.signal));
      if (replyText) return replyText;
      if (uncertain) return uncertainResult();
    }

    const createText = await trySend("text:create", "text", () =>
      this.sendText(options.chatId, options.content, options.signal));
    if (createText) return createText;
    if (uncertain) return uncertainResult();

    const createFile = await trySend("file:create", "file", () =>
      this.sendResponseFile(options.chatId, options.content, options.footer, options.signal));
    if (createFile) return createFile;
    if (uncertain) return uncertainResult();

    return {
      ok: false,
      error: errorMessage(lastError),
      methodsTried,
    };
  }

  private async sendResponseFile(chatId: string, content: string, footer?: string, signal?: AbortSignal): Promise<string> {
    const dir = mkdtempSync(path.join(this.tempDir, "niubot-response-"));
    const filePath = path.join(dir, "reply.md");
    const fileContent = footer ? `${content}\n\n---\n${footer}` : content;
    writeFileSync(filePath, fileContent, "utf-8");
    try {
      return await this.sendFile(chatId, filePath, "reply.md", signal);
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
