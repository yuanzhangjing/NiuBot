/**
 * ResourceLeaseManager：写任务资源互斥（§12）。
 *
 * 同一资源键（如 repo-write:/real/path）同时只允许一个写 Job 持有；
 * 冲突写操作不得并行。租约带 fencing token（随机 UUID）和过期时间，
 * 过期由 Scheduler tick 定期清理（进程残留时不会永久占住资源）。
 */

import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
  acquireLease as acquireLeaseRow,
  cleanupExpiredLeases,
  getLeaseByJob,
  releaseLeaseByJob,
} from "./store.js";

export interface ResourceLeaseManagerOptions {
  /** 租约 TTL（默认 24h；过期由清理任务释放） */
  ttlMs?: number;
}

export type AcquireLeaseResult =
  | { ok: true; token: string }
  | { ok: false; reason: "held"; holderJobId: string };

export class ResourceLeaseManager {
  private readonly ttlMs: number;

  constructor(
    private readonly db: Database.Database,
    private readonly botId: string,
    options: ResourceLeaseManagerOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  }

  /** 获取租约；已被其他 Job 持有时返回 held。 */
  acquire(resourceKey: string, jobId: string): AcquireLeaseResult {
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
    return acquireLeaseRow(this.db, {
      botId: this.botId,
      resourceKey,
      jobId,
      token,
      expiresAt,
    });
  }

  /** 释放 Job 的租约（Job 终态/中断后调用）。 */
  release(jobId: string): boolean {
    return releaseLeaseByJob(this.db, jobId);
  }

  /** Job 当前持有的租约（fencing token 核对用）。 */
  heldBy(jobId: string): { resourceKey: string; token: string } | undefined {
    const row = getLeaseByJob(this.db, jobId);
    return row ? { resourceKey: row.resource_key, token: row.token } : undefined;
  }

  /** 清理过期租约（Scheduler tick 调用）。 */
  cleanupExpired(): number {
    return cleanupExpiredLeases(this.db, new Date().toISOString());
  }
}
