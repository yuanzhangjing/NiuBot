const DEFAULT_TOPIC_CONCURRENCY_PER_CHAT = 4;

function envCap(): number {
  const raw = Number(process.env.NIUBOT_TOPIC_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_TOPIC_CONCURRENCY_PER_CHAT;
}

/** 同一 chat 内 isolated scope 的并行门禁；非 isolated 不经过这里。 */
export class TopicConcurrencyLimiter {
  private readonly cap: number;
  private readonly running = new Map<string, Set<string>>();
  private readonly deferred = new Map<string, Set<string>>();

  constructor(cap = envCap()) {
    this.cap = Math.max(1, cap);
  }

  tryAcquire(chatId: string, scopeKey: string): boolean {
    const running = this.runningSet(chatId);
    if (running.has(scopeKey)) return true;
    if (running.size >= this.cap) {
      const waiting = this.deferredSet(chatId);
      waiting.add(scopeKey);
      return false;
    }
    running.add(scopeKey);
    return true;
  }

  release(chatId: string, scopeKey: string): string[] {
    const running = this.runningSet(chatId);
    running.delete(scopeKey);
    this.deferred.get(chatId)?.delete(scopeKey);
    return this.wakeDeferred(chatId);
  }

  hasRunning(chatId: string, scopeKey: string): boolean {
    return this.running.get(chatId)?.has(scopeKey) ?? false;
  }

  runningCount(chatId: string): number {
    return this.running.get(chatId)?.size ?? 0;
  }

  runningScopes(chatId: string): string[] {
    return [...(this.running.get(chatId) ?? [])];
  }

  private wakeDeferred(chatId: string): string[] {
    const running = this.runningSet(chatId);
    const waiting = this.deferred.get(chatId);
    if (!waiting) return [];
    const woken: string[] = [];
    while (running.size < this.cap && waiting.size > 0) {
      const next = waiting.values().next().value as string | undefined;
      if (!next) break;
      waiting.delete(next);
      running.add(next);
      woken.push(next);
    }
    if (waiting.size === 0) this.deferred.delete(chatId);
    return woken;
  }

  private runningSet(chatId: string): Set<string> {
    let set = this.running.get(chatId);
    if (!set) {
      set = new Set();
      this.running.set(chatId, set);
    }
    return set;
  }

  private deferredSet(chatId: string): Set<string> {
    let set = this.deferred.get(chatId);
    if (!set) {
      set = new Set();
      this.deferred.set(chatId, set);
    }
    return set;
  }
}
