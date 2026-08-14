/**
 * Grok Build CLI backend plugin.
 * 通过 `grok -p --output-format streaming-json` 驱动 agent。
 * 首轮预分配 --session-id，方便 watchdog / 日志在进程结束前定位 session 目录。
 */

import { randomUUID } from "node:crypto";
import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CliAgentBackend, buildNiubotEnv, type BaseCliSession, type ParsedOutput } from "../agent/cli-base.js";
import { AgentSessionNotStartedError, type AgentSessionActivity, type ExecHooks, type SessionConfig } from "../agent/types.js";
import { readGrokTranscript } from "../session-archive/native-transcript.js";
import { resolveWorkspacePath } from "../platform/workspace-path.js";

interface GrokSession extends BaseCliSession {
  sessionDir?: string;
  /** 首轮用 --session-id，后续用 --resume。 */
  isNewSession: boolean;
  /** 客户端预分配的 session 目录 id；agentSessionId 只在 grok 真正开场后写入。 */
  clientSessionId: string;
  /** events.jsonl 增量读取位置，供 /status 和 watchdog 刷新。 */
  eventsOffset: number;
  /** 尚未结束的工具调用数量。 */
  activeToolCount: number;
  /** 从 events.jsonl 整理出的最近日志，覆盖 stdout 碎片。 */
  statusLines: string[];
}

interface GrokJsonResult {
  type?: string;
  text?: string;
  stopReason?: string;
  sessionId?: string;
  usage?: GrokUsage;
  modelUsage?: Record<string, unknown>;
  message?: string;
  error?: string | { message?: string };
}

interface GrokUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
}

export default class GrokBackend extends CliAgentBackend<GrokSession> {
  constructor() {
    super("grok");
  }

  command(): string {
    return "grok";
  }

  needsStableUserPrefix(): boolean {
    return false;
  }

  buildSession(config: SessionConfig): GrokSession {
    const existingId = config.agentSessionId;
    const clientSessionId = existingId ?? randomUUID();
    return {
      workingDirectory: config.workingDirectory ?? process.cwd(),
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      importantContext: config.importantContext,
      agentSessionId: existingId,
      clientSessionId,
      isNewSession: !existingId,
      extraEnv: buildNiubotEnv(config),
      cumulativeBytes: 0,
      compactCount: 0,
      jsonlOffset: 0,
      eventsOffset: 0,
      activeToolCount: 0,
      statusLines: [],
    };
  }

  buildInput(session: GrokSession, message: string): { args: string[]; stdin?: string } {
    // 首轮若已写出 session 目录（进程中途挂了），必须改 resume，不能重复 --session-id。
    if (session.isNewSession && this.sessionExists(session)) {
      session.isNewSession = false;
    }

    const args = [
      "-p", message,
      "--output-format", "streaming-json",
      "--always-approve",
      "--no-memory",
      "--verbatim",
      "--cwd", session.workingDirectory,
    ];

    if (session.model) {
      args.push("--model", session.model);
    }
    if (session.reasoningEffort) {
      args.push("--reasoning-effort", session.reasoningEffort);
    }
    if (session.importantContext) {
      args.push("--rules", session.importantContext);
    }
    const sessionKey = session.agentSessionId ?? session.clientSessionId;
    if (session.isNewSession) {
      args.push("--session-id", sessionKey);
    } else {
      args.push("--resume", sessionKey);
    }

    return { args };
  }

  protected getExecHooks(session: GrokSession): ExecHooks {
    return {
      onLine: (line) => {
        try {
          const event = JSON.parse(line) as { type?: string; sessionId?: string };
          if (event.type !== "end") return;
          session.isNewSession = false;
          session.agentSessionId = event.sessionId ?? session.clientSessionId;
        } catch { /* non-JSON line */ }
      },
      isComplete: (line) => {
        try {
          return (JSON.parse(line) as { type?: string }).type === "end";
        } catch {
          return false;
        }
      },
    };
  }

  protected argsForLog(args: string[]): string[] {
    const result = [...args];
    redactFlagValue(result, "-p");
    redactFlagValue(result, "--rules");
    return result;
  }

  protected isProbeError(err: any): boolean {
    const stderr = err.stderr as string | undefined;
    const stdout = err.stdout as string | undefined;
    const text = `${stderr ?? ""} ${stdout ?? ""}`;
    return /model/i.test(text);
  }

  parseOutput(stdout: string, session: GrokSession): ParsedOutput {
    const stream = parseGrokStream(stdout);
    const errorMessage = stream.error;
    const agentSessionId = stream.completed
      ? (stream.sessionId ?? session.agentSessionId ?? session.clientSessionId)
      : session.agentSessionId;
    const stdoutModel = firstModelUsageId(stream.modelUsage);
    const stdoutContextTokens = estimateGrokContextTokens(stream.usage);

    if (stream.completed && agentSessionId) {
      session.agentSessionId = agentSessionId;
      session.isNewSession = false;
    }

    const lastAssistant = this.readLastAssistant(session);
    const lastAssistantText = lastAssistant.text;
    const stdoutText = stream.text.trim();
    // history 正文不在本轮 stdout 里时，说明是上一轮残留，模型和正文一起丢掉。
    const useHistory = !!(lastAssistantText && (!stdoutText || stdoutText.includes(lastAssistantText)));
    const text = useHistory ? lastAssistantText : stdoutText;
    const model = (useHistory ? lastAssistant.model : undefined) ?? stdoutModel ?? session.model;
    let contextTokens = stdoutContextTokens;
    let contextWindow: number | undefined;

    if (agentSessionId) {
      this.consumeNewEvents(session);
      this.refreshCompactCount(session);
      const signals = this.readSignals(session);
      if (signals) {
        if (signals.contextTokensUsed && signals.contextTokensUsed > 0) {
          contextTokens = signals.contextTokensUsed;
        }
        if (signals.contextWindowTokens && signals.contextWindowTokens > 0) {
          contextWindow = signals.contextWindowTokens;
        }
      }
      this.log.info("parseOutput: done", {
        agentSessionId,
        model: model ?? null,
        contextTokens: contextTokens ?? null,
        contextWindow: contextWindow ?? null,
        modelSource: useHistory && lastAssistant.model ? "history" : stdoutModel ? "stdout" : session.model ? "session" : "none",
        tokensSource: signals?.contextTokensUsed ? "signals" : stdoutContextTokens !== undefined ? "stdout" : "none",
      });
    }

    const turnCompleted = stream.completed;
    const failed = !!errorMessage;

    return {
      text: failed ? "" : text,
      turnCompleted,
      lastMessage: text,
      incompleteReason: turnCompleted ? undefined : (errorMessage ? "grok 返回 error" : "未收到 grok end 事件"),
      agentSessionId,
      model,
      contextTokens,
      contextWindow,
      compactCount: session.compactCount > 0 ? session.compactCount : undefined,
      error: errorMessage,
      failed,
    };
  }

  private readLastAssistant(session: GrokSession): { text?: string; model?: string } {
    const file = this.getChatHistoryPath(session);
    if (!file) return {};
    try {
      return extractLastGrokAssistant(readFileSync(file, "utf-8"));
    } catch {
      return {};
    }
  }

  protected async loadSessionTranscript(session: GrokSession) {
    const file = this.getChatHistoryPath(session);
    if (!session.agentSessionId || !file) {
      throw new AgentSessionNotStartedError(session.agentSessionId ?? session.clientSessionId);
    }
    return {
      ...readGrokTranscript(file, session.agentSessionId),
      sources: [{ path: file, role: "history" }],
    };
  }

  protected refreshActivity(sessionId: string, activity: AgentSessionActivity): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.consumeNewEvents(session, activity);
    this.refreshCompactCount(session);
    activity.executingTool = session.activeToolCount > 0;
    const historyLines = this.readHistoryStatusLines(session);
    if (historyLines.length > 0) session.statusLines = historyLines;
    if (session.statusLines.length > 0) {
      activity.recentLines = [...session.statusLines];
    }
  }

  protected probeSessionFileMtime(session: GrokSession): number | null {
    const eventsPath = this.getEventsPath(session);
    const historyPath = this.getChatHistoryPath(session);
    let latest: number | null = null;
    for (const file of [eventsPath, historyPath]) {
      if (!file) continue;
      try {
        const mtime = statSync(file).mtimeMs;
        latest = latest === null ? mtime : Math.max(latest, mtime);
      } catch { /* try next */ }
    }
    return latest;
  }

  protected probeSessionLastLine(session: GrokSession): string | null {
    const file = this.getChatHistoryPath(session);
    if (!file) return null;
    try {
      const size = statSync(file).size;
      return this.readLastLines(file, size, 1)[0] ?? null;
    } catch {
      return null;
    }
  }

  private consumeNewEvents(session: GrokSession, activity?: AgentSessionActivity): void {
    const eventsPath = this.getEventsPath(session);
    if (!eventsPath) return;
    try {
      const stat = statSync(eventsPath);
      if (stat.size < session.eventsOffset) {
        session.eventsOffset = 0;
        session.activeToolCount = 0;
        if (activity) activity.executingTool = false;
      }
      if (stat.size === session.eventsOffset) return;

      const fd = openSync(eventsPath, "r");
      try {
        const readLen = stat.size - session.eventsOffset;
        const buf = Buffer.alloc(readLen);
        readSync(fd, buf, 0, readLen, session.eventsOffset);
        const chunk = buf.toString("utf-8");
        const lines = chunk.split("\n");
        const trailingPartial = chunk.endsWith("\n") ? "" : (lines.pop() ?? "");
        for (const line of lines) {
          if (line.trim()) applyGrokActivityEvent(session, activity, line);
        }
        let consumed = trailingPartial ? chunk.slice(0, chunk.length - trailingPartial.length) : chunk;
        if (trailingPartial.trim()) {
          try {
            JSON.parse(trailingPartial);
            applyGrokActivityEvent(session, activity, trailingPartial);
            consumed = chunk;
          } catch { /* 最后一行还没写完，下次再读 */ }
        }
        session.eventsOffset += Buffer.byteLength(consumed, "utf-8");
      } finally {
        closeSync(fd);
      }
    } catch { /* events 尚未落盘或正在写 */ }
  }

  private readHistoryStatusLines(session: GrokSession): string[] {
    const file = this.getChatHistoryPath(session);
    if (!file) return [];
    try {
      const size = statSync(file).size;
      if (size <= 0) return [];
      return this.readLastLines(file, size, 3);
    } catch {
      return [];
    }
  }

  private readLastLines(filePath: string, fileSize: number, count: number): string[] {
    const chunk = 65536;
    const fd = openSync(filePath, "r");
    try {
      let offset = fileSize;
      let collected = "";
      while (offset > 0) {
        const readSize = Math.min(chunk, offset);
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

  private getChatHistoryPath(session: GrokSession): string | null {
    const sessionDir = this.getSessionDir(session);
    if (!sessionDir) return null;
    const file = join(sessionDir, "chat_history.jsonl");
    return existsSync(file) ? file : null;
  }

  private getEventsPath(session: GrokSession): string | null {
    const sessionDir = this.getSessionDir(session);
    if (!sessionDir) return null;
    const file = join(sessionDir, "events.jsonl");
    return existsSync(file) ? file : null;
  }

  private getSessionDir(session: GrokSession): string | null {
    if (session.sessionDir && existsSync(session.sessionDir)) {
      return session.sessionDir;
    }
    const sessionKey = session.agentSessionId ?? session.clientSessionId;
    if (!sessionKey) return null;
    const dir = join(
      getGrokHome(),
      "sessions",
      encodeGrokSessionDir(session.workingDirectory),
      sessionKey,
    );
    if (!existsSync(dir)) return null;
    session.sessionDir = dir;
    return dir;
  }

  private sessionExists(session: GrokSession): boolean {
    return this.getSessionDir(session) !== null;
  }

  private readSignals(session: GrokSession): GrokSignals | undefined {
    const sessionDir = this.getSessionDir(session);
    if (!sessionDir) return undefined;
    try {
      return JSON.parse(readFileSync(join(sessionDir, "signals.json"), "utf-8")) as GrokSignals;
    } catch {
      return undefined;
    }
  }

  private refreshCompactCount(session: GrokSession): void {
    session.compactCount = countGrokCompactionSegments(this.getSessionDir(session));
  }
}

type GrokSignals = {
  contextTokensUsed?: number;
  contextWindowTokens?: number;
};

/** 数当前会话目录下 compaction/segment_*.md。 */
export function countGrokCompactionSegments(sessionDir: string | null): number {
  if (!sessionDir) return 0;
  try {
    return readdirSync(join(sessionDir, "compaction"))
      .filter((name) => /^segment_\d+\.md$/i.test(name)).length;
  } catch {
    return 0;
  }
}

/** 与 Grok CLI 的 session 目录命名一致：realpath(cwd) 再 encodeURIComponent。 */
export function encodeGrokSessionDir(cwd: string): string {
  return encodeURIComponent(resolveWorkspacePath(cwd));
}

/** 取当前轮最后一条应发给用户的 assistant 文本。遇 user 行即停，避免跨轮。 */
export function extractLastGrokAssistantText(raw: string): string | undefined {
  return extractLastGrokAssistant(raw).text;
}

/** 当前轮最后一条 assistant 的正文和 model_id。遇 user 行即停，避免跨轮。 */
export function extractLastGrokAssistant(raw: string): { text?: string; model?: string } {
  const lines = raw.split("\n");
  let lastAnyText: string | undefined;
  let lastNoToolText: string | undefined;
  let lastModel: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let entry: { type?: string; content?: unknown; tool_calls?: unknown; model_id?: unknown };
    try {
      entry = JSON.parse(line) as { type?: string; content?: unknown; tool_calls?: unknown; model_id?: unknown };
    } catch {
      continue;
    }
    if (entry.type === "user") break;
    if (entry.type !== "assistant") continue;
    const content = typeof entry.content === "string" ? entry.content.trim() : "";
    const model = typeof entry.model_id === "string" && entry.model_id.trim() ? entry.model_id.trim() : undefined;
    if (model) lastModel ??= model;
    if (!content) continue;
    lastAnyText ??= content;
    const tools = entry.tool_calls;
    if (!Array.isArray(tools) || tools.length === 0) {
      lastNoToolText ??= content;
    }
    if (lastNoToolText && lastModel) {
      return { text: lastNoToolText, model: lastModel };
    }
  }
  return { text: lastNoToolText ?? lastAnyText, model: lastModel };
}

function getGrokHome(): string {
  const override = process.env["GROK_HOME"]?.trim();
  if (override) return resolve(override);
  return resolve(homedir(), ".grok");
}

function parseGrokStream(stdout: string): {
  completed: boolean;
  sessionId?: string;
  usage?: GrokUsage;
  modelUsage?: Record<string, unknown>;
  text: string;
  error?: string;
} {
  let completed = false;
  let sessionId: string | undefined;
  let usage: GrokUsage | undefined;
  let modelUsage: Record<string, unknown> | undefined;
  let text = "";
  let error: string | undefined;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: GrokJsonResult & { data?: string };
    try {
      event = JSON.parse(line) as GrokJsonResult & { data?: string };
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;

    if (event.sessionId) sessionId = event.sessionId;
    if (event.type === "text" && typeof event.data === "string") {
      text += event.data;
    }
    if (event.type === "usage" && event.usage) {
      usage = event.usage;
    }
    if (event.type === "end") {
      completed = true;
      if (event.usage) usage = event.usage;
      if (event.modelUsage) modelUsage = event.modelUsage;
    }
    if (event.type === "error") {
      error = extractGrokError(event);
    }
  }

  return { completed, sessionId, usage, modelUsage, text, error };
}

function extractGrokError(result: GrokJsonResult): string | undefined {
  if (typeof result.error === "string" && result.error.trim()) return result.error.trim();
  if (result.error && typeof result.error === "object" && result.error.message?.trim()) {
    return result.error.message.trim();
  }
  if (result.type === "error" && result.message?.trim()) return result.message.trim();
  return undefined;
}

function firstModelUsageId(modelUsage?: Record<string, unknown>): string | undefined {
  if (!modelUsage) return undefined;
  return Object.keys(modelUsage)[0];
}

function estimateGrokContextTokens(usage?: GrokUsage): number | undefined {
  if (!usage) return undefined;
  if (usage.total_tokens && usage.total_tokens > 0) return usage.total_tokens;
  const total = (usage.input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.output_tokens ?? 0);
  return total > 0 ? total : undefined;
}

function applyGrokActivityEvent(
  session: GrokSession,
  activity: AgentSessionActivity | undefined,
  line: string,
): void {
  let event: { type?: string; ts?: string; tool_name?: string; phase?: string };
  try {
    event = JSON.parse(line) as { type?: string; ts?: string; tool_name?: string; phase?: string };
  } catch {
    return;
  }

  const eventTime = event.ts ? Date.parse(event.ts) : Number.NaN;
  if (activity && Number.isFinite(eventTime)) {
    activity.lastActiveAt = Math.max(activity.lastActiveAt, eventTime);
  }

  const type = event.type ?? "";
  if (type === "turn_started") {
    session.activeToolCount = 0;
    if (activity) activity.executingTool = false;
    return;
  }
  if (type === "turn_ended") {
    session.activeToolCount = 0;
    if (activity) {
      activity.executingTool = false;
      activity.compacting = false;
    }
    return;
  }
  if (type === "tool_started") {
    session.activeToolCount++;
    return;
  }
  if (type === "tool_completed") {
    session.activeToolCount = Math.max(0, session.activeToolCount - 1);
    return;
  }
  if (isGrokCompactStart(type, event.phase)) {
    if (activity) activity.compacting = true;
    return;
  }
  if (isGrokCompactEnd(type, event.phase)) {
    if (activity) activity.compacting = false;
  }
}



function isGrokCompactStart(type: string, phase?: string): boolean {
  return type === "auto_compact_start"
    || type === "compaction_start"
    || (type === "phase_changed" && phase === "compacting");
}

function isGrokCompactEnd(type: string, phase?: string): boolean {
  return type === "auto_compact_end"
    || type === "compaction_end"
    || type === "compact_boundary"
    || /compact.*end/i.test(type);
}

function redactFlagValue(args: string[], flag: string): void {
  const index = args.indexOf(flag);
  if (index >= 0 && index + 1 < args.length) {
    args[index + 1] = `[${flag}]`;
  }
}
