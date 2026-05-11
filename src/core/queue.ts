import { escapeYamlContent } from "../im/render.js";
import { createLogger } from "../logger.js";

const log = createLogger("queue");

export interface QueuedMessage {
  chatId: string;
  text: string;
  timestamp: number;
  platformMsgId?: string;
  /** 发送者短标签（如 "U2"），用于多条消息合并时生成 YAML 格式 */
  senderLabel?: string;
  /** 发送者内部 ID，用于群聊 speaker 注入 */
  senderId?: string;
  /** 消息在 DB 中的 ID，用于 process() 标记 agent_seen */
  dbMsgId?: number;
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

type ProcessFn = (chatId: string, mergedText: string, messages: QueuedMessage[], signal: AbortSignal) => Promise<void>;

export interface QueueSnapshot {
  buffer: QueuedMessage[];
  pending: QueuedMessage[];
  busy: boolean;
}

export class MessageQueue {
  private queues = new Map<string, ChatQueue>();
  private processFn: ProcessFn | null = null;
  private bufferMs: number;
  private pendingFn: ((msg: QueuedMessage) => void) | null = null;
  private stateFn: ((chatId: string, snapshot: QueueSnapshot) => void) | null = null;
  private stopped = false;

  constructor(bufferMs = 1500) {
    this.bufferMs = bufferMs;
  }

  /** 注册消息处理函数 */
  onProcess(fn: ProcessFn): void {
    this.processFn = fn;
  }

  /** 注册 pending 通知函数（消息进入等待队列时立即回调） */
  onPending(fn: (msg: QueuedMessage) => void): void {
    this.pendingFn = fn;
  }

  /** 注册队列状态变更通知，用于外部同步观测状态 */
  onStateChange(fn: (chatId: string, snapshot: QueueSnapshot) => void): void {
    this.stateFn = fn;
  }

  /** 推入一条新消息，返回是否进入 pending 队列 */
  push(msg: QueuedMessage): boolean {
    if (this.stopped) return false;

    const q = this.getQueue(msg.chatId);

    if (q.busy) {
      log.info("message queued", { chatId: msg.chatId, pending: q.pending.length + 1 });
      q.pending.push(msg);
      this.pendingFn?.(msg);
      this.emitState(msg.chatId, q);
      return true;
    }

    q.buffer.push(msg);
    this.emitState(msg.chatId, q);
    this.resetBufferTimer(q, msg.chatId);
    return false;
  }

  /** 停止队列，清除所有计时器 */
  stop(): void {
    this.stopped = true;
    for (const [chatId, q] of this.queues) {
      if (q.bufferTimer) {
        clearTimeout(q.bufferTimer);
        q.bufferTimer = null;
      }
      const dropped = q.buffer.length + q.pending.length;
      if (dropped > 0) {
        log.warn("dropping buffered messages on stop", { chatId, count: dropped });
      }
      this.emitState(chatId, q);
    }
  }

  /** 清空指定 chat 的等待队列（buffer + pending），返回丢弃的消息数 */
  drain(chatId: string): number {
    const q = this.queues.get(chatId);
    if (!q) return 0;
    const dropped = q.buffer.length + q.pending.length;
    q.buffer = [];
    q.pending = [];
    if (q.bufferTimer) {
      clearTimeout(q.bufferTimer);
      q.bufferTimer = null;
    }
    if (dropped > 0) {
      log.info("drain", { chatId, dropped });
    }
    this.emitState(chatId, q);
    return dropped;
  }

  /** 获取指定 chat 的待处理消息数（buffer + pending） */
  pendingCount(chatId: string): number {
    const q = this.queues.get(chatId);
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
  isBusy(chatId: string): boolean {
    return this.queues.get(chatId)?.busy ?? false;
  }

  /** 取消指定 chat 正在进行的 process 调用 */
  cancel(chatId: string): boolean {
    const q = this.queues.get(chatId);
    if (!q?.busy || !q.abortController) return false;
    q.abortController.abort();
    return true;
  }

  private getQueue(chatId: string): ChatQueue {
    let q = this.queues.get(chatId);
    if (!q) {
      q = {
        buffer: [], bufferTimer: null, pending: [],
        busy: false, abortController: null,
      };
      this.queues.set(chatId, q);
    }
    return q;
  }

  private resetBufferTimer(q: ChatQueue, chatId: string): void {
    if (q.bufferTimer) clearTimeout(q.bufferTimer);
    q.bufferTimer = setTimeout(() => {
      void this.flush(q, chatId);
    }, this.bufferMs);
  }

  /** 标记某 chat 处理完成，检查后续队列 */
  private processNext(q: ChatQueue, chatId: string): void {
    q.busy = false;
    this.emitState(chatId, q);

    // 已停止，不再启动新的处理
    if (this.stopped) return;

    if (q.pending.length > 0) {
      const next = q.pending;
      q.pending = [];
      q.buffer = next;
      this.emitState(chatId, q);
      this.resetBufferTimer(q, chatId);
    }
  }

  private async flush(q: ChatQueue, chatId: string): Promise<void> {
    if (q.buffer.length === 0) return;

    const messages = q.buffer;
    q.buffer = [];
    q.bufferTimer = null;
    q.busy = true;
    q.abortController = new AbortController();
    this.emitState(chatId, q);
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

    log.info("flush", { chatId, messageCount: messages.length, textLength: mergedText.length });

    try {
      await this.processFn?.(chatId, mergedText, messages, signal);
    } catch (err) {
      log.error("process error", { chatId, error: String(err) });
    } finally {
      q.abortController = null;
      this.processNext(q, chatId);
    }
  }

  private emitState(chatId: string, q: ChatQueue): void {
    this.stateFn?.(chatId, {
      buffer: [...q.buffer],
      pending: [...q.pending],
      busy: q.busy,
    });
  }

}
