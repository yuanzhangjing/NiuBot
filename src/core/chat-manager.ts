import { MessageQueue, type QueuedMessage, type QueueSnapshot } from "./queue.js";
import { createLogger } from "../logger.js";
import { RuntimeStateStore } from "./runtime-state.js";
import { parseScopeKey } from "./session-scope.js";
import { TopicConcurrencyLimiter } from "./topic-concurrency.js";

const log = createLogger("chat-manager");

type ChatProcessFn = (
  runId: string,
  chatId: string,
  mergedText: string,
  messages: QueuedMessage[],
  signal: AbortSignal,
  scopeKey?: string,
) => Promise<void>;

export class ChatManager {
  private readonly queue: MessageQueue;
  private readonly runtimeState: RuntimeStateStore;
  private readonly limiter: TopicConcurrencyLimiter;
  private processFn: ChatProcessFn | null = null;

  constructor(bufferMs: number, runtimeState: RuntimeStateStore) {
    this.runtimeState = runtimeState;
    this.limiter = new TopicConcurrencyLimiter();
    this.queue = new MessageQueue(bufferMs);
    this.queue.onStart((scopeKey) => {
      const parsed = parseScopeKey(scopeKey);
      if (scopeKey === parsed.chatId) return true;
      return this.limiter.tryAcquire(parsed.chatId, scopeKey);
    });
    this.queue.onFinish((scopeKey) => {
      const parsed = parseScopeKey(scopeKey);
      if (scopeKey === parsed.chatId) return [];
      return this.limiter.release(parsed.chatId, scopeKey);
    });
    this.queue.onStateChange((chatId, snapshot) => this.syncRuntimeQueueState(chatId, snapshot));
    this.queue.onProcess((scopeKey, mergedText, messages, signal) => {
      const chatId = messages[0]?.chatId ?? scopeKey;
      const userMessages = messages.filter((m) => !m.triggerKind || m.triggerKind === "user");
      const run = this.runtimeState.createRun({
        chatId,
        scopeKey,
        threadId: messages.at(-1)?.threadId,
        triggerMessageIds: userMessages.map((m) => m.dbMsgId).filter((id): id is number => id != null),
        triggerPlatformMsgIds: userMessages.map((m) => m.platformMsgId).filter((id): id is string => !!id),
        replyToPlatformMsgId: userMessages.at(-1)?.platformMsgId,
        mergedText,
      });
      log.info("run created", {
        runId: run.runId,
        chatId,
        scopeKey,
        messageCount: messages.length,
        messageIds: run.triggerMessageIds,
        platformMsgIds: run.triggerPlatformMsgIds,
        replyToPlatformMsgId: run.replyToPlatformMsgId ?? null,
        mergedTextLength: mergedText.length,
        pendingCount: this.queue.pendingCount(chatId),
      });
      return this.processFn?.(run.runId, chatId, mergedText, messages, signal, scopeKey) ?? Promise.resolve();
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

  onIdle(fn: (scopeKey: string) => void): void {
    this.queue.onIdle(fn);
  }

  enqueue(msg: QueuedMessage): boolean {
    const pending = this.queue.push(msg);
    const scopeKey = msg.scopeKey ?? msg.chatId;
    const state = this.runtimeState.getScopeState(scopeKey);
    log.info("message enqueued", {
      chatId: msg.chatId,
      scopeKey,
      dbMsgId: msg.dbMsgId ?? null,
      platformMsgId: msg.platformMsgId ?? null,
      textLength: msg.text.length,
      pending,
      state: state.state,
      activeRunId: state.activeRunId,
      bufferCount: state.bufferMessageIds.length,
      pendingCount: this.queue.pendingCount(scopeKey),
    });
    return pending;
  }

  push(msg: QueuedMessage): boolean {
    return this.enqueue(msg);
  }

  /** 队列是否已停止（关闭期间不再接受新任务）。 */
  isStopped(): boolean {
    return this.queue.isStopped();
  }

  /** 入队一个 Session 续接 Loop；任务内容由 Pipeline 处理时从 DB 读取。 */
  enqueueLoop(chatId: string, loopJobId: number, threadId?: string, replyToMsgId?: string): boolean {
    if (this.queue.isStopped()) {
      throw new Error("message queue is stopped");
    }
    const scopeKey = threadId ? `${chatId}#${threadId}` : chatId;
    const msg: QueuedMessage = {
      chatId,
      scopeKey,
      threadId,
      replyToMsgId,
      text: `[loop continuation: ${loopJobId}]`,
      timestamp: Date.now(),
      triggerKind: "loop_continuation",
      loopJobId,
    };
    const pending = this.queue.push(msg);
    log.info("loop continuation enqueued", {
      chatId,
      scopeKey,
      loopJobId,
      pending,
      queueState: this.runtimeState.getScopeState(scopeKey).state,
    });
    return pending;
  }

  stop(): void {
    this.queue.stop();
  }

  stopChat(chatId: string): number {
    const activeRun = this.runtimeState.getActiveRunForScope(chatId);
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
    const activeRun = this.runtimeState.getActiveRunForScope(chatId);
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

  drain(chatId: string, shouldDiscard?: (message: QueuedMessage) => boolean): number {
    const dropped = this.queue.drain(chatId, shouldDiscard);
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

  getLimiter(): TopicConcurrencyLimiter {
    return this.limiter;
  }

  getScopeKeys(): string[] {
    return this.queue.scopeKeys();
  }

  private syncRuntimeQueueState(scopeKey: string, snapshot: QueueSnapshot): void {
    this.runtimeState.updateScopeBuffer(
      scopeKey,
      snapshot.buffer.map((message) => message.dbMsgId).filter((id): id is number => id != null),
    );
    log.debug("queue state synced", {
      chatId: scopeKey,
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
