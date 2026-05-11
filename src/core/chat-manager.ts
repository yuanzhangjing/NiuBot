import { MessageQueue, type QueuedMessage, type QueueSnapshot } from "./queue.js";
import { RuntimeStateStore } from "./runtime-state.js";

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
      return this.processFn?.(run.runId, chatId, mergedText, messages, signal) ?? Promise.resolve();
    });
  }

  onProcess(fn: ChatProcessFn): void {
    this.processFn = fn;
  }

  onPending(fn: (msg: QueuedMessage) => void): void {
    this.queue.onPending(fn);
  }

  enqueue(msg: QueuedMessage): boolean {
    return this.queue.push(msg);
  }

  push(msg: QueuedMessage): boolean {
    return this.enqueue(msg);
  }

  stop(): void {
    this.queue.stop();
  }

  stopChat(chatId: string): number {
    const activeRun = this.runtimeState.getActiveRun(chatId);
    if (activeRun) {
      this.markActiveRunStopped(activeRun.runId);
      this.queue.cancel(chatId);
    }
    return this.queue.drain(chatId);
  }

  flushChat(chatId: string): number {
    const pending = this.pendingCount(chatId);
    const activeRun = this.runtimeState.getActiveRun(chatId);
    if (pending > 0 && activeRun) {
      this.markActiveRunStopped(activeRun.runId);
      this.queue.cancel(chatId);
    }
    return pending;
  }

  drain(chatId: string): number {
    return this.queue.drain(chatId);
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
    return this.queue.cancel(chatId);
  }

  getState(chatId: string) {
    return this.runtimeState.getChatState(chatId);
  }

  private syncRuntimeQueueState(chatId: string, snapshot: QueueSnapshot): void {
    this.runtimeState.updateChatBuffer(
      chatId,
      snapshot.buffer.map((message) => message.dbMsgId).filter((id): id is number => id != null),
    );
  }

  private markActiveRunStopped(runId: string): void {
    const run = this.runtimeState.getRun(runId);
    if (!run || run.stage === "done" || run.stage === "failed" || run.stage === "stopped") {
      return;
    }
    this.runtimeState.markRunStage(runId, "stopped");
  }
}
