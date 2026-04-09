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
  /** 当前处理开始时间 */
  busySince: number | null;
  /** cancel 已请求，抑制 flush 中的错误日志 */
  cancelRequested: boolean;
  /** cancel 正在进行中，防止重复 cancel */
  cancelInFlight: boolean;
}

type ProcessFn = (chatId: string, mergedText: string, messages: QueuedMessage[]) => Promise<void>;

export class MessageQueue {
  private queues = new Map<string, ChatQueue>();
  private processFn: ProcessFn | null = null;
  private bufferMs: number;
  private cancelThresholdMs: number;
  private cancelFn: ((chatId: string) => Promise<void>) | null = null;
  private mergeFn: ((msg: QueuedMessage) => void) | null = null;
  private stopped = false;

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

  /** 注册 pending 通知函数（消息进入等待队列时立即回调） */
  onPending(fn: (msg: QueuedMessage) => void): void {
    this.mergeFn = fn;
  }

  /** 推入一条新消息，返回是否进入 pending 队列 */
  push(msg: QueuedMessage): boolean {
    if (this.stopped) return false;

    const q = this.getQueue(msg.chatId);

    if (q.busy) {
      const elapsed = q.busySince ? Date.now() - q.busySince : Infinity;

      if (elapsed < this.cancelThresholdMs && this.cancelFn && !q.cancelInFlight) {
        log.info("cancel+merge", { chatId: msg.chatId, elapsed });
        void this.cancelAndMerge(q, msg);
      } else {
        log.info("message queued", { chatId: msg.chatId, pending: q.pending.length + 1 });
        q.pending.push(msg);
      }
      this.mergeFn?.(msg);
      return true;
    }

    q.buffer.push(msg);
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
    }
  }

  /** 是否有正在处理的任务 */
  hasBusyChats(): boolean {
    for (const [, q] of this.queues) {
      if (q.busy) return true;
    }
    return false;
  }

  private getQueue(chatId: string): ChatQueue {
    let q = this.queues.get(chatId);
    if (!q) {
      q = {
        buffer: [], bufferTimer: null, pending: [],
        busy: false, busySince: null,
        cancelRequested: false, cancelInFlight: false,
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
    q.busySince = null;
    q.cancelInFlight = false;

    // 已停止，不再启动新的处理
    if (this.stopped) return;

    if (q.pending.length > 0) {
      const next = q.pending;
      q.pending = [];
      q.buffer = next;
      this.resetBufferTimer(q, chatId);
    }
  }

  private async flush(q: ChatQueue, chatId: string): Promise<void> {
    if (q.buffer.length === 0) return;

    const messages = q.buffer;
    q.buffer = [];
    q.bufferTimer = null;
    q.busy = true;
    q.busySince = Date.now();
    q.cancelRequested = false;

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
      await this.processFn?.(chatId, mergedText, messages);
    } catch (err) {
      if (!q.cancelRequested) {
        log.error("process error", { chatId, error: String(err) });
      }
    } finally {
      // flush 始终负责推进队列，无论是否被 cancel
      // cancelAndMerge 只往 pending 里放消息，不管状态转换
      q.cancelRequested = false;
      this.processNext(q, chatId);
    }
  }

  private async cancelAndMerge(q: ChatQueue, newMsg: QueuedMessage): Promise<void> {
    q.cancelRequested = true;
    q.cancelInFlight = true;

    try {
      await this.cancelFn?.(newMsg.chatId);
    } catch (err) {
      log.warn("cancel failed, queuing instead", { chatId: newMsg.chatId, error: String(err) });
    }

    // 无论 cancel 成功或失败，新消息都排入 pending
    // cancel 成功：session 保持存活，原始消息已在 agent 上下文中，只需发新消息
    // cancel 失败：flush 正常完成后，processNext 处理新消息
    // cancelInFlight 由 processNext 重置
    // 注意：mergeFn 已在 push() 中调用，此处不重复调用
    q.pending.push(newMsg);
  }
}
