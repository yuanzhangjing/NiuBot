/**
 * Opencode CLI backend plugin.
 * 通过 `opencode run` 命令驱动 agent，JSON 事件流输出。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { CliAgentBackend, buildNiubotEnv, type BaseCliSession, type ParsedOutput } from "../agent/cli-base.js";
import type { SessionConfig, ExecHooks } from "../agent/types.js";

interface OpencodeSession extends BaseCliSession {}

export default class OpencodeBackend extends CliAgentBackend<OpencodeSession> {
  readonly supportsSystemPrompt = false;

  constructor() {
    super("opencode");
  }

  command(): string {
    return "opencode";
  }

  buildSession(config: SessionConfig): OpencodeSession {
    return {
      workingDirectory: config.workingDirectory ?? process.cwd(),
      model: config.model,
      importantContext: config.importantContext,
      extraEnv: buildNiubotEnv(config),
      cumulativeBytes: 0,
      compactCount: 0,
      jsonlOffset: 0,
    };
  }

  buildInput(session: OpencodeSession, message: string): { args: string[]; stdin?: string } {
    const args = [
      "run",
      "--format", "json",
      "--dangerously-skip-permissions",
      "--dir", session.workingDirectory,
    ];
    if (session.model) args.push("-m", session.model);
    if (session.agentSessionId) args.push("-s", session.agentSessionId);
    return { args, stdin: message };
  }

  protected getExecHooks(session: OpencodeSession): ExecHooks {
    return {
      onLine: (line) => {
        try {
          const e = JSON.parse(line);
          if (e.sessionID && !session.agentSessionId) {
            session.agentSessionId = e.sessionID;
          }
        } catch { /* non-JSON line */ }
      },
      isComplete: (line) => {
        try {
          const e = JSON.parse(line);
          // step_finish with reason="stop" or "end_turn" = 真正结束
          // reason="tool-calls" = 中间 step，还有后续
          return e.type === "step_finish" && e.part?.reason !== "tool-calls";
        } catch { return false; }
      },
    };
  }

  protected probeSessionFileMtime(session: OpencodeSession): number | null {
    if (!session.agentSessionId) return null;
    const db = this.getOpencodeDb();
    if (!db) return null;
    try {
      const row = db.prepare("SELECT time_updated FROM session WHERE id = ?").get(session.agentSessionId) as { time_updated: number } | undefined;
      return row?.time_updated ?? null;
    } catch {
      return null;
    }
  }

  /** 懒加载 Opencode 的 SQLite DB（只读） */
  private opencodeDb: Database.Database | null | undefined; // undefined = 未初始化
  private getOpencodeDb(): Database.Database | null {
    if (this.opencodeDb !== undefined) return this.opencodeDb;
    const dbPath = resolve(homedir(), ".local", "share", "opencode", "opencode.db");
    if (!existsSync(dbPath)) {
      this.opencodeDb = null;
      return null;
    }
    try {
      this.opencodeDb = new Database(dbPath, { readonly: true });
      return this.opencodeDb;
    } catch {
      this.opencodeDb = null;
      return null;
    }
  }

  parseOutput(stdout: string, session: OpencodeSession): ParsedOutput {
    let text = "";
    let sessionId: string | undefined;
    let contextTokens = 0;
    let errorMsg: string | undefined;

    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          sessionID?: string;
          part?: {
            type?: string;
            text?: string;
            tokens?: {
              total?: number;
            };
          };
          error?: { data?: { message?: string } };
        };

        if (event.sessionID) sessionId = event.sessionID;

        if (event.type === "error" && event.error?.data?.message?.includes("Model not found")) {
          errorMsg = "模型不存在";
        } else if (event.type === "text" && event.part?.text) {
          text += event.part.text;
        }

        if (event.type === "step_finish" && event.part?.tokens?.total) {
          contextTokens = event.part.tokens.total;
        }
      } catch { /* skip non-JSON lines */ }
    }

    // 优先用配置里的 model，没配则从 opencode DB 查 modelID
    const model = session.model ?? (sessionId ? this.queryModelId(sessionId) : undefined);

    return {
      text: text.trim() || stdout.trim(),
      agentSessionId: sessionId,
      contextTokens: contextTokens > 0 ? contextTokens : undefined,
      model,
      error: errorMsg,
    };
  }

  /** 从 opencode DB 的 message 表查最新 assistant 消息的 modelID */
  private queryModelId(sessionId: string): string | undefined {
    const db = this.getOpencodeDb();
    if (!db) return undefined;
    try {
      const row = db.prepare(
        "SELECT json_extract(data, '$.modelID') AS model_id FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant' ORDER BY time_created DESC LIMIT 1",
      ).get(sessionId) as { model_id: string | null } | undefined;
      return row?.model_id ?? undefined;
    } catch {
      return undefined;
    }
  }
}
