/**
 * DeepSeek Harness (dsh) backend plugin.
 * 通过 `dsh --profile headless --json` 驱动一轮任务，NDJSON 事件流输出。
 *
 * dsh 的模型不走 CLI 参数：provider / model / reasoningEffort 由 profile 的
 * `agent-default-model` 决定。这里每轮生成一份 --patch 覆盖文件，同时把
 * session 日志固定到 NiuBot 自己的根目录并关闭 zstd 压缩，便于读取归档。
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { CliAgentBackend, buildNiubotEnv, type BaseCliSession, type ParsedOutput } from "../agent/cli-base.js";
import { AgentSessionNotStartedError, type AgentSessionActivity, type SessionConfig, type ExecHooks } from "../agent/types.js";
import { NIUBOT_HOME } from "../config.js";
import { readDshTranscript } from "../session-archive/native-transcript.js";

interface DshSession extends BaseCliSession {
  /** 原生 session JSONL 路径（找到后缓存，但每次会确认是否出现了更高代次） */
  sessionFile?: string;
}

interface DshEvent {
  type?: string;
  phase?: string;
  sessionId?: string;
  text?: string;
  message?: string;
  reason?: { kind?: string; error?: { message?: string; code?: string } };
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number };
}

const DEFAULT_PROVIDER = "deepseek-official";
const DEFAULT_PROFILE = "headless";
/** profile → 默认 provider/model 的进程内缓存 */
const defaultModelCache = new Map<string, { provider: string; model: string }>();

export default class DshBackend extends CliAgentBackend<DshSession> {
  constructor() {
    super("dsh");
  }

  command(): string {
    return "dsh";
  }

  /** dsh 没有 append-system-prompt，身份/规则只能拼进首条 user 文本 */
  needsStableUserPrefix(): boolean {
    return true;
  }

  buildSession(config: SessionConfig): DshSession {
    return {
      workingDirectory: config.workingDirectory ?? process.cwd(),
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      importantContext: config.importantContext,
      extraEnv: buildNiubotEnv(config),
      cumulativeBytes: 0,
      compactCount: 0,
      jsonlOffset: 0,
    };
  }

  buildInput(session: DshSession, message: string): { args: string[]; stdin?: string } {
    const args = ["--profile", this.profile(), "--patch", this.writePatch(session)];
    // 部署侧额外 overlay（如自定义 provider 路由），多个用路径分隔符连接
    for (const extra of extraPatches()) {
      args.push("--patch", extra);
    }
    args.push("--json");
    if (session.agentSessionId) {
      args.push("--session-id", session.agentSessionId);
    }
    // 消息走 stdin（`-`），避免长 prompt 出现在进程列表里
    args.push("-");
    return { args, stdin: message };
  }

  protected isProbeError(err: any): boolean {
    const stderr = String(err?.stderr ?? "");
    return /model|provider|UNSUPPORTED|MISSING_CREDENTIAL|INVALID_CREDENTIAL/i.test(stderr);
  }

  protected getExecHooks(session: DshSession): ExecHooks {
    return {
      onLine: (line) => {
        const event = parseEvent(line);
        if (!event) return;
        if (event.type === "session" && event.sessionId && !session.agentSessionId) {
          session.agentSessionId = event.sessionId;
          session.sessionFile = undefined;
        }
      },
      isComplete: (line) => parseEvent(line)?.type === "final",
    };
  }

  parseOutput(stdout: string, session: DshSession): ParsedOutput {
    let agentSessionId = session.agentSessionId;
    let text = "";
    let sawFinal = false;
    let reasonKind: string | undefined;
    let reasonError: string | undefined;
    let errorMessage: string | undefined;
    let contextTokens: number | undefined;

    for (const line of stdout.split("\n")) {
      const event = parseEvent(line);
      if (!event) continue;

      switch (event.type) {
        case "session":
          if (event.sessionId) agentSessionId = event.sessionId;
          break;
        case "status":
          if (event.phase === "turn_end") {
            reasonKind = event.reason?.kind;
            reasonError = event.reason?.error?.message;
          } else if (event.phase === "step_end" && event.usage?.totalTokens !== undefined) {
            // step_end 的 usage 是单步累计（input+output+cacheRead），
            // 最后一步即当前上下文占用
            contextTokens = event.usage.totalTokens;
          }
          break;
        case "final":
          sawFinal = true;
          text = event.text ?? "";
          break;
        case "error":
          errorMessage = event.message;
          break;
        default:
          break;
      }
    }

    if (agentSessionId) {
      session.agentSessionId = agentSessionId;
      this.scanSessionLog(session);
    }

    const completed = sawFinal && reasonKind === "completed";
    const failedReason = reasonKind === "error" || (!completed && !!errorMessage);
    const detail = reasonError ?? errorMessage;

    return {
      text: text.trim(),
      turnCompleted: completed,
      lastMessage: text.trim() || undefined,
      incompleteReason: completed
        ? undefined
        : `未正常结束${reasonKind ? `（reason=${reasonKind}）` : ""}`,
      agentSessionId,
      contextTokens,
      // dsh 的 --json 流不带模型名，这里回填本轮的配置值
      model: effectiveModel(session) ? splitModel(effectiveModel(session)).model : undefined,
      compactCount: session.compactCount > 0 ? session.compactCount : undefined,
      error: failedReason ? (detail ?? "dsh 执行失败") : undefined,
      failed: failedReason,
    };
  }

  protected async loadSessionTranscript(session: DshSession) {
    const file = this.getSessionFile(session);
    // 没真正开场的 session 归类为 discarded，不要报 archive_failed
    if (!file || !session.agentSessionId) throw new AgentSessionNotStartedError(session.agentSessionId ?? "unknown");
    return { ...readDshTranscript(file, session.agentSessionId), sources: [{ path: file, role: "session" }] };
  }

  protected refreshActivity(sessionId: string, activity: AgentSessionActivity): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const file = this.getSessionFile(session);
    if (!file) return;
    try {
      const size = statSync(file).size;
      if (size === 0) return;
      const lines = this.readTailLines(file, size, 40);
      const rendered: string[] = [];
      const pendingCalls = new Set<string>();
      let compacting = false;
      for (const line of lines) {
        const entry = parseLogEntry(line);
        if (!entry) continue;
        const data = entry["data"] as Record<string, unknown> | undefined;
        if (entry["type"] === "tool/call") pendingCalls.add(String(data?.["callId"] ?? ""));
        else if (entry["type"] === "tool/result") pendingCalls.delete(String(data?.["toolCallId"] ?? ""));
        else if (entry["type"] === "compaction/start") compacting = true;
        else if (entry["type"] === "compaction/end") compacting = false;
        const readable = renderActivityLine(line);
        if (readable) rendered.push(readable);
      }
      // 长工具调用或压缩期间没有新输出，watchdog 只靠 lastActiveAt 会误杀
      activity.executingTool = pendingCalls.size > 0;
      activity.compacting = compacting;
      if (rendered.length > 0) activity.recentLines = rendered.slice(-3);
    } catch { /* ignore */ }
  }

  protected probeSessionFileMtime(session: DshSession): number | null {
    const file = this.getSessionFile(session);
    if (!file) return null;
    try {
      return statSync(file).mtimeMs;
    } catch {
      return null;
    }
  }

  private profile(): string {
    return process.env["DSH_PROFILE"]?.trim() || DEFAULT_PROFILE;
  }

  /** NiuBot 自己管的 session 根目录（profile 默认根会写成 zstd，读不了） */  private sessionRoot(): string {
    return join(this.niubotHome(), "dsh", "sessions");
  }

  /** 延迟读取：config 的 NIUBOT_HOME 在模块加载时就固定了，测试里 stub 环境变量后取不到 */
  private niubotHome(): string {
    const configured = process.env["NIUBOT_HOME"]?.trim();
    return configured ? resolve(configured) : NIUBOT_HOME;
  }

  /**
   * profile 合成后的默认 provider/model。只在「只设 effort 没设模型」时用到，
   * 结果按 profile + 额外 patch 缓存；失败不缓存，下次重试。
   */
  private profileDefaultModel(): { provider: string; model: string } | null {
    const extras = extraPatches();
    const key = [this.profile(), ...extras].join("\0");
    const cached = defaultModelCache.get(key);
    if (cached) return cached;
    try {
      const args = ["--profile", this.profile()];
      for (const extra of extras) args.push("--patch", extra);
      args.push("--dump-config");
      const output = execFileSync(this.command(), args, {
        encoding: "utf-8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const resolved = parseAgentDefaultModel(output);
      if (resolved) defaultModelCache.set(key, resolved);
      return resolved;
    } catch (err) {
      this.log.warn("dsh profile default model unavailable", { error: String(err) });
      return null;
    }
  }

  private writePatch(session: DshSession): string {
    const entries: unknown[] = [];
    // 没配模型时允许用 DSH_MODEL 兜底，否则会落回 profile 默认的 deepseek-official
    const configuredModel = effectiveModel(session);
    let selection: { provider: string; model: string } | undefined;
    if (configuredModel) {
      selection = splitModel(configuredModel);
    } else if (session.reasoningEffort) {
      // 只设 effort 时读 profile 自己的默认 provider/model 再叠加：
      // dsh 的 agent-default-model 是整体替换，缺 provider/model 会把默认值清掉
      selection = this.profileDefaultModel() ?? undefined;
    }
    if (selection) {
      const config: Record<string, string> = { provider: selection.provider, model: selection.model };
      if (session.reasoningEffort) config["reasoningEffort"] = session.reasoningEffort;
      entries.push({ id: "agent-default-model", config });
    }
    entries.push({
      id: "session-persistence-jsonl",
      config: { root: this.sessionRoot(), compression: "none" },
    });

    // YAML 是 JSON 的超集，直接写 JSON 省掉转义问题
    const body = JSON.stringify(entries, null, 2);
    const key = createHash("sha1")
      .update([session.workingDirectory, configuredModel ?? "", session.reasoningEffort ?? "", this.sessionRoot()].join("\0"))
      .digest("hex")
      .slice(0, 16);
    const dir = join(this.niubotHome(), "dsh", "patches");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${key}.json`);
    if (!existsSync(file) || readFileSync(file, "utf-8") !== body) {
      writeFileSync(file, body, "utf-8");
    }
    return file;
  }

  /** 从 session 日志里补 compact 次数；dsh 的 --json 流不投影 compaction 事件 */
  private scanSessionLog(session: DshSession): void {
    const file = this.getSessionFile(session);
    if (!file) return;
    try {
      const size = statSync(file).size;
      if (size <= session.jsonlOffset) return;
      // 分块读：日志可能有几十 MB，避免一次性 Buffer.alloc 卡住单线程引擎
      const CHUNK = 1 << 20;
      const fd = openSync(file, "r");
      let offset = session.jsonlOffset;
      let pending = "";
      try {
        while (offset < size) {
          const length = Math.min(CHUNK, size - offset);
          const buf = Buffer.alloc(length);
          readSync(fd, buf, 0, length, offset);
          offset += length;
          const lines = (pending + buf.toString("utf-8")).split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) countCompaction(line, session);
        }
      } finally {
        closeSync(fd);
      }
      if (pending) countCompaction(pending, session);
      session.jsonlOffset = size;
    } catch { /* ignore */ }
  }

  private getSessionFile(session: DshSession): string | null {
    if (!session.agentSessionId) return null;

    // 缓存路径也要重选代次：dsh 升级后会把 session 迁移到更高的 vN
    if (session.sessionFile) {
      const latest = pickCurrentGeneration(dirname(session.sessionFile));
      if (latest) {
        session.sessionFile = latest;
        return latest;
      }
    }

    const root = this.sessionRoot();
    const candidates = [
      join(root, encodeProjectDir(session.workingDirectory), session.agentSessionId),
    ];
    // 兜底：cwd 归一化规则变化时按 session id 扫一层
    try {
      for (const dir of readdirSync(root)) {
        if (!dir.startsWith("--")) continue;
        candidates.push(join(root, dir, session.agentSessionId));
      }
    } catch { /* root 还不存在 */ }

    for (const dir of candidates) {
      const file = pickCurrentGeneration(dir);
      if (file) {
        session.sessionFile = file;
        return file;
      }
    }
    return null;
  }

  private readTailLines(file: string, size: number, count: number): string[] {
    const CHUNK = 65536;
    const fd = openSync(file, "r");
    try {
      let offset = size;
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

/** 本轮实际使用的模型：NiuBot 配置优先，其次 DSH_MODEL */
function effectiveModel(session: DshSession): string | undefined {
  return session.model?.trim() || process.env["DSH_MODEL"]?.trim() || undefined;
}

/** 从 `dsh --dump-config` 的输出里取 agent-default-model 的 provider/model */
export function parseAgentDefaultModel(dump: string): { provider: string; model: string } | null {
  const start = dump.indexOf("- id: agent-default-model");
  if (start < 0) return null;
  const rest = dump.slice(start);
  const nextEntry = rest.slice(1).search(/\n-/);
  const block = nextEntry >= 0 ? rest.slice(0, nextEntry + 1) : rest;
  const provider = /^\s+provider:\s*(\S+)\s*$/m.exec(block)?.[1];
  const model = /^\s+model:\s*(\S+)\s*$/m.exec(block)?.[1];
  return provider && model ? { provider, model } : null;
}

/** 部署侧额外 patch 文件（DSH_EXTRA_PATCH，多个用路径分隔符连接） */
function extraPatches(): string[] {
  const raw = process.env["DSH_EXTRA_PATCH"]?.trim();
  if (!raw) return [];
  return raw.split(delimiter).map((item) => item.trim()).filter(Boolean);
}

/** `provider/model` → 拆开；不带斜杠时用默认 provider */
export function splitModel(model: string | undefined): { provider: string; model: string } {
  const raw = model?.trim() ?? "";
  const slash = raw.indexOf("/");
  if (slash > 0) {
    return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
  }
  return { provider: process.env["DSH_PROVIDER"]?.trim() || DEFAULT_PROVIDER, model: raw };
}

/** dsh 的 session 目录命名（与 dsh-session-persistence-jsonl 的 projectKey 一致） */
export function encodeProjectDir(cwd: string): string {
  const value = resolve(cwd);
  if (value.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** 取目录下版本号最高的 session.vN.jsonl */
function pickCurrentGeneration(dir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { file: string; version: number } | null = null;
  for (const name of names) {
    const match = /^session(?:\.v(\d+))?\.jsonl$/.exec(name);
    if (!match) continue;
    const version = match[1] ? Number(match[1]) : 0;
    if (!best || version > best.version) best = { file: join(dir, name), version };
  }
  return best?.file ?? null;
}

function parseEvent(line: string): DshEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as DshEvent;
  } catch {
    return null;
  }
}

/** 一次 compact 只计一次；失败的压缩（compaction/end 带 error）不算 */
function countCompaction(line: string, session: DshSession): void {
  const entry = parseLogEntry(line);
  if (entry?.["type"] !== "compaction/end") return;
  const data = entry["data"] as Record<string, unknown> | undefined;
  if (data?.["error"] !== undefined) return;
  session.compactCount++;
}

function parseLogEntry(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** 把 session 日志行压成 /status 能看的一行 */
function renderActivityLine(line: string): string | null {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = typeof entry["type"] === "string" ? entry["type"] : "";
  const data = entry["data"] as Record<string, unknown> | undefined;
  if (type === "assistant/message") {
    const message = data?.["message"] as { content?: Array<{ type?: string; text?: string }> } | undefined;
    const text = (message?.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    return text ? `assistant: ${truncate(text)}` : null;
  }
  if (type === "tool/call") {
    return `tool: ${String(data?.["name"] ?? "?")} ${truncate(String(data?.["arguments"] ?? ""))}`;
  }
  if (type === "tool/result") {
    const message = data?.["message"] as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
    const text = (message?.content ?? []).map((block) => block.text ?? "").join("");
    return `${message?.isError ? "tool error" : "result"}: ${truncate(text)}`;
  }
  if (type === "turn/end") {
    const reason = data?.["reason"] as { kind?: string } | undefined;
    return `turn end: ${reason?.kind ?? "?"}`;
  }
  return null;
}

function truncate(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}
