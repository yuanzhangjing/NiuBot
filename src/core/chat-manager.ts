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
      const userMessages = messages.filter((m) => !m.triggerKind || m.triggerKind === "user");
      const run = this.runtimeState.createRun({
        chatId,
        triggerMessageIds: userMessages.map((m) => m.dbMsgId).filter((id): id is number => id != null),
        triggerPlatformMsgIds: userMessages.map((m) => m.platformMsgId).filter((id): id is string => !!id),
        replyToPlatformMsgId: userMessages.at(-1)?.platformMsgId,
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

  /**
   * 入队 Worker Continuation（内部事件，不是用户发言）。
   * 与用户消息走同一队列，保证单 chat 串行；Continuation 只携带 ID，
   * 具体结果由 Pipeline 处理时从 JobService 查询。
   */
  enqueueContinuation(chatId: string, continuationIds: string[]): boolean {
    const msg: QueuedMessage = {
      chatId,
      text: `[worker continuation: ${continuationIds.join(",")}]`,
      timestamp: Date.now(),
      triggerKind: "worker_continuation",
      continuationIds,
    };
    const pending = this.queue.push(msg);
    log.info("worker continuation enqueued", {
      chatId,
      continuationIds,
      pending,
      queueState: this.runtimeState.getChatState(chatId).state,
    });
    return pending;
  }

  /** 队列是否已停止（关闭期间不再接受新任务）。 */
  isStopped(): boolean {
    return this.queue.isStopped();
  }

  /** 入队一个 Session 续接 Loop；任务内容由 Pipeline 处理时从 DB 读取。 */
  enqueueLoop(chatId: string, loopJobId: number): boolean {
    if (this.queue.isStopped()) {
      throw new Error("message queue is stopped");
    }
    const msg: QueuedMessage = {
      chatId,
      text: `[loop continuation: ${loopJobId}]`,
      timestamp: Date.now(),
      triggerKind: "loop_continuation",
      loopJobId,
    };
    const pending = this.queue.push(msg);
    log.info("loop continuation enqueued", {
      chatId,
      loopJobId,
      pending,
      queueState: this.runtimeState.getChatState(chatId).state,
    });
    return pending;
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
