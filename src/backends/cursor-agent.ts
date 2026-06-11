/**
 * Cursor Agent CLI backend plugin.
 * 通过 `cursor-agent -p` 命令驱动 agent，stream-json 输出。
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliAgentBackend, buildNiubotEnv, type BaseCliSession, type ParsedOutput } from "../agent/cli-base.js";
import type { AgentSession, AgentSessionActivity, ExecHooks, SessionConfig } from "../agent/types.js";
import { DEFAULT_LITE_MODELS } from "../config.js";
import { syncCursorWorkspaceRules } from "./cursor-workspace-rules.js";

interface CursorAgentSession extends BaseCliSession {
  sessionLogPath?: string;
  /** stream init 事件解析到的实际模型名（session.model 未配置时用于 footer 显示） */
  resolvedModel?: string;
}

type CursorAgentUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

interface CursorAgentStreamEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  model?: string;
  usage?: CursorAgentUsage;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }> | string;
  };
}

/** 从 assistant 事件提取纯文本（忽略 tool 块） */
function extractAssistantText(event: CursorAgentStreamEvent): string {
  if (event.type !== "assistant" || !event.message) return "";
  const { content } = event.message;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text!)
    .join("")
    .trim();
}

/** 当前窗口：cursor result.usage 四项原样相加 */
function estimateCursorContextWindow(usage: CursorAgentUsage): number {
  return (usage.inputTokens ?? 0)
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
    + (usage.outputTokens ?? 0);
}

function readNiubotVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export default class CursorAgentBackend extends CliAgentBackend<CursorAgentSession> {
  constructor() {
    super("cursor");
  }

  needsStableUserPrefix(): boolean {
    return false;
  }

  command(): string {
    return "cursor-agent";
  }

  override async createSession(config: SessionConfig): Promise<AgentSession> {
    const stableContext = config.importantContext?.trim();
    if (stableContext) {
      const syncResult = syncCursorWorkspaceRules(
        config.workingDirectory ?? process.cwd(),
        stableContext,
        { niubotVersion: readNiubotVersion() },
      );
      this.log.info("cursor workspace rules synced", {
        rulesDir: syncResult.rulesDir,
        engineUpdated: syncResult.engineUpdated,
        recoveryUpdated: syncResult.recoveryUpdated,
      });
    }
    return super.createSession(config);
  }

  buildSession(config: SessionConfig): CursorAgentSession {
    return {
      workingDirectory: config.workingDirectory ?? process.cwd(),
      model: config.modelTier === "lite" ? (config.liteModel ?? DEFAULT_LITE_MODELS.cursor ?? config.model) : config.model,
      importantContext: config.importantContext,
      extraEnv: buildNiubotEnv(config),
      cumulativeBytes: 0,
      compactCount: 0,
      jsonlOffset: 0,
    };
  }

  buildInput(session: CursorAgentSession, message: string): { args: string[]; stdin?: string } {
    const args = [
      "--yolo",
      "--trust",
      "-p",
      "--output-format",
      "stream-json",
      "--workspace",
      session.workingDirectory,
    ];

    if (session.model) {
      args.push("--model", session.model);
    }
    if (session.agentSessionId) {
      args.push("--resume", session.agentSessionId);
    }

    return { args, stdin: message };
  }

  parseOutput(stdout: string, session: CursorAgentSession): ParsedOutput {
    let resultEvent: CursorAgentStreamEvent | undefined;
    let stdoutModel: string | undefined;
    let lastUsageBeforeResult: CursorAgentUsage | undefined;
    let lastAssistantText = "";

    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as CursorAgentStreamEvent;
        if (event.type === "system" && event.subtype === "init" && event.model) {
          stdoutModel = event.model;
          session.resolvedModel = event.model;
        }
        if (event.session_id && !session.agentSessionId) {
          session.agentSessionId = event.session_id;
        }
        if (event.usage && event.type !== "result") {
          lastUsageBeforeResult = event.usage;
        }
        if (event.type === "assistant") {
          const text = extractAssistantText(event);
          if (text) lastAssistantText = text;
        }
        if (event.type === "result") {
          resultEvent = event;
        }
      } catch { /* skip non-JSON lines */ }
    }

    if (!resultEvent) {
      return { text: stdout.trim() };
    }

    // 有 stream 中间 usage 时优先用之；否则 result.usage
    const usage = lastUsageBeforeResult ?? resultEvent.usage;
    const contextTokens = usage ? estimateCursorContextWindow(usage) : 0;

    const result = resultEvent.result?.trim() ?? "";
    // result.result 会把 tool 前的旁白与最终答复拼在一起；优先用最后一个 assistant 文本
    const responseText = lastAssistantText || result;
    const model = session.model ?? stdoutModel ?? session.resolvedModel;
    const parsed: ParsedOutput = {
      text: resultEvent.is_error ? "" : responseText,
      agentSessionId: resultEvent.session_id ?? session.agentSessionId,
      contextTokens: contextTokens > 0 ? contextTokens : undefined,
      model,
    };
    if (resultEvent.is_error) {
      parsed.error = result || undefined;
      parsed.failed = true;
    }
    return parsed;
  }

  protected getExecHooks(session: CursorAgentSession): ExecHooks {
    return {
      onLine: (line) => {
        try {
          const event = JSON.parse(line) as CursorAgentStreamEvent;
          if (event.type === "system" && event.subtype === "init") {
            if (event.session_id && !session.agentSessionId) {
              session.agentSessionId = event.session_id;
            }
            if (event.model) {
              session.resolvedModel = event.model;
            }
          } else if (event.session_id && !session.agentSessionId) {
            session.agentSessionId = event.session_id;
          }
        } catch { /* non-JSON line */ }
      },
      isComplete: (line) => {
        try { return (JSON.parse(line) as CursorAgentStreamEvent).type === "result"; }
        catch { return false; }
      },
    };
  }

  protected refreshActivity(sessionId: string, activity: AgentSessionActivity): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const jsonlPath = this.getJsonlPath(session);
    if (!jsonlPath) return;
    try {
      const size = statSync(jsonlPath).size;
      if (size === 0) return;
      activity.recentLines = this.readLastLines(jsonlPath, size, 3);
    } catch { /* ignore */ }
  }

  protected probeSessionFileMtime(session: CursorAgentSession): number | null {
    const jsonlPath = this.getJsonlPath(session);
    if (!jsonlPath) return null;
    try {
      return statSync(jsonlPath).mtimeMs;
    } catch {
      return null;
    }
  }

  protected probeSessionLastLine(session: CursorAgentSession): string | null {
    const jsonlPath = this.getJsonlPath(session);
    if (!jsonlPath) return null;
    try {
      const stat = statSync(jsonlPath);
      const lines = this.readLastLines(jsonlPath, stat.size, 1);
      return lines[0] ?? null;
    } catch {
      return null;
    }
  }

  private getJsonlPath(session: CursorAgentSession): string | null {
    if (session.sessionLogPath && existsSync(session.sessionLogPath)) {
      return session.sessionLogPath;
    }
    if (!session.agentSessionId) return null;

    const projectKey = this.getCursorProjectKey(session.workingDirectory);
    const jsonlPath = join(
      homedir(),
      ".cursor",
      "projects",
      projectKey,
      "agent-transcripts",
      session.agentSessionId,
      `${session.agentSessionId}.jsonl`,
    );

    if (existsSync(jsonlPath)) {
      session.sessionLogPath = jsonlPath;
      return jsonlPath;
    }
    return null;
  }

  private getCursorProjectKey(workingDirectory: string): string {
    return resolve(workingDirectory).replace(/^[/\\]+/, "").replace(/[/\\]+/g, "-");
  }

  /** 从文件尾部倒读，获取最后 N 个完整行。 */
  private readLastLines(filePath: string, fileSize: number, count: number): string[] {
    const CHUNK = 65536;
    const fd = openSync(filePath, "r");
    try {
      let offset = fileSize;
      let collected = "";
      while (offset > 0) {
        const readSize = Math.min(CHUNK, offset);
        offset -= readSize;
        const buf = Buffer.alloc(readSize);
        readSync(fd, buf, 0, readSize, offset);
        collected = buf.toString("utf-8") + collected;
        const lines = collected.split("\n").filter((line) => line.trim());
        if (lines.length > count) return lines.slice(-count);
      }
      return collected.split("\n").filter((line) => line.trim()).slice(-count);
    } finally {
      closeSync(fd);
    }
  }
}
