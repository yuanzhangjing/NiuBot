import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { PlatformAdapter } from "../im/types.js";
import { createLogger } from "../logger.js";
import { DeliveryUncertainError } from "./errors.js";
import {
  TransportStore,
  type InboundRow,
  type OutboundRow,
  type TransportStatusCounts,
} from "./store.js";
import type {
  DeliveryOptions,
  InboundHandler,
  InboundTerminalStatus,
  NormalizedMessage,
  OutboundRequest,
  TransportClient,
} from "./types.js";

const DEFAULT_DELIVERY_TIMEOUT_MS = 30_000;

type PersistentTransportOptions = {
  db: Database.Database;
  botId: string;
  platform: string;
  adapter: PlatformAdapter;
  storageDir: string;
  deliveryTimeoutMs?: number;
};

type DeliveryResult = string | undefined;

export class PersistentTransport implements TransportClient {
  readonly managedDelivery = true;

  private readonly store: TransportStore;
  private readonly adapter: PlatformAdapter;
  private readonly botId: string;
  private readonly platform: string;
  private readonly managedFileRoot: string;
  private readonly deliveryTimeoutMs: number;
  private readonly log: ReturnType<typeof createLogger>;
  private inboundHandler?: InboundHandler;

  constructor(options: PersistentTransportOptions) {
    this.adapter = options.adapter;
    this.botId = options.botId;
    this.platform = options.platform;
    this.managedFileRoot = path.join(options.storageDir, "transport-outbox");
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
    this.store = new TransportStore(options.db, options.botId, options.platform);
    this.log = createLogger("transport", options.botId);
    this.adapter.onMessage((message) => this.receive(message));
  }

  onInbound(handler: InboundHandler): void {
    this.inboundHandler = handler;
  }

  async start(): Promise<void> {
    await this.adapter.start();
  }

  async stop(): Promise<void> {
    await this.adapter.stop();
  }

  async recover(): Promise<void> {
    const outbound = this.store.prepareOutboundRecovery();
    const inbound = this.store.prepareInboundRecovery();
    this.log.info("transport recovery prepared", {
      pendingInbound: inbound.pending.length,
      requeuedInbound: inbound.requeued,
      interruptedInbound: inbound.interrupted,
      pendingOutbound: outbound.pending.length,
      unknownOutbound: outbound.unknown,
    });

    for (const row of outbound.pending) {
      try {
        await this.deliverPersisted(row, {});
      } catch (error) {
        this.log.warn("outbox recovery delivery failed", {
          requestId: row.requestId,
          kind: row.kind,
          error: errorMessage(error),
        });
      }
    }
    for (const row of inbound.pending) {
      await this.dispatchInbound(row, true);
    }
  }

  getStatusCounts(): TransportStatusCounts {
    return this.store.getStatusCounts();
  }

  markInboundQueued(inboxId: number, messageId: number): void {
    if (!this.store.markInboundQueued(inboxId, messageId)) {
      this.log.warn("inbox queued transition ignored", { inboxId, messageId });
    }
  }

  markInboundTerminal(inboxId: number, status: InboundTerminalStatus, error?: string): void {
    if (!this.store.markInboundTerminal(inboxId, status, error)) {
      this.log.warn("inbox terminal transition ignored", { inboxId, status });
    }
  }

  markInboundRunState(messageIds: number[], runId: string, stage: string, error?: string): void {
    const changed = this.store.markInboundRunState(messageIds, runId, stage, error);
    if (messageIds.length > 0 && changed === 0 && stage !== "sending_response") {
      this.log.debug("inbox run transition matched no rows", { runId, stage, messageCount: messageIds.length });
    }
  }

  discardInboundMessages(messageIds: number[]): void {
    const changed = this.store.discardInboundMessages(messageIds);
    this.log.info("inbox messages discarded", { messageCount: messageIds.length, changed });
  }

  sendText(chatId: string, text: string, options?: DeliveryOptions): Promise<string> {
    return this.enqueueOutbound({ kind: "text", chatId, text }, options) as Promise<string>;
  }

  sendReply(chatId: string, text: string, replyToMsgId: string, options?: DeliveryOptions): Promise<string> {
    return this.enqueueOutbound({ kind: "reply", chatId, text, replyToMsgId }, options) as Promise<string>;
  }

  sendMarkdownCard(chatId: string, markdown: string, options?: DeliveryOptions): Promise<string> {
    return this.enqueueOutbound({ kind: "markdown_card", chatId, markdown }, options) as Promise<string>;
  }

  sendCard(
    chatId: string,
    header: string,
    content: string,
    footer?: string,
    replyToMsgId?: string,
    options?: DeliveryOptions,
  ): Promise<string> {
    return this.enqueueOutbound({ kind: "card", chatId, header, content, footer, replyToMsgId }, options) as Promise<string>;
  }

  async sendFile(chatId: string, filePath: string, fileName?: string, options?: DeliveryOptions): Promise<string> {
    const requestId = randomUUID();
    const managedPath = await this.copyManagedFile(requestId, filePath, fileName);
    const request: OutboundRequest = {
      kind: "file",
      chatId,
      filePath: managedPath,
      fileName: fileName ?? path.basename(filePath),
    };
    try {
      return await this.enqueueOutbound(request, options, requestId) as string;
    } catch (error) {
      if (!this.store.getOutbound(requestId)) await this.cleanupManagedFile(request);
      throw error;
    }
  }

  async editMessage(msgId: string, text: string, options?: DeliveryOptions): Promise<void> {
    await this.enqueueOutbound({ kind: "edit", msgId, text }, options);
  }

  addReaction(chatId: string, msgId: string, emoji: string, options?: DeliveryOptions): Promise<void> {
    return this.adapter.addReaction(chatId, msgId, emoji, options);
  }

  removeReaction(chatId: string, msgId: string, emoji: string, options?: DeliveryOptions): Promise<void> {
    return this.adapter.removeReaction(chatId, msgId, emoji, options);
  }

  getBotOpenId(): Promise<string> {
    return this.adapter.getBotOpenId();
  }

  getBotName(): Promise<string | undefined> {
    return this.adapter.getBotName();
  }

  getChatName(chatId: string): Promise<string | undefined> {
    return this.adapter.getChatName(chatId);
  }

  getMessageContent(msgId: string): Promise<string | undefined> {
    return this.adapter.getMessageContent(msgId);
  }

  getAppCreatorId(): Promise<string | undefined> {
    return this.adapter.getAppCreatorId();
  }

  private async receive(message: NormalizedMessage): Promise<void> {
    const platformMsgId = message.platformMsgId ?? `local:${randomUUID()}`;
    const persisted = this.store.insertInbound(platformMsgId, serializeInbound(message));
    if (!persisted.inserted) {
      this.log.info("duplicate inbound message skipped", {
        inboxId: persisted.row.id,
        platformMsgId,
        status: persisted.row.status,
      });
      return;
    }
    await this.dispatchInbound(persisted.row, false);
  }

  private async dispatchInbound(row: InboundRow, replayed: boolean): Promise<void> {
    if (!this.inboundHandler) {
      this.log.warn("inbound message persisted without handler", { inboxId: row.id, replayed });
      return;
    }
    if (!this.store.markInboundAttempt(row.id)) return;
    try {
      await this.inboundHandler({
        inboxId: row.id,
        message: deserializeInbound(row.payloadJson),
        replayed,
      });
    } catch (error) {
      this.store.markInboundHandlerError(row.id, error);
      this.log.error("inbound handler failed", {
        inboxId: row.id,
        replayed,
        error: errorMessage(error),
      });
    }
  }

  private async enqueueOutbound(
    request: OutboundRequest,
    options: DeliveryOptions = {},
    requestId = randomUUID(),
  ): Promise<DeliveryResult> {
    const row = this.store.insertOutbound(requestId, request, JSON.stringify(request));
    return this.deliverPersisted(row, options);
  }

  private async deliverPersisted(row: OutboundRow, options: DeliveryOptions): Promise<DeliveryResult> {
    if (!this.store.markOutboundSending(row.requestId)) {
      throw new Error(`Outbox request is not pending: ${row.requestId}`);
    }
    let request: OutboundRequest;
    try {
      request = parseOutbound(row.payloadJson);
    } catch (error) {
      this.store.markOutboundFailed(row.requestId, error);
      throw error;
    }
    if (options.signal?.aborted) {
      const error = options.signal.reason ?? new Error("Delivery aborted before platform call");
      this.store.markOutboundFailed(row.requestId, error);
      await this.cleanupManagedFile(request);
      throw error;
    }

    const operation = Promise.resolve().then(() => this.callAdapter(request));
    try {
      const result = await raceDelivery(operation, {
        timeoutMs: options.timeoutMs ?? this.deliveryTimeoutMs,
        signal: options.signal,
      });
      this.store.markOutboundSent(row.requestId, result);
      await this.cleanupManagedFile(request);
      this.log.info("outbox delivery sent", { requestId: row.requestId, kind: row.kind, hasPlatformMsgId: !!result });
      return result;
    } catch (error) {
      if (isUncertainFailure(error)) {
        this.store.markOutboundUnknown(row.requestId, error);
        this.observeLateDelivery(row, request, operation);
        this.log.warn("outbox delivery result unknown", {
          requestId: row.requestId,
          kind: row.kind,
          error: errorMessage(error),
        });
        throw new DeliveryUncertainError(
          row.requestId,
          `Delivery result is unknown for request ${row.requestId}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      this.store.markOutboundFailed(row.requestId, error);
      await this.cleanupManagedFile(request);
      this.log.warn("outbox delivery failed", { requestId: row.requestId, kind: row.kind, error: errorMessage(error) });
      throw error;
    }
  }

  private callAdapter(request: OutboundRequest): Promise<DeliveryResult> {
    switch (request.kind) {
      case "text":
        return this.adapter.sendText(request.chatId, request.text);
      case "reply":
        return this.adapter.sendReply(request.chatId, request.text, request.replyToMsgId);
      case "markdown_card":
        return this.adapter.sendMarkdownCard(request.chatId, request.markdown);
      case "card":
        return this.adapter.sendCard(
          request.chatId,
          request.header,
          request.content,
          request.footer,
          request.replyToMsgId,
        );
      case "file":
        return this.adapter.sendFile(request.chatId, request.filePath, request.fileName);
      case "edit":
        return this.adapter.editMessage(request.msgId, request.text).then(() => undefined);
    }
  }

  private observeLateDelivery(row: OutboundRow, request: OutboundRequest, operation: Promise<DeliveryResult>): void {
    void operation.then(async (platformMsgId) => {
      const changed = this.store.markOutboundSent(row.requestId, platformMsgId);
      if (changed) {
        await this.cleanupManagedFile(request);
        this.log.info("unknown outbox delivery later confirmed", {
          requestId: row.requestId,
          kind: row.kind,
          hasPlatformMsgId: !!platformMsgId,
        });
      }
    }).catch((error) => {
      this.log.warn("unknown outbox delivery later rejected", {
        requestId: row.requestId,
        kind: row.kind,
        error: errorMessage(error),
      });
    });
  }

  private async copyManagedFile(requestId: string, filePath: string, fileName?: string): Promise<string> {
    const dir = path.join(this.managedFileRoot, requestId);
    const safeName = sanitizeFileName(fileName ?? path.basename(filePath));
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, safeName);
    try {
      await copyFile(filePath, target);
      return target;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  private async cleanupManagedFile(request: OutboundRequest): Promise<void> {
    if (request.kind !== "file") return;
    const relative = path.relative(this.managedFileRoot, request.filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return;
    await rm(path.dirname(request.filePath), { recursive: true, force: true });
  }
}

function serializeInbound(message: NormalizedMessage): string {
  const { images: _images, raw, ...rest } = message;
  return JSON.stringify({
    ...rest,
    timestamp: message.timestamp.toISOString(),
    raw: jsonSafe(raw),
  });
}

function deserializeInbound(payloadJson: string): NormalizedMessage {
  const value = JSON.parse(payloadJson) as Omit<NormalizedMessage, "timestamp"> & { timestamp: string };
  const timestamp = new Date(value.timestamp);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("Invalid inbound timestamp");
  return { ...value, timestamp };
}

function parseOutbound(payloadJson: string): OutboundRequest {
  const value = JSON.parse(payloadJson) as OutboundRequest;
  if (!value || typeof value !== "object" || typeof value.kind !== "string") {
    throw new Error("Invalid outbox payload");
  }
  return value;
}

function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function sanitizeFileName(value: string): string {
  const safe = path.basename(value).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim();
  return safe || "attachment";
}

function isUncertainFailure(error: unknown): boolean {
  if (error instanceof DeliveryTimeoutError || error instanceof DeliveryAbortError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; response?: { status?: unknown } };
  if (typeof candidate.response?.status === "number") return false;
  return typeof candidate.code === "string" && [
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "ENETDOWN",
    "ENETUNREACH",
    "EHOSTUNREACH",
  ].includes(candidate.code);
}

class DeliveryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Delivery timed out after ${timeoutMs}ms`);
    this.name = "DeliveryTimeoutError";
  }
}

class DeliveryAbortError extends Error {
  constructor(options?: ErrorOptions) {
    super("Delivery aborted after platform call started", options);
    this.name = "DeliveryAbortError";
  }
}

async function raceDelivery<T>(
  operation: Promise<T>,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeliveryTimeoutError(options.timeoutMs)), options.timeoutMs);
  });
  const aborted = options.signal
    ? new Promise<never>((_, reject) => {
        abortHandler = () => reject(new DeliveryAbortError({ cause: options.signal?.reason }));
        options.signal!.addEventListener("abort", abortHandler, { once: true });
      })
    : undefined;
  try {
    return await Promise.race(aborted ? [operation, timeout, aborted] : [operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abortHandler && options.signal) options.signal.removeEventListener("abort", abortHandler);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
