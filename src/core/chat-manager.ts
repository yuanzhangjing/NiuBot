import { MessageQueue, type QueuedMessage, type QueueSnapshot } from "./queue.js";
import { createLogger } from "../logger.js";
import { RuntimeStateStore } from "./runtime-state.js";

const log = createLogger("chat-manager");

type ChatProcessFn = (
  runId: string,
  chatId: string,
  mergedText: string,
  messages: QueuedMessage[],
  signal: AbortSignal,
) => Promise<void>;

export class ChatManager {
  private readonly queue: MessageQueue;
  private readonly runtimeState: RuntimeStateStore;
  private processFn: ChatProcessFn | null = null;

  constructor(bufferMs: number, runtimeState: RuntimeStateStore) {
    this.runtimeState = runtimeState;
    this.queue = new MessageQueue(bufferMs);
    this.queue.onStateChange((chatId, snapshot) => this.syncRuntimeQueueState(chatId, snapshot));
    this.queue.onProcess((chatId, mergedText, messages, signal) => {
      const run = this.runtimeState.createRun({
        chatId,
        triggerMessageIds: messages.map((m) => m.dbMsgId).filter((id): id is number => id != null),
        triggerPlatformMsgIds: messages.map((m) => m.platformMsgId).filter((id): id is string => !!id),
        replyToPlatformMsgId: messages.at(-1)?.platformMsgId,
        mergedText,
      });
      log.info("run created", {
        runId: run.runId,
        chatId,
        messageCount: messages.length,
        messageIds: run.triggerMessageIds,
        platformMsgIds: run.triggerPlatformMsgIds,
        replyToPlatformMsgId: run.replyToPlatformMsgId ?? null,
        mergedTextLength: mergedText.length,
        pendingCount: this.queue.pendingCount(chatId),
      });
      return this.processFn?.(run.runId, chatId, mergedText, messages, signal) ?? Promise.resolve();
    });
  }

  onProcess(fn: ChatProcessFn): void {
    this.processFn = fn;
  }

  onPending(fn: (msg: QueuedMessage) => void): void {
    this.queue.onPending(fn);
  }

  onDiscard(fn: (messages: QueuedMessage[]) => void): void {
    this.queue.onDiscard(fn);
  }

  enqueue(msg: QueuedMessage): boolean {
    const pending = this.queue.push(msg);
    const state = this.runtimeState.getChatState(msg.chatId);
    log.info("message enqueued", {
      chatId: msg.chatId,
      dbMsgId: msg.dbMsgId ?? null,
      platformMsgId: msg.platformMsgId ?? null,
      textLength: msg.text.length,
      pending,
      state: state.state,
      activeRunId: state.activeRunId,
      bufferCount: state.bufferMessageIds.length,
      pendingCount: this.queue.pendingCount(msg.chatId),
    });
    return pending;
  }

  push(msg: QueuedMessage): boolean {
    return this.enqueue(msg);
  }

  stop(): void {
    this.queue.stop();
  }

  stopChat(chatId: string): number {
    const activeRun = this.runtimeState.getActiveRun(chatId);
    const pendingBefore = this.pendingCount(chatId);
    if (activeRun) {
      this.markActiveRunStopped(activeRun.runId);
      this.queue.cancel(chatId);
    }
    const dropped = this.queue.drain(chatId);
    log.info("stop chat requested", {
      chatId,
      activeRunId: activeRun?.runId ?? null,
      pendingBefore,
      dropped,
    });
    return dropped;
  }

  flushChat(chatId: string): number {
    const pending = this.pendingCount(chatId);
    const activeRun = this.runtimeState.getActiveRun(chatId);
    if (pending > 0 && activeRun) {
      this.markActiveRunStopped(activeRun.runId);
      this.queue.cancel(chatId);
    }
    log.info("flush chat requested", {
      chatId,
      activeRunId: activeRun?.runId ?? null,
      pendingBefore: pending,
      stoppedActiveRun: !!(pending > 0 && activeRun),
    });
    return pending;
  }

  drain(chatId: string): number {
    const dropped = this.queue.drain(chatId);
    log.info("drain chat requested", { chatId, dropped });
    return dropped;
  }

  pendingCount(chatId: string): number {
    return this.queue.pendingCount(chatId);
  }

  hasBusyChats(): boolean {
    return this.queue.hasBusyChats();
  }

  isBusy(chatId: string): boolean {
    return this.queue.isBusy(chatId);
  }

  cancel(chatId: string): boolean {
    const cancelled = this.queue.cancel(chatId);
    log.info("cancel chat requested", {
      chatId,
      cancelled,
      activeRunId: this.runtimeState.getActiveRun(chatId)?.runId ?? null,
      pendingCount: this.pendingCount(chatId),
    });
    return cancelled;
  }

  getState(chatId: string) {
    return this.runtimeState.getChatState(chatId);
  }

  private syncRuntimeQueueState(chatId: string, snapshot: QueueSnapshot): void {
    this.runtimeState.updateChatBuffer(
      chatId,
      snapshot.buffer.map((message) => message.dbMsgId).filter((id): id is number => id != null),
    );
    log.debug("queue state synced", {
      chatId,
      bufferCount: snapshot.buffer.length,
      pendingCount: snapshot.pending.length,
      busy: snapshot.busy,
      bufferMessageIds: snapshot.buffer.map((message) => message.dbMsgId).filter((id): id is number => id != null),
      pendingMessageIds: snapshot.pending.map((message) => message.dbMsgId).filter((id): id is number => id != null),
    });
  }

  private markActiveRunStopped(runId: string): void {
    const run = this.runtimeState.getRun(runId);
    if (!run || run.stage === "done" || run.stage === "failed" || run.stage === "stopped") {
      return;
    }
    this.runtimeState.markRunStage(runId, "stopped");
  }
}
