import { createLogger } from "../logger.js";

const log = createLogger("queue");

export interface QueuedMessage {
  chatId: string;
  text: string;
  timestamp: number;
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
  /** 当前处理开始时间 */
  busySince: number | null;
}

type ProcessFn = (chatId: string, mergedText: string) => Promise<void>;

export class MessageQueue {
  private queues = new Map<string, ChatQueue>();
  private processFn: ProcessFn | null = null;
  private bufferMs: number;
  private cancelThresholdMs: number;
  private cancelFn: ((chatId: string) => Promise<void>) | null = null;

  constructor(bufferMs = 3000, cancelThresholdMs = 10000) {
    this.bufferMs = bufferMs;
    this.cancelThresholdMs = cancelThresholdMs;
  }

  /** 注册消息处理函数 */
  onProcess(fn: ProcessFn): void {
    this.processFn = fn;
  }

  /** 注册 cancel 函数（用于 cancel+合并） */
  onCancel(fn: (chatId: string) => Promise<void>): void {
    this.cancelFn = fn;
  }

  /** 推入一条新消息 */
  push(msg: QueuedMessage): void {
    const q = this.getQueue(msg.chatId);

    if (q.busy) {
      const elapsed = q.busySince ? Date.now() - q.busySince : Infinity;

      if (elapsed < this.cancelThresholdMs && this.cancelFn) {
        // agent 刚开始处理，cancel + 合并
        log.info("cancel+merge", { chatId: msg.chatId, elapsed });
        void this.cancelAndMerge(q, msg);
      } else {
        // agent 已有实质进展，排队等待
        log.info("message queued", { chatId: msg.chatId, pending: q.pending.length + 1 });
        q.pending.push(msg);
      }
      return;
    }

    // agent 空闲，放入缓冲区做合并
    q.buffer.push(msg);
    this.resetBufferTimer(q, msg.chatId);
  }

  /** 标记某 chat 处理完成，检查队列 */
  done(chatId: string): void {
    const q = this.queues.get(chatId);
    if (!q) return;

    q.busy = false;
    q.busySince = null;

    // 检查有没有排队消息
    if (q.pending.length > 0) {
      const next = q.pending;
      q.pending = [];
      // 合并所有排队消息
      q.buffer = next;
      this.resetBufferTimer(q, chatId);
    }
  }

  /** 检查某 chat 的 agent 是否忙 */
  isBusy(chatId: string): boolean {
    return this.queues.get(chatId)?.busy ?? false;
  }

  private getQueue(chatId: string): ChatQueue {
    let q = this.queues.get(chatId);
    if (!q) {
      q = { buffer: [], bufferTimer: null, pending: [], busy: false, busySince: null };
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

  private async flush(q: ChatQueue, chatId: string): Promise<void> {
    if (q.buffer.length === 0) return;

    const messages = q.buffer;
    q.buffer = [];
    q.bufferTimer = null;
    q.busy = true;
    q.busySince = Date.now();

    const mergedText = messages.map((m) => m.text).join("\n");
    log.info("flush", { chatId, messageCount: messages.length, textLength: mergedText.length });

    try {
      await this.processFn?.(chatId, mergedText);
    } catch (err) {
      log.error("process error", { chatId, error: String(err) });
    } finally {
      this.done(chatId);
    }
  }

  private async cancelAndMerge(q: ChatQueue, newMsg: QueuedMessage): Promise<void> {
    try {
      await this.cancelFn?.(newMsg.chatId);
    } catch (err) {
      log.warn("cancel failed, queuing instead", { chatId: newMsg.chatId, error: String(err) });
      q.pending.push(newMsg);
      return;
    }

    // cancel 成功，把新消息放入缓冲区重新发
    q.busy = false;
    q.busySince = null;
    q.buffer.push(newMsg);
    this.resetBufferTimer(q, newMsg.chatId);
  }
}
