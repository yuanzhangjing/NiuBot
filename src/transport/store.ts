import type Database from "better-sqlite3";
import type { InboundTerminalStatus, OutboundKind, OutboundRequest } from "./types.js";

export type InboundStatus =
  | "pending"
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "stopped"
  | "discarded"
  | "interrupted";

export type OutboundStatus = "pending" | "sending" | "sent" | "failed" | "unknown";

export type InboundRow = {
  id: number;
  botId: string;
  platform: string;
  platformMsgId: string;
  payloadJson: string;
  status: InboundStatus;
  messageId?: number;
  runId?: string;
  attemptCount: number;
  error?: string;
};

export type OutboundRow = {
  id: number;
  requestId: string;
  botId: string;
  platform: string;
  kind: OutboundKind;
  chatId?: string;
  payloadJson: string;
  status: OutboundStatus;
  attemptCount: number;
  platformMsgId?: string;
  error?: string;
};

export type InsertInboundResult = {
  inserted: boolean;
  row: InboundRow;
};

export type TransportStatusCounts = {
  inbox: Record<InboundStatus, number>;
  outbox: Record<OutboundStatus, number>;
};

const ERROR_LIMIT = 2_000;

export class TransportStore {
  constructor(
    private readonly db: Database.Database,
    private readonly botId: string,
    private readonly platform: string,
  ) {}

  insertInbound(platformMsgId: string, payloadJson: string): InsertInboundResult {
    const result = this.db.prepare(`
      INSERT INTO transport_inbox (bot_id, platform, platform_msg_id, payload_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(bot_id, platform, platform_msg_id) DO NOTHING
    `).run(this.botId, this.platform, platformMsgId, payloadJson);

    const row = this.getInboundByPlatformMessageId(platformMsgId);
    if (!row) throw new Error(`Failed to persist transport inbox message: ${platformMsgId}`);
    return { inserted: result.changes === 1, row };
  }

  getInbound(id: number): InboundRow | undefined {
    return mapInboundRow(this.db.prepare(`
      SELECT id, bot_id, platform, platform_msg_id, payload_json, status,
             message_id, run_id, attempt_count, error
      FROM transport_inbox
      WHERE bot_id = ? AND platform = ? AND id = ?
    `).get(this.botId, this.platform, id) as RawInboundRow | undefined);
  }

  getInboundByPlatformMessageId(platformMsgId: string): InboundRow | undefined {
    return mapInboundRow(this.db.prepare(`
      SELECT id, bot_id, platform, platform_msg_id, payload_json, status,
             message_id, run_id, attempt_count, error
      FROM transport_inbox
      WHERE bot_id = ? AND platform = ? AND platform_msg_id = ?
    `).get(this.botId, this.platform, platformMsgId) as RawInboundRow | undefined);
  }

  markInboundAttempt(id: number): boolean {
    return this.db.prepare(`
      UPDATE transport_inbox
      SET attempt_count = attempt_count + 1, error = NULL, updated_at = datetime('now')
      WHERE bot_id = ? AND platform = ? AND id = ? AND status = 'pending'
    `).run(this.botId, this.platform, id).changes === 1;
  }

  markInboundHandlerError(id: number, error: unknown): void {
    this.db.prepare(`
      UPDATE transport_inbox
      SET status = CASE WHEN attempt_count >= 3 THEN 'failed' ELSE status END,
          error = ?,
          completed_at = CASE WHEN attempt_count >= 3 THEN datetime('now') ELSE completed_at END,
          updated_at = datetime('now')
      WHERE bot_id = ? AND platform = ? AND id = ? AND status = 'pending'
    `).run(limitError(error), this.botId, this.platform, id);
  }

  markInboundQueued(id: number, messageId: number): boolean {
    return this.db.prepare(`
      UPDATE transport_inbox
      SET status = 'queued', message_id = ?, queued_at = COALESCE(queued_at, datetime('now')),
          error = NULL, updated_at = datetime('now')
      WHERE bot_id = ? AND platform = ? AND id = ? AND status IN ('pending', 'queued')
    `).run(messageId, this.botId, this.platform, id).changes === 1;
  }

  markInboundTerminal(id: number, status: InboundTerminalStatus, error?: unknown): boolean {
    return this.db.prepare(`
      UPDATE transport_inbox
      SET status = ?, error = ?, completed_at = datetime('now'), updated_at = datetime('now')
      WHERE bot_id = ? AND platform = ? AND id = ?
        AND status IN ('pending', 'queued', 'processing')
    `).run(status, error == null ? null : limitError(error), this.botId, this.platform, id).changes === 1;
  }

  markInboundRunState(messageIds: number[], runId: string, stage: string, error?: unknown): number {
    if (messageIds.length === 0) return 0;
    const placeholders = messageIds.map(() => "?").join(", ");
    const identity = [this.botId, this.platform, ...messageIds];

    if (stage === "queued") {
      return this.db.prepare(`
        UPDATE transport_inbox
        SET run_id = ?, updated_at = datetime('now')
        WHERE bot_id = ? AND platform = ? AND message_id IN (${placeholders}) AND status = 'queued'
      `).run(runId, ...identity).changes;
    }

    if (stage === "agent_running") {
      return this.db.prepare(`
        UPDATE transport_inbox
        SET status = 'processing', run_id = ?, processing_at = COALESCE(processing_at, datetime('now')),
            updated_at = datetime('now')
        WHERE bot_id = ? AND platform = ? AND message_id IN (${placeholders}) AND status = 'queued'
      `).run(runId, ...identity).changes;
    }

    const terminalStatus = runStageToInboundStatus(stage);
    if (!terminalStatus) return 0;
    return this.db.prepare(`
      UPDATE transport_inbox
      SET status = ?, run_id = ?, error = ?, completed_at = datetime('now'), updated_at = datetime('now')
      WHERE bot_id = ? AND platform = ? AND message_id IN (${placeholders})
        AND status IN ('queued', 'processing')
    `).run(
      terminalStatus,
      runId,
      error == null ? null : limitError(error),
      ...identity,
    ).changes;
  }

  discardInboundMessages(messageIds: number[]): number {
    if (messageIds.length === 0) return 0;
    const placeholders = messageIds.map(() => "?").join(", ");
    return this.db.prepare(`
      UPDATE transport_inbox
      SET status = 'discarded', completed_at = datetime('now'), updated_at = datetime('now')
      WHERE bot_id = ? AND platform = ? AND message_id IN (${placeholders})
        AND status IN ('pending', 'queued')
    `).run(this.botId, this.platform, ...messageIds).changes;
  }

  prepareInboundRecovery(): { pending: InboundRow[]; interrupted: number; requeued: number } {
    const tx = this.db.transaction(() => {
      const interrupted = this.db.prepare(`
        UPDATE transport_inbox
        SET status = 'interrupted', error = 'Engine stopped after Backend execution began',
            completed_at = datetime('now'), updated_at = datetime('now')
        WHERE bot_id = ? AND platform = ? AND status = 'processing'
      `).run(this.botId, this.platform).changes;
      const requeued = this.db.prepare(`
        UPDATE transport_inbox
        SET status = 'pending', run_id = NULL, error = NULL, updated_at = datetime('now')
        WHERE bot_id = ? AND platform = ? AND status = 'queued'
      `).run(this.botId, this.platform).changes;
      const pending = (this.db.prepare(`
        SELECT id, bot_id, platform, platform_msg_id, payload_json, status,
               message_id, run_id, attempt_count, error
        FROM transport_inbox
        WHERE bot_id = ? AND platform = ? AND status = 'pending'
        ORDER BY id
      `).all(this.botId, this.platform) as RawInboundRow[]).map(mapInboundRowRequired);
      return { pending, interrupted, requeued };
    });
    return tx();
  }

  insertOutbound(requestId: string, request: OutboundRequest, payloadJson: string): OutboundRow {
    const chatId = "chatId" in request ? request.chatId : undefined;
    this.db.prepare(`
      INSERT INTO transport_outbox (request_id, bot_id, platform, kind, chat_id, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(requestId, this.botId, this.platform, request.kind, chatId ?? null, payloadJson);
    const row = this.getOutbound(requestId);
    if (!row) throw new Error(`Failed to persist transport outbox request: ${requestId}`);
    return row;
  }

  getOutbound(requestId: string): OutboundRow | undefined {
    return mapOutboundRow(this.db.prepare(`
      SELECT id, request_id, bot_id, platform, kind, chat_id, payload_json, status,
             attempt_count, platform_msg_id, error
      FROM transport_outbox
      WHERE bot_id = ? AND platform = ? AND request_id = ?
    `).get(this.botId, this.platform, requestId) as RawOutboundRow | undefined);
  }

  markOutboundSending(requestId: string): boolean {
    return this.db.prepare(`
      UPDATE transport_outbox
      SET status = 'sending', attempt_count = attempt_count + 1,
          sending_at = datetime('now'), error = NULL, updated_at = datetime('now')
      WHERE bot_id = ? AND platform = ? AND request_id = ? AND status = 'pending'
    `).run(this.botId, this.platform, requestId).changes === 1;
  }

  markOutboundSent(requestId: string, platformMsgId?: string): boolean {
    return this.db.prepare(`
      UPDATE transport_outbox
      SET status = 'sent', platform_msg_id = ?, error = NULL,
          completed_at = datetime('now'), updated_at = datetime('now')
      WHERE bot_id = ? AND platform = ? AND request_id = ? AND status IN ('sending', 'unknown')
    `).run(platformMsgId ?? null, this.botId, this.platform, requestId).changes === 1;
  }

  markOutboundFailed(requestId: string, error: unknown): boolean {
    return this.db.prepare(`
      UPDATE transport_outbox
      SET status = 'failed', error = ?, completed_at = datetime('now'), updated_at = datetime('now')
      WHERE bot_id = ? AND platform = ? AND request_id = ? AND status = 'sending'
    `).run(limitError(error), this.botId, this.platform, requestId).changes === 1;
  }

  markOutboundUnknown(requestId: string, error: unknown): boolean {
    return this.db.prepare(`
      UPDATE transport_outbox
      SET status = 'unknown', error = ?, completed_at = datetime('now'), updated_at = datetime('now')
      WHERE bot_id = ? AND platform = ? AND request_id = ? AND status = 'sending'
    `).run(limitError(error), this.botId, this.platform, requestId).changes === 1;
  }

  prepareOutboundRecovery(): { pending: OutboundRow[]; unknown: number } {
    const tx = this.db.transaction(() => {
      const unknown = this.db.prepare(`
        UPDATE transport_outbox
        SET status = 'unknown', error = 'Engine stopped while delivery result was unknown',
            completed_at = datetime('now'), updated_at = datetime('now')
        WHERE bot_id = ? AND platform = ? AND status = 'sending'
      `).run(this.botId, this.platform).changes;
      const pending = (this.db.prepare(`
        SELECT id, request_id, bot_id, platform, kind, chat_id, payload_json, status,
               attempt_count, platform_msg_id, error
        FROM transport_outbox
        WHERE bot_id = ? AND platform = ? AND status = 'pending'
        ORDER BY id
      `).all(this.botId, this.platform) as RawOutboundRow[]).map(mapOutboundRowRequired);
      return { pending, unknown };
    });
    return tx();
  }

  getExpiredUnknownFileRequests(cutoff: Date): OutboundRow[] {
    const cutoffSql = cutoff.toISOString().slice(0, 19).replace("T", " ");
    return (this.db.prepare(`
      SELECT id, request_id, bot_id, platform, kind, chat_id, payload_json, status,
             attempt_count, platform_msg_id, error
      FROM transport_outbox
      WHERE bot_id = ? AND platform = ? AND kind = 'file' AND status = 'unknown'
        AND completed_at IS NOT NULL AND completed_at <= ?
      ORDER BY id
    `).all(this.botId, this.platform, cutoffSql) as RawOutboundRow[]).map(mapOutboundRowRequired);
  }

  getStatusCounts(): TransportStatusCounts {
    const inbox = emptyInboundCounts();
    const outbox = emptyOutboundCounts();
    const inboxRows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM transport_inbox
      WHERE bot_id = ? AND platform = ? GROUP BY status
    `).all(this.botId, this.platform) as Array<{ status: InboundStatus; count: number }>;
    const outboxRows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM transport_outbox
      WHERE bot_id = ? AND platform = ? GROUP BY status
    `).all(this.botId, this.platform) as Array<{ status: OutboundStatus; count: number }>;
    for (const row of inboxRows) inbox[row.status] = row.count;
    for (const row of outboxRows) outbox[row.status] = row.count;
    return { inbox, outbox };
  }
}

type RawInboundRow = {
  id: number;
  bot_id: string;
  platform: string;
  platform_msg_id: string;
  payload_json: string;
  status: InboundStatus;
  message_id: number | null;
  run_id: string | null;
  attempt_count: number;
  error: string | null;
};

type RawOutboundRow = {
  id: number;
  request_id: string;
  bot_id: string;
  platform: string;
  kind: OutboundKind;
  chat_id: string | null;
  payload_json: string;
  status: OutboundStatus;
  attempt_count: number;
  platform_msg_id: string | null;
  error: string | null;
};

function mapInboundRow(row: RawInboundRow | undefined): InboundRow | undefined {
  if (!row) return undefined;
  return mapInboundRowRequired(row);
}

function mapInboundRowRequired(row: RawInboundRow): InboundRow {
  return {
    id: row.id,
    botId: row.bot_id,
    platform: row.platform,
    platformMsgId: row.platform_msg_id,
    payloadJson: row.payload_json,
    status: row.status,
    messageId: row.message_id ?? undefined,
    runId: row.run_id ?? undefined,
    attemptCount: row.attempt_count,
    error: row.error ?? undefined,
  };
}

function mapOutboundRow(row: RawOutboundRow | undefined): OutboundRow | undefined {
  if (!row) return undefined;
  return mapOutboundRowRequired(row);
}

function mapOutboundRowRequired(row: RawOutboundRow): OutboundRow {
  return {
    id: row.id,
    requestId: row.request_id,
    botId: row.bot_id,
    platform: row.platform,
    kind: row.kind,
    chatId: row.chat_id ?? undefined,
    payloadJson: row.payload_json,
    status: row.status,
    attemptCount: row.attempt_count,
    platformMsgId: row.platform_msg_id ?? undefined,
    error: row.error ?? undefined,
  };
}

function runStageToInboundStatus(stage: string): InboundTerminalStatus | undefined {
  if (stage === "done") return "completed";
  if (stage === "failed") return "failed";
  if (stage === "stopped") return "stopped";
  return undefined;
}

function limitError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.length > ERROR_LIMIT ? `${message.slice(0, ERROR_LIMIT - 1)}…` : message;
}

function emptyInboundCounts(): Record<InboundStatus, number> {
  return {
    pending: 0,
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    stopped: 0,
    discarded: 0,
    interrupted: 0,
  };
}

function emptyOutboundCounts(): Record<OutboundStatus, number> {
  return { pending: 0, sending: 0, sent: 0, failed: 0, unknown: 0 };
}
