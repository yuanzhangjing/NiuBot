/**
 * Worker 持久化访问层（SQLite prepared statements）。
 *
 * 只做行级读写和 CAS 更新，不做业务状态机校验（那是 JobService 的职责）。
 * 时间统一使用 SQLite `datetime('now')`（UTC），与现有 messages/sessions 约定一致。
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { NativeTranscriptSource } from "../agent/types.js";

import type {
  AgentContinuation,
  ArtifactEntry,
  ContinuationStatus,
  Job,
  JobStatus,
  Work,
  WorkStatus,
  WorkerEvent,
  WorkerEventName,
  WorkVisibility,
} from "./types.js";

export type { ArtifactEntry };

export interface WorkRow {
  id: string;
  bot_id: string;
  owner_user_id: string;
  source_chat_id: string;
  visibility: WorkVisibility;
  request: string;
  trigger_msg_platform_id: string | null;
  status: WorkStatus;
  job_ids_json: string;
  final_conclusion: string | null;
  interrupted_count: number;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface JobRow {
  id: string;
  work_id: string;
  worker_profile_id: string;
  profile_snapshot_json: string | null;
  prompt: string;
  workdir: string;
  backend_session_id: string | null;
  backend_type: string | null;
  transcript_sources_json: string;
  status: JobStatus;
  response_text: string | null;
  exit_code: number | null;
  error: string | null;
  changed_files_json: string;
  artifacts_json: string;
  started_at: string | null;
  ended_at: string | null;
  claim_token: string | null;
  claimed_at: string | null;
  depends_on_json: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface ContinuationRow {
  id: string;
  bot_id: string;
  chat_id: string;
  dedupe_key: string;
  kind: "job_terminal";
  work_id: string;
  job_ids_json: string;
  trigger_msg_platform_id: string | null;
  status: ContinuationStatus;
  agent_turn_id: string | null;
  claim_token: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface WorkerEventRow {
  id: number;
  bot_id: string;
  work_id: string;
  job_id: string | null;
  event: WorkerEventName;
  detail: string | null;
  created_at: string;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export function workRowToWork(row: WorkRow): Work {
  return {
    id: row.id,
    botId: row.bot_id,
    ownerUserId: row.owner_user_id,
    sourceChatId: row.source_chat_id,
    visibility: row.visibility,
    request: row.request,
    triggerMsgPlatformId: row.trigger_msg_platform_id ?? undefined,
    status: row.status,
    jobIds: parseJsonArray(row.job_ids_json),
    finalConclusion: row.final_conclusion ?? undefined,
    interruptedCount: row.interrupted_count,
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export function jobRowToJob(row: JobRow): Job {
  return {
    id: row.id,
    workId: row.work_id,
    workerProfileId: row.worker_profile_id,
    profileSnapshotJson: row.profile_snapshot_json,
    prompt: row.prompt,
    workdir: row.workdir,
    backendSessionId: row.backend_session_id ?? undefined,
    backendType: row.backend_type ?? undefined,
    transcriptSourcesJson: row.transcript_sources_json,
    status: row.status,
    responseText: row.response_text ?? undefined,
    exitCode: row.exit_code ?? undefined,
    error: row.error ?? undefined,
    changedFilesJson: row.changed_files_json,
    artifactsJson: row.artifacts_json,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    claimToken: row.claim_token ?? undefined,
    claimedAt: row.claimed_at ?? undefined,
    dependsOn: parseJsonArray(row.depends_on_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export function continuationRowToContinuation(row: ContinuationRow): AgentContinuation {
  return {
    id: row.id,
    botId: row.bot_id,
    chatId: row.chat_id,
    dedupeKey: row.dedupe_key,
    kind: row.kind,
    workId: row.work_id,
    jobIds: parseJsonArray(row.job_ids_json),
    triggerMsgPlatformId: row.trigger_msg_platform_id ?? undefined,
    status: row.status,
    agentTurnId: row.agent_turn_id ?? undefined,
    claimToken: row.claim_token ?? undefined,
    claimedAt: row.claimed_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
  };
}

export function eventRowToEvent(row: WorkerEventRow): WorkerEvent {
  return {
    id: row.id,
    botId: row.bot_id,
    workId: row.work_id,
    jobId: row.job_id ?? undefined,
    event: row.event,
    detail: row.detail ?? undefined,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Work
// ---------------------------------------------------------------------------

export function insertWork(
  db: Database.Database,
  input: {
    botId: string;
    ownerUserId: string;
    sourceChatId: string;
    visibility: WorkVisibility;
    request: string;
    triggerMsgPlatformId?: string;
  },
): WorkRow {
  const id = `wrk_${randomUUID()}`;
  db.prepare(`
    INSERT INTO worker_works (id, bot_id, owner_user_id, source_chat_id, visibility, request, trigger_msg_platform_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.botId, input.ownerUserId, input.sourceChatId, input.visibility, input.request, input.triggerMsgPlatformId ?? null);
  return getWork(db, id)!;
}

export function getWork(db: Database.Database, workId: string): WorkRow | undefined {
  return db.prepare("SELECT * FROM worker_works WHERE id = ?").get(workId) as WorkRow | undefined;
}

export function listWorks(
  db: Database.Database,
  query: { botId: string; ownerUserId?: string; sourceChatId?: string; status?: WorkStatus },
): WorkRow[] {
  const where: string[] = ["bot_id = ?"];
  const params: unknown[] = [query.botId];
  if (query.ownerUserId !== undefined) {
    where.push("owner_user_id = ?");
    params.push(query.ownerUserId);
  }
  if (query.sourceChatId !== undefined) {
    where.push("source_chat_id = ?");
    params.push(query.sourceChatId);
  }
  if (query.status !== undefined) {
    where.push("status = ?");
    params.push(query.status);
  }
  return db.prepare(`SELECT * FROM worker_works WHERE ${where.join(" AND ")} ORDER BY created_at DESC`).all(...params) as WorkRow[];
}

/** CAS 更新 Work：必须匹配当前 status 和 version，否则返回 false。 */
export function updateWorkStatus(
  db: Database.Database,
  workId: string,
  change: { from: WorkStatus; to: WorkStatus; version: number },
): boolean {
  const result = db.prepare(`
    UPDATE worker_works
    SET status = ?, version = version + 1, updated_at = datetime('now')
    WHERE id = ? AND status = ? AND version = ?
  `).run(change.to, workId, change.from, change.version);
  return result.changes === 1;
}

/** 写 Work 终态结论（与状态转换分开，供完整 Work 流程使用）。 */
export function updateWorkConclusion(
  db: Database.Database,
  workId: string,
  conclusion: string,
): boolean {
  const result = db.prepare(`
    UPDATE worker_works
    SET final_conclusion = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(conclusion, workId);
  return result.changes === 1;
}

export function appendWorkJobId(db: Database.Database, workId: string, jobId: string): boolean {
  const row = getWork(db, workId);
  if (!row) return false;
  const ids = parseJsonArray(row.job_ids_json);
  if (ids.includes(jobId)) return true;
  ids.push(jobId);
  db.prepare(`
    UPDATE worker_works
    SET job_ids_json = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(ids), workId);
  return true;
}

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

export function insertJob(
  db: Database.Database,
  input: {
    workId: string;
    workerProfileId: string;
    prompt: string;
    workdir: string;
    dependsOn?: string[];
  },
): JobRow {
  const id = `job_${randomUUID()}`;
  db.prepare(`
    INSERT INTO worker_jobs (id, work_id, worker_profile_id, prompt, workdir, depends_on_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.workId,
    input.workerProfileId,
    input.prompt,
    input.workdir,
    JSON.stringify(input.dependsOn ?? []),
  );
  return getJob(db, id)!;
}

export function getJob(db: Database.Database, jobId: string): JobRow | undefined {
  return db.prepare("SELECT * FROM worker_jobs WHERE id = ?").get(jobId) as JobRow | undefined;
}

export function listJobs(db: Database.Database, workId: string): JobRow[] {
  return db.prepare("SELECT * FROM worker_jobs WHERE work_id = ? ORDER BY created_at ASC").all(workId) as JobRow[];
}

export function countJobs(db: Database.Database, workId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM worker_jobs WHERE work_id = ?").get(workId) as { n: number };
  return row.n;
}

export function listJobsByStatus(db: Database.Database, status: JobStatus): JobRow[] {
  return db
    .prepare("SELECT * FROM worker_jobs WHERE status = ? ORDER BY created_at ASC")
    .all(status) as JobRow[];
}

// ---------------------------------------------------------------------------
// 幂等键（CLI 层派生，相同键返回原 Job）
// ---------------------------------------------------------------------------

export function getJobByJobIdempotencyKey(db: Database.Database, idempotencyKey: string): JobRow | undefined {
  const row = db.prepare("SELECT * FROM worker_idempotency_keys WHERE idempotency_key = ?").get(idempotencyKey) as
    | { job_id: string }
    | undefined;
  if (!row) return undefined;
  return getJob(db, row.job_id);
}

export function insertJobIdempotencyKey(db: Database.Database, idempotencyKey: string, jobId: string): void {
  db.prepare("INSERT OR IGNORE INTO worker_idempotency_keys (idempotency_key, job_id) VALUES (?, ?)").run(
    idempotencyKey,
    jobId,
  );
}

// ---------------------------------------------------------------------------
// Work 计数（interrupted 防静默循环）
// ---------------------------------------------------------------------------

export function incrementWorkInterruptedCount(db: Database.Database, workId: string): void {
  db.prepare(`
    UPDATE worker_works
    SET interrupted_count = interrupted_count + 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(workId);
}

/** 连续失败计数（防失控上限，§6 maxConsecutiveFailures） */
export function incrementWorkConsecutiveFailures(db: Database.Database, workId: string): void {
  db.prepare(`
    UPDATE worker_works
    SET consecutive_failures = consecutive_failures + 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(workId);
}

export function resetWorkConsecutiveFailures(db: Database.Database, workId: string): void {
  db.prepare(`
    UPDATE worker_works
    SET consecutive_failures = 0, updated_at = datetime('now')
    WHERE id = ?
  `).run(workId);
}

export interface JobStatusChange {
  from: JobStatus;
  to: JobStatus;
  version: number;
  /** 附加更新字段（执行记录等）；undefined 表示不改 */
  fields?: Partial<{
    backendSessionId: string;
    responseText: string;
    exitCode: number;
    error: string;
    changedFiles: string[];
    artifacts: ArtifactEntry[];
    startedAt: string;
    endedAt: string;
    claimToken: string;
    claimedAt: string;
  }>;
}

/** CAS 更新 Job 状态：必须匹配当前 status 和 version，否则返回 false。 */
export function updateJobStatus(db: Database.Database, jobId: string, change: JobStatusChange): boolean {
  const assignments = [
    "status = ?",
    "version = version + 1",
    "updated_at = datetime('now')",
  ];
  const params: unknown[] = [change.to];
  const f = change.fields;
  if (f) {
    if (f.backendSessionId !== undefined) {
      assignments.push("backend_session_id = ?");
      params.push(f.backendSessionId);
    }
    if (f.responseText !== undefined) {
      assignments.push("response_text = ?");
      params.push(f.responseText);
    }
    if (f.exitCode !== undefined) {
      assignments.push("exit_code = ?");
      params.push(f.exitCode);
    }
    if (f.error !== undefined) {
      assignments.push("error = ?");
      params.push(f.error);
    }
    if (f.changedFiles !== undefined) {
      assignments.push("changed_files_json = ?");
      params.push(JSON.stringify(f.changedFiles));
    }
    if (f.artifacts !== undefined) {
      assignments.push("artifacts_json = ?");
      params.push(JSON.stringify(f.artifacts));
    }
    if (f.startedAt !== undefined) {
      assignments.push("started_at = ?");
      params.push(f.startedAt);
    }
    if (f.endedAt !== undefined) {
      assignments.push("ended_at = ?");
      params.push(f.endedAt);
    }
    if (f.claimToken !== undefined) {
      assignments.push("claim_token = ?");
      params.push(f.claimToken);
    }
    if (f.claimedAt !== undefined) {
      assignments.push("claimed_at = ?");
      params.push(f.claimedAt);
    }
  }
  params.push(jobId, change.from, change.version);
  const result = db.prepare(`UPDATE worker_jobs SET ${assignments.join(", ")} WHERE id = ? AND status = ? AND version = ?`).run(...params);
  return result.changes === 1;
}

/** 持久化运行中 session 的只读 transcript 引用；终态后不再改写。 */
export function updateRunningJobSession(
  db: Database.Database,
  jobId: string,
  input: { backendSessionId: string; backendType: string; sources: NativeTranscriptSource[] },
): boolean {
  const result = db.prepare(`
    UPDATE worker_jobs
    SET backend_session_id = ?, backend_type = ?, transcript_sources_json = ?,
        updated_at = datetime('now'), version = version + 1
    WHERE id = ? AND status IN ('running', 'cancelling')
  `).run(input.backendSessionId, input.backendType, JSON.stringify(input.sources), jobId);
  return result.changes === 1;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function insertWorkerEvent(
  db: Database.Database,
  input: { botId: string; workId: string; jobId?: string; event: WorkerEventName; detail?: string },
): number {
  const result = db.prepare(`
    INSERT INTO worker_events (bot_id, work_id, job_id, event, detail)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.botId, input.workId, input.jobId ?? null, input.event, input.detail ?? null);
  return Number(result.lastInsertRowid);
}

export function listWorkerEvents(db: Database.Database, workId: string): WorkerEventRow[] {
  return db.prepare("SELECT * FROM worker_events WHERE work_id = ? ORDER BY id ASC").all(workId) as WorkerEventRow[];
}

// ---------------------------------------------------------------------------
// Continuations
// ---------------------------------------------------------------------------

export function insertContinuation(
  db: Database.Database,
  input: {
    botId: string;
    chatId: string;
    dedupeKey: string;
    workId: string;
    jobIds: string[];
    triggerMsgPlatformId?: string;
  },
): ContinuationRow {
  const id = `ctn_${randomUUID()}`;
  db.prepare(`
    INSERT INTO agent_continuations (id, bot_id, chat_id, dedupe_key, work_id, job_ids_json, trigger_msg_platform_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.botId, input.chatId, input.dedupeKey, input.workId, JSON.stringify(input.jobIds), input.triggerMsgPlatformId ?? null);
  return getContinuationByDedupeKey(db, input.dedupeKey)!;
}

export function getContinuationByDedupeKey(db: Database.Database, dedupeKey: string): ContinuationRow | undefined {
  return db.prepare("SELECT * FROM agent_continuations WHERE dedupe_key = ?").get(dedupeKey) as ContinuationRow | undefined;
}

export function listPendingContinuations(db: Database.Database): ContinuationRow[] {
  return db
    .prepare(`
      SELECT c.* FROM agent_continuations c
      JOIN worker_works w ON w.id = c.work_id
      WHERE c.status = 'pending'
      ORDER BY c.created_at ASC
    `)
    .all() as ContinuationRow[];
}

/**
 * 批量认领某 chat 的 pending Continuation（事务内原子完成）。
 * 同一 Work 的多个 Continuation 一起认领，供合并验收。
 */
export function claimPendingContinuations(
  db: Database.Database,
  chatId: string,
  claimToken: string,
  limit = 10,
): ContinuationRow[] {
  return db.transaction((): ContinuationRow[] => {
    const pending = db.prepare(`
      SELECT * FROM agent_continuations
      WHERE chat_id = ? AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    `).all(chatId, limit) as ContinuationRow[];
    if (pending.length === 0) return [];
    const mark = db.prepare(`
      UPDATE agent_continuations
      SET status = 'claimed', claim_token = ?, claimed_at = datetime('now'), attempt_count = attempt_count + 1
      WHERE id = ? AND status = 'pending'
    `);
    const claimed: ContinuationRow[] = [];
    for (const row of pending) {
      if (mark.run(claimToken, row.id).changes === 1) {
        claimed.push({ ...row, status: "claimed", claim_token: claimToken });
      }
    }
    return claimed;
  })();
}

/** 投递时认领（pending → claimed + token，attempt +1）；CAS 保证并发安全。 */
export function claimContinuationById(db: Database.Database, id: string, claimToken: string): boolean {
  const result = db.prepare(`
    UPDATE agent_continuations
    SET status = 'claimed', claim_token = ?, claimed_at = datetime('now'), attempt_count = attempt_count + 1
    WHERE id = ? AND status = 'pending'
  `).run(claimToken, id);
  return result.changes === 1;
}

/** 认领次数达到上限的 Continuation 标记为 failed（终态，不再投递，防死循环）。 */
export function failContinuationByAttemptLimit(db: Database.Database, id: string, limit: number): boolean {
  const result = db.prepare(`
    UPDATE agent_continuations
    SET status = 'failed', completed_at = datetime('now')
    WHERE id = ? AND status = 'pending' AND attempt_count >= ?
  `).run(id, limit);
  return result.changes === 1;
}

/** claimed 超时兜底：认领后超过阈值未完成（进程被杀等）→ 重置 pending 允许重新投递（Work 已终态的直接收敛）。 */
export function resetStaleClaimedContinuations(db: Database.Database, staleMinutes: number): number {
  const result = db.prepare(`
    UPDATE agent_continuations
    SET status = 'pending', claim_token = NULL, claimed_at = NULL
    WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < datetime('now', ?)
  `).run(`-${staleMinutes} minutes`);
  return result.changes;
}

/** 主 Agent 回合失败/中断后释放认领（claimed → pending，允许重新投递）。 */
export function releaseContinuationClaim(db: Database.Database, id: string): boolean {
  const result = db.prepare(`
    UPDATE agent_continuations
    SET status = 'pending', claim_token = NULL, claimed_at = NULL
    WHERE id = ? AND status = 'claimed'
  `).run(id);
  return result.changes === 1;
}

/** 主 Agent 回合事务提交后标记完成（CAS：只认 claimed 状态）。 */
export function markContinuationCompleted(
  db: Database.Database,
  id: string,
  agentTurnId: string,
): boolean {
  const result = db.prepare(`
    UPDATE agent_continuations
    SET status = 'completed', agent_turn_id = ?, completed_at = datetime('now')
    WHERE id = ? AND status = 'claimed'
  `).run(agentTurnId, id);
  return result.changes === 1;
}

/** 重启恢复：claimed Continuation 重置为 pending，允许重新投递（§7.5）。 */
export function resetClaimedContinuations(db: Database.Database): number {
  const result = db.prepare(`
    UPDATE agent_continuations
    SET status = 'pending', claim_token = NULL, claimed_at = NULL, agent_turn_id = NULL
    WHERE status = 'claimed'
  `).run();
  return result.changes;
}
