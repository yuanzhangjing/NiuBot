import { escapeYamlContent } from "../im/render.js";
import { createLogger } from "../logger.js";

const log = createLogger("queue");

export interface QueuedMessage {
  chatId: string;
  /** 队列键：非隔离时 === chatId；隔离时 c5#omt_aaa。 */
  scopeKey?: string;
  /** 飞书话题 ID（仅隔离时使用）。 */
  threadId?: string;
  /** 本轮要回复的 platform message ID（Loop/Cron/wake 等无当前用户消息时使用）。 */
  replyToMsgId?: string;
  /** 即使未隔离也必须禁止 create 新话题。 */
  strict?: boolean;
  text: string;
  timestamp: number;
  platformMsgId?: string;
  /** 发送者短标签（如 "U2"），用于多条消息合并时生成 YAML 格式 */
  senderLabel?: string;
  /** 发送者内部 ID，用于群聊 speaker 注入 */
  senderId?: string;
  /** 消息在 DB 中的 ID，用于 runtime 事件关联 */
  dbMsgId?: number;
  /** 触发来源：用户消息（默认）或内部续接事件 */
  triggerKind?: "user" | "loop_continuation" | "restart_wake";
  /** triggerKind 为 loop_continuation 时携带的 Loop Job ID（内部事件，不写库） */
  loopJobId?: number;
  /** 原始用户文本是否以 /loop 或 /cron 开头；回复渲染后仍保留调度意图。 */
  scheduleCommand?: boolean;
}

interface ChatQueue {
  /** 缓冲区：等待合并的消息 */
  buffer: QueuedMessage[];
  /** 缓冲计时器 */
  bufferTimer: ReturnType<typeof setTimeout> | null;
  /** 等待队列：agent 忙时排队的消息 */
  pending: QueuedMessage[];
  /** agent 是否正在处理 */
  busy: boolean;
  /** 当前 process 调用的取消控制器 */
  abortController: AbortController | null;
}

type ProcessFn = (scopeKey: string, mergedText: string, messages: QueuedMessage[], signal: AbortSignal) => Promise<void>;

export interface QueueSnapshot {
  buffer: QueuedMessage[];
  pending: QueuedMessage[];
  busy: boolean;
}

export class MessageQueue {
  private queues = new Map<string, ChatQueue>();
  private processFn: ProcessFn | null = null;
  private startFn: ((scopeKey: string) => boolean) | null = null;
  private finishFn: ((scopeKey: string) => string[]) | null = null;
  private idleFn: ((scopeKey: string) => void) | null = null;
  private bufferMs: number;
  private pendingFn: ((msg: QueuedMessage) => void) | null = null;
  private stateFn: ((chatId: string, snapshot: QueueSnapshot) => void) | null = null;
  private discardFn: ((messages: QueuedMessage[]) => void) | null = null;
  private stopped = false;

  constructor(bufferMs = 1500) {
    this.bufferMs = bufferMs;
  }

  /** 注册消息处理函数 */
  onProcess(fn: ProcessFn): void {
    this.processFn = fn;
  }

  /** 注册启动门禁；返回 false 时保持 buffer，不进入 busy。 */
  onStart(fn: (scopeKey: string) => boolean): void {
    this.startFn = fn;
  }

  /** 注册 process 结束回调；返回的 sibling scopeKey 将由队列立即尝试启动。 */
  onFinish(fn: (scopeKey: string) => string[]): void {
    this.finishFn = fn;
  }

  onIdle(fn: (scopeKey: string) => void): void {
    this.idleFn = fn;
  }

  /** 注册 pending 通知函数（消息进入等待队列时立即回调） */
  onPending(fn: (msg: QueuedMessage) => void): void {
    this.pendingFn = fn;
  }

  /** 注册队列状态变更通知，用于外部同步观测状态 */
  onStateChange(fn: (chatId: string, snapshot: QueueSnapshot) => void): void {
    this.stateFn = fn;
  }

  /** 注册显式丢弃回调；服务关闭时保留队列供持久层恢复，不调用此回调。 */
  onDiscard(fn: (messages: QueuedMessage[]) => void): void {
    this.discardFn = fn;
  }

  /** 推入一条新消息，返回是否进入 pending 队列 */
  push(msg: QueuedMessage): boolean {
    if (this.stopped) return false;

    const key = keyOf(msg);
    const q = this.getQueue(key);

    if (q.busy) {
      log.info("message queued", { chatId: key, pending: q.pending.length + 1 });
      q.pending.push(msg);
      try {
        this.pendingFn?.(msg);
      } catch (err) {
        log.warn("pending callback failed", { chatId: key, error: String(err) });
      }
      this.emitState(key, q);
      return true;
    }

    // buffer 正在等待启动且 pending 里已有更早消息时，新消息只能追加到 pending；
    // 否则会与 buffer 合并并越过 pending 中的 Continuation。
    if (q.pending.length > 0) {
      q.pending.push(msg);
      try {
        this.pendingFn?.(msg);
      } catch (err) {
        log.warn("pending callback failed", { chatId: key, error: String(err) });
      }
      this.emitState(key, q);
      return true;
    }

    // 用户消息可以在短窗口内合并，但不能跨过内部续接事件合并或重排。
    // 遇到不同来源时，立即处理已经先到的 buffer，新消息进入 pending 保持 FIFO。
    if (q.buffer.length > 0 && queueKind(q.buffer[0]!) !== queueKind(msg)) {
      q.pending.push(msg);
      try {
        this.pendingFn?.(msg);
      } catch (err) {
        log.warn("pending callback failed", { chatId: msg.chatId, error: String(err) });
      }
      if (q.bufferTimer) {
        clearTimeout(q.bufferTimer);
        q.bufferTimer = null;
      }
      this.emitState(key, q);
      void this.flush(q, key).catch((err) => {
        log.error("flush failed", { chatId: key, error: String(err) });
      });
      return true;
    }

    q.buffer.push(msg);
    this.emitState(key, q);
    if (msg.triggerKind === "loop_continuation" || msg.triggerKind === "restart_wake" || msg.scheduleCommand) {
      void this.flush(q, key).catch((err) => {
        log.error("flush failed", { chatId: key, error: String(err) });
      });
    } else {
      this.resetBufferTimer(q, key);
    }
    return false;
  }

  /** 停止队列，清除所有计时器 */
  stop(): void {
    this.stopped = true;
    for (const [scopeKey, q] of this.queues) {
      if (q.bufferTimer) {
        clearTimeout(q.bufferTimer);
        q.bufferTimer = null;
      }
      const dropped = q.buffer.length + q.pending.length;
      if (dropped > 0) {
        log.warn("dropping buffered messages on stop", { chatId: scopeKey, count: dropped });
      }
      this.emitState(scopeKey, q);
    }
  }

  isStopped(): boolean {
    return this.stopped;
  }

  /** 清空指定 chat 的等待队列（buffer + pending），返回丢弃的消息数 */
  drain(scopeKey: string): number {
    const q = this.queues.get(scopeKey);
    if (!q) return 0;
    const discarded = [...q.buffer, ...q.pending];
    const dropped = discarded.length;
    q.buffer = [];
    q.pending = [];
    if (q.bufferTimer) {
      clearTimeout(q.bufferTimer);
      q.bufferTimer = null;
    }
    if (dropped > 0) {
      log.info("drain", { chatId: scopeKey, dropped });
      try {
        this.discardFn?.(discarded);
      } catch (err) {
        log.warn("discard callback failed", { chatId: scopeKey, error: String(err) });
      }
    }
    this.emitState(scopeKey, q);
    return dropped;
  }

  /** 获取指定 chat 的待处理消息数（buffer + pending） */
  pendingCount(scopeKey: string): number {
    const q = this.queues.get(scopeKey);
    if (!q) return 0;
    return q.buffer.length + q.pending.length;
  }

  /** 是否有正在处理的任务 */
  hasBusyChats(): boolean {
    for (const [, q] of this.queues) {
      if (q.busy) return true;
    }
    return false;
  }

  /** 指定 chat 是否正在处理 */
  isBusy(scopeKey: string): boolean {
    return this.queues.get(scopeKey)?.busy ?? false;
  }

  /** 取消指定 chat 正在进行的 process 调用 */
  cancel(scopeKey: string): boolean {
    const q = this.queues.get(scopeKey);
    if (!q?.busy || !q.abortController) return false;
    q.abortController.abort();
    return true;
  }

  scopeKeys(): string[] {
    return [...this.queues.keys()];
  }

  async flushScope(scopeKey: string): Promise<void> {
    const q = this.getQueue(scopeKey);
    if (q.busy || q.buffer.length === 0) return;
    await this.flush(q, scopeKey);
  }

  private getQueue(scopeKey: string): ChatQueue {
    let q = this.queues.get(scopeKey);
    if (!q) {
      q = {
        buffer: [], bufferTimer: null, pending: [],
        busy: false, abortController: null,
      };
      this.queues.set(scopeKey, q);
    }
    return q;
  }

  private resetBufferTimer(q: ChatQueue, scopeKey: string): void {
    if (q.bufferTimer) clearTimeout(q.bufferTimer);
    q.bufferTimer = setTimeout(() => {
      void this.flush(q, scopeKey).catch((err) => {
        log.error("flush failed", { chatId: scopeKey, error: String(err) });
      });
    }, this.bufferMs);
  }

  /** 标记某 chat 处理完成，检查后续队列 */
  private processNext(q: ChatQueue, scopeKey: string): void {
    q.busy = false;
    this.emitState(scopeKey, q);

    // 已停止，不再启动新的处理
    if (this.stopped) return;

    if (q.pending.length > 0) {
      const kind = queueKind(q.pending[0]!);
      let count = 1;
      // 用户消息仍可合并；内部续接事件保持独立。
      // Loop 每轮必须保持独立，避免多个任务共用一次结算和回复。
      if (kind !== "loop_continuation" && kind !== "schedule_command") {
        while (count < q.pending.length && queueKind(q.pending[count]!) === kind) count++;
      }
      const next = q.pending.splice(0, count);
      q.buffer = next;
      this.emitState(scopeKey, q);
      if (kind === "loop_continuation" || kind === "restart_wake" || kind === "schedule_command") {
        void this.flush(q, scopeKey).catch((err) => {
          log.error("flush failed", { chatId: scopeKey, error: String(err) });
        });
      } else {
        this.resetBufferTimer(q, scopeKey);
      }
    }
  }

  private async flush(q: ChatQueue, scopeKey: string): Promise<void> {
    if (q.buffer.length === 0) return;
    if (this.startFn && !this.startFn(scopeKey)) {
      this.logDeferred(scopeKey);
      return;
    }

    const messages = q.buffer;
    q.buffer = [];
    q.bufferTimer = null;
    q.busy = true;
    q.abortController = new AbortController();
    this.emitState(scopeKey, q);
    try {
      const { signal } = q.abortController;

      const mergedText = messages.length === 1
        ? messages[0].text
        : messages.map((m) => {
            // 已经是 YAML 格式（- msg: / - forward:）的保持原样
            if (m.text.startsWith("- msg:") || m.text.startsWith("- forward:")) return m.text;
            // 独立消息包装成 YAML 格式
            const label = m.senderLabel ?? "user";
            return `- msg: "${escapeYamlContent(label)}: ${escapeYamlContent(m.text)}"`;
          }).join("\n");

      log.info("flush", { chatId: scopeKey, messageCount: messages.length, textLength: mergedText.length });
      await this.processFn?.(scopeKey, mergedText, messages, signal);
      q.busy = false;
      this.emitState(scopeKey, q);
    } catch (err) {
      log.error("process error", { chatId: scopeKey, error: String(err) });
    } finally {
      q.abortController = null;
      const siblings = this.finishFn?.(scopeKey) ?? [];
      this.processNext(q, scopeKey);
      for (const sibling of [...new Set(siblings)]) {
        if (sibling === scopeKey) continue;
        void this.flushScope(sibling).catch((err) => {
          log.error("woken scope flush failed", { chatId: sibling, error: String(err) });
        });
      }
      if (q.buffer.length === 0 && q.pending.length === 0) {
        this.idleFn?.(scopeKey);
      }
    }
  }

  private logDeferred(scopeKey: string): void {
    log.info("topic concurrency deferred", { chatId: scopeKey });
  }

  private emitState(scopeKey: string, q: ChatQueue): void {
    try {
      this.stateFn?.(scopeKey, {
        buffer: [...q.buffer],
        pending: [...q.pending],
        busy: q.busy,
      });
    } catch (err) {
      log.warn("state callback failed", { chatId: scopeKey, error: String(err) });
    }
  }

}

function keyOf(message: QueuedMessage): string {
  return message.scopeKey ?? message.chatId;
}

function queueKind(message: QueuedMessage): "user" | "schedule_command" | "loop_continuation" | "restart_wake" {
  if (message.triggerKind === "loop_continuation") return "loop_continuation";
    if (message.triggerKind === "restart_wake") return "restart_wake";
  if (message.scheduleCommand) return "schedule_command";
  return "user";
}
