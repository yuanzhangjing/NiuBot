import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PlatformAdapter } from "../im/types.js";
import { withTimeout } from "./timeout.js";

export type SendResult =
  | { ok: true; platformMsgId: string; method: "card" | "text" | "file" }
  | { ok: false; error: string; methodsTried: string[] };

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

  constructor(private readonly im: PlatformAdapter, options: ResponseSenderOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.tempDir = options.tempDir ?? os.tmpdir();
  }

  sendText(chatId: string, text: string, signal?: AbortSignal): Promise<string> {
    return withTimeout({
      label: "im.sendText",
      timeoutMs: this.timeoutMs,
      signal,
      fn: () => this.im.sendText(chatId, text),
    });
  }

  sendReply(chatId: string, text: string, replyToMsgId: string, signal?: AbortSignal): Promise<string> {
    return withTimeout({
      label: "im.sendReply",
      timeoutMs: this.timeoutMs,
      signal,
      fn: () => this.im.sendReply(chatId, text, replyToMsgId),
    });
  }

  sendCard(
    chatId: string,
    header: string,
    content: string,
    footer?: string,
    replyToMsgId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return withTimeout({
      label: "im.sendCard",
      timeoutMs: this.timeoutMs,
      signal,
      fn: () => this.im.sendCard(chatId, header, content, footer, replyToMsgId),
    });
  }

  sendFile(chatId: string, filePath: string, fileName?: string, signal?: AbortSignal): Promise<string> {
    return withTimeout({
      label: "im.sendFile",
      timeoutMs: this.timeoutMs,
      signal,
      fn: () => this.im.sendFile(chatId, filePath, fileName),
    });
  }

  addReaction(chatId: string, msgId: string, emoji: string, signal?: AbortSignal): Promise<void> {
    return withTimeout({
      label: "im.addReaction",
      timeoutMs: this.timeoutMs,
      signal,
      fn: () => this.im.addReaction(chatId, msgId, emoji),
    });
  }

  removeReaction(chatId: string, msgId: string, emoji: string, signal?: AbortSignal): Promise<void> {
    return withTimeout({
      label: "im.removeReaction",
      timeoutMs: this.timeoutMs,
      signal,
      fn: () => this.im.removeReaction(chatId, msgId, emoji),
    });
  }

  async sendFinalResponse(options: SendFinalResponseOptions): Promise<SendResult> {
    const methodsTried: string[] = [];
    let lastError: unknown;

    const trySend = async (
      methodLabel: string,
      method: "card" | "text" | "file",
      send: () => Promise<string>,
    ): Promise<SendResult | undefined> => {
      methodsTried.push(methodLabel);
      try {
        const platformMsgId = await send();
        return { ok: true, platformMsgId, method };
      } catch (err) {
        lastError = err;
        return undefined;
      }
    };

    if (options.replyToMsgId) {
      const replyCard = await trySend("card:reply", "card", () =>
        this.sendCard(options.chatId, options.header, options.content, options.footer, options.replyToMsgId, options.signal));
      if (replyCard) return replyCard;
    }

    const createCard = await trySend("card:create", "card", () =>
      this.sendCard(options.chatId, options.header, options.content, options.footer, undefined, options.signal));
    if (createCard) return createCard;

    if (options.replyToMsgId) {
      const replyText = await trySend("text:reply", "text", () =>
        this.sendReply(options.chatId, options.content, options.replyToMsgId!, options.signal));
      if (replyText) return replyText;
    }

    const createText = await trySend("text:create", "text", () =>
      this.sendText(options.chatId, options.content, options.signal));
    if (createText) return createText;

    const createFile = await trySend("file:create", "file", () =>
      this.sendResponseFile(options.chatId, options.content, options.footer, options.signal));
    if (createFile) return createFile;

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
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
