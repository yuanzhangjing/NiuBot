/**
 * CLI Agent 基类：封装"起子进程、传 prompt、解析输出"的通用逻辑。
 * 新增 CLI agent 只需继承并实现抽象方法。
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { AgentBackend, AgentSession, AgentResponse, SessionConfig, AgentSessionActivity, ExecHooks } from "./types.js";
import { createLogger } from "../logger.js";
import { prependNiubotBinToPath } from "../niubot-cli.js";
import { createInterface } from "node:readline";

/** 子类 session 的基础字段 */
export interface BaseCliSession {
  workingDirectory: string;
  model?: string;
  importantContext?: string;
  /** agent 侧的 session ID（用于 resume），由基类自动管理 */
  agentSessionId?: string;
  extraEnv: Record<string, string>;
  cumulativeBytes: number;
  /** 累计 compact 次数 */
  compactCount: number;
  /** JSONL 文件上次扫描的字节偏移（用于增量扫描） */
  jsonlOffset: number;
}

/** 子类解析输出后返回的结构 */
export interface ParsedOutput {
  text: string;
  /** agent 侧的 session ID（用于 resume） */
  agentSessionId?: string;
  /** 本次调用的上下文 token 总数 */
  contextTokens?: number;
  /** 模型上下文窗口大小 */
  contextWindow?: number;
  /** 本次调用使用的模型 */
  model?: string;
  /** 累计 compact 次数 */
  compactCount?: number;
}

export abstract class CliAgentBackend<S extends BaseCliSession = BaseCliSession> implements AgentBackend {
  protected sessions = new Map<string, S>();
  private activeProcesses = new Map<string, ChildProcess>();
  private cancelledSessions = new Set<string>();
  /** 每个 session 的活动状态（watchdog 用） */
  private activityMap = new Map<string, AgentSessionActivity>();
  protected log;

  constructor(protected name: string) {
    this.log = createLogger(name);
  }

  /** 获取指定 session 的活动状态（供 watchdog 读取） */
  getActivity(sessionId: string): AgentSessionActivity | undefined {
    return this.activityMap.get(sessionId);
  }

  /** 获取所有活动状态（供 watchdog 遍历） */
  getAllActivities(): ReadonlyMap<string, AgentSessionActivity> {
    return this.activityMap;
  }

  // ── 子类必须实现（4 个） ────────────────────────────────────

  /** CLI 命令名（如 "claude"、"codex"） */
  abstract command(): string;

  /** 首次创建 session 时，构造 agent 特有的 session 字段 */
  abstract buildSession(config: SessionConfig): S;

  /**
   * 构造 CLI 调用：参数 + stdin 内容。
   * - 返回 stdin: 将其写入子进程 stdin
   * - 不返回 stdin: 不写 stdin（子进程 stdin 直接关闭）
   */
  abstract buildInput(session: S, message: string): { args: string[]; stdin?: string };

  /** 解析 CLI 输出 → 结构化结果（可访问 session 获取额外信息） */
  abstract parseOutput(stdout: string, session: S): ParsedOutput;

  // ── 可选 override ───────────────────────────────────────────

  /** 检查 CLI 工具是否可用（start 时调用）。默认执行 command() --version */
  async checkAvailable(): Promise<void> {
    try {
      await this.exec(this.command(), ["--version"]);
      this.log.info(`${this.command()} CLI found`);
    } catch {
      throw new Error(`${this.command()} CLI not found in PATH`);
    }
  }

  /** 每次执行子进程时需要额外设置的环境变量 */
  protected agentEnv(): Record<string, string> {
    return {};
  }

  /** watchdog 调用：返回 session 文件的最新 mtime（毫秒时间戳），null 表示不支持或文件不存在 */
  protected probeSessionFileMtime?(_session: S): number | null;

  /** 子类提供 exec hooks（onLine / isComplete / onStatus） */
  protected getExecHooks?(_session: S): ExecHooks;

  // ── 通用实现 ─────────────────────────────────────────────

  async start(): Promise<void> {
    await this.checkAvailable();
  }

  async stop(): Promise<void> {
    this.sessions.clear();
    this.log.info("backend stopped");
  }

  async createSession(config: SessionConfig): Promise<AgentSession> {
    const id = `${this.name}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const session = this.buildSession(config);
    // 基类统一管理 agentSessionId（recover 时从 config 传入）
    if (config.agentSessionId) {
      session.agentSessionId = config.agentSessionId;
    }
    this.sessions.set(id, session);
    this.log.info("session created", { sessionId: id });
    return { id };
  }

  async sendMessage(agentSession: AgentSession, message: string): Promise<AgentResponse> {
    const s = this.sessions.get(agentSession.id);
    if (!s) throw new Error(`Session not found: ${agentSession.id}`);

    const { args, stdin } = this.buildInput(s, message);
    const mode = s.agentSessionId ? "resume" : "new";

    this.log.info("sending prompt", {
      sessionId: agentSession.id,
      mode,
      agentSessionId: s.agentSessionId ?? null,
      textLength: message.length,
      stdinDefined: stdin !== undefined,
      stdinLength: stdin?.length ?? 0,
    });

    // 初始化 activity（清空上一轮状态）
    const now = Date.now();
    this.activityMap.set(agentSession.id, {
      status: "running",
      startedAt: now,
      lastActiveAt: now,
      completionDetected: false,
      compacting: false,
      notifyCount: 0,
    });

    // 获取子类提供的 hooks
    const hooks = this.getExecHooks?.(s);

    try {
      const stdout = await this.exec(this.command(), args, {
        cwd: s.workingDirectory,
        env: { ...s.extraEnv, ...this.agentEnv() },
        stdin,
      }, agentSession.id, hooks);

      // 更新 activity 状态
      const activity = this.activityMap.get(agentSession.id);

      // 进程可能收到 SIGTERM 后仍以 code 0 退出，检查 cancel 标记
      if (this.cancelledSessions.delete(agentSession.id)) {
        if (activity) activity.status = "cancelled";
        this.log.info("prompt cancelled (process exited gracefully)", { sessionId: agentSession.id });
        return { text: "", cancelled: true };
      }

      if (activity) activity.status = "finished";
      s.cumulativeBytes += stdout.length;

      const parsed = this.parseOutput(stdout, s);
      // 基类自动管理 agentSessionId
      if (parsed.agentSessionId) {
        s.agentSessionId = parsed.agentSessionId;
      }

      this.log.info("prompt completed", {
        sessionId: agentSession.id,
        responseLength: parsed.text.length,
        cumulativeBytes: s.cumulativeBytes,
      });

      return {
        text: parsed.text,
        contextTokens: parsed.contextTokens,
        contextWindow: parsed.contextWindow,
        model: parsed.model,
        compactCount: s.compactCount || undefined,
      };
    } catch (err: any) {
      const activity = this.activityMap.get(agentSession.id);
      if (this.cancelledSessions.delete(agentSession.id)) {
        if (activity) activity.status = "cancelled";
        this.log.warn("prompt cancelled", { sessionId: agentSession.id });
        return { text: "", cancelled: true };
      }
      if (activity) activity.status = "failed";
      throw err;
    }
  }

  async cancelSession(session: AgentSession): Promise<void> {
    const child = this.activeProcesses.get(session.id);
    if (child) {
      this.cancelledSessions.add(session.id);
      child.kill("SIGTERM");
      this.log.info("cancel: sent SIGTERM to child process", { sessionId: session.id, pid: child.pid });
    } else {
      this.log.info("cancel: no active process to kill", { sessionId: session.id });
    }
  }

  async closeSession(session: AgentSession): Promise<void> {
    this.sessions.delete(session.id);
    this.log.info("session closed", { sessionId: session.id });
  }

  getAgentSessionId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.agentSessionId;
  }

  getCumulativeBytes(sessionId: string): number {
    return this.sessions.get(sessionId)?.cumulativeBytes ?? 0;
  }

  // ── 子进程执行 ───────────────────────────────────────────

  protected exec(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string>; stdin?: string },
    sessionId?: string,
    hooks?: ExecHooks,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const stdinDefined = opts?.stdin !== undefined;
      const stdinLength = opts?.stdin?.length ?? 0;
      const stdinPreview = summarizeForLog(opts?.stdin, 120);
      this.log.debug("spawning child process", {
        sessionId: sessionId ?? null,
        cmd,
        args,
        cwd: opts?.cwd ?? process.cwd(),
        stdinDefined,
        stdinLength,
        stdinPreview,
      });

      const child = spawn(cmd, args, {
        cwd: opts?.cwd,
        env: { ...process.env, ...opts?.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (sessionId) {
        this.activeProcesses.set(sessionId, child);
        // 记录 PID 到 activity（供 watchdog 使用）
        const activity = this.activityMap.get(sessionId);
        if (activity) activity.pid = child.pid;
      }

      const lines: string[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let earlyResolveAt: number | undefined;

      // ── 流式逐行读取 stdout ──
      if (hooks) {
        const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
        rl.on("line", (line) => {
          lines.push(line);
          // 更新活动时间
          if (sessionId) {
            const a = this.activityMap.get(sessionId);
            if (a) a.lastActiveAt = Date.now();
          }
          // compact 检测（通用：所有 backend 共享）
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "system" && parsed.subtype === "status" && parsed.status === "compacting") {
              if (sessionId) {
                const a = this.activityMap.get(sessionId);
                if (a) a.compacting = true;
              }
              hooks.onStatus?.("compacting");
            } else {
              // 收到非 compact 事件，清除 compacting 标记
              if (sessionId) {
                const a = this.activityMap.get(sessionId);
                if (a && a.compacting) a.compacting = false;
              }
            }
          } catch {
            // 非 JSON 行，清除 compacting
            if (sessionId) {
              const a = this.activityMap.get(sessionId);
              if (a && a.compacting) a.compacting = false;
            }
          }
          // 回调
          hooks.onLine?.(line);
          // 完成检测 → 立即 resolve，不等进程退出
          if (hooks.isComplete?.(line)) {
            if (sessionId) {
              const a = this.activityMap.get(sessionId);
              if (a) a.completionDetected = true;
            }
            if (!settled) {
              settled = true;
              earlyResolveAt = Date.now();
              const stdout = lines.join("\n");
              this.log.info("completion detected, resolving immediately", {
                sessionId: sessionId ?? null,
                linesCollected: lines.length,
                stdoutLength: stdout.length,
                elapsedMs: earlyResolveAt - startedAt,
              });
              resolve(stdout);
              // 进程继续在后台运行，等它自行退出；退不了的由 watchdog 收尸
            }
          }
        });
      } else {
        // 无 hooks 时退化为 buffer 模式（兼容 checkAvailable 等非业务调用）
        child.stdout.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
      }

      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
        // stderr 也更新活动时间
        if (sessionId) {
          const a = this.activityMap.get(sessionId);
          if (a) a.lastActiveAt = Date.now();
        }
      });

      child.on("close", (code, signal) => {
        const durationMs = Date.now() - startedAt;

        // 已经在收到 result 时提前 resolve 了，这里只做清理
        if (settled) {
          const afterResolveMs = earlyResolveAt ? Date.now() - earlyResolveAt : undefined;
          if (sessionId) {
            // 只清理自己的 activeProcesses 条目（新请求可能已覆盖为新进程）
            if (this.activeProcesses.get(sessionId) === child) {
              this.activeProcesses.delete(sessionId);
            }
            // 清理 watchdog kill 留下的 cancel 标记，防止污染下次请求
            this.cancelledSessions.delete(sessionId);
          }
          this.log.info("child process exited after early resolve", {
            sessionId: sessionId ?? null,
            code,
            signal: signal ?? null,
            durationMs,
            afterResolveMs,
          });
          return;
        }

        // 未提前 resolve → 正常的退出处理
        if (sessionId) this.activeProcesses.delete(sessionId);
        const stdout = hooks ? lines.join("\n") : lines.join("");
        const stderr = Buffer.concat(stderrChunks).toString();
        const stdoutTail = tailForLog(stdout, 6);
        const stderrTail = tailForLog(stderr, 6);
        if (code !== 0) {
          this.log.error("child process failed", {
            sessionId: sessionId ?? null,
            cmd,
            args,
            code,
            signal: signal ?? null,
            durationMs,
            stdinDefined,
            stdinLength,
            stdinPreview,
            stdoutLength: stdout.length,
            stderrLength: stderr.length,
            stdoutTail,
            stderrTail,
          });
          const err = new Error(`Command failed: ${cmd} (exit ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`);
          (err as any).stdout = stdout;
          (err as any).stderr = stderr;
          (err as any).code = code;
          reject(err);
        } else {
          this.log.debug("child process completed", {
            sessionId: sessionId ?? null,
            cmd,
            args,
            code,
            signal: signal ?? null,
            durationMs,
            stdinDefined,
            stdinLength,
            stdoutLength: stdout.length,
            stderrLength: stderr.length,
          });
          resolve(stdout);
        }
      });

      child.on("error", (err) => {
        if (sessionId) {
          if (this.activeProcesses.get(sessionId) === child) {
            this.activeProcesses.delete(sessionId);
          }
        }
        if (settled) {
          this.log.warn("child process error after early resolve", {
            sessionId: sessionId ?? null,
            error: String(err),
          });
          return;
        }
        this.log.error("child process spawn error", {
          sessionId: sessionId ?? null,
          cmd,
          args,
          stdinDefined,
          stdinLength,
          stdinPreview,
          error: String(err),
        });
        reject(err);
      });

      if (stdinDefined) {
        child.stdin.write(opts?.stdin ?? "", (err) => {
          if (err) {
            this.log.error("stdin write failed", {
              sessionId: sessionId ?? null,
              cmd,
              args,
              stdinLength,
              error: String(err),
            });
          } else {
            this.log.debug("stdin write completed", {
              sessionId: sessionId ?? null,
              cmd,
              args,
              stdinLength,
            });
          }
        });
        child.stdin.end();
      } else {
        child.stdin.end();
      }
    });
  }
}

function summarizeForLog(text: string | undefined, maxLen: number): string {
  if (text === undefined) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

function tailForLog(text: string, maxLines: number): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-maxLines)
    .join("\n");
}

/** 从 SessionConfig 构造 NiuBot CLI 工具需要的环境变量 */
export function buildNiubotEnv(config: SessionConfig): Record<string, string> {
  const env: Record<string, string> = {};
  env["PATH"] = prependNiubotBinToPath();
  if (config.userId) env["NIUBOT_USER_ID"] = config.userId;
  if (config.chatId) env["NIUBOT_CHAT_ID"] = config.chatId;
  if (config.chatType) env["NIUBOT_CHAT_TYPE"] = config.chatType;
  if (config.dbPath) env["NIUBOT_DB_PATH"] = config.dbPath;
  if (config.botId) env["NIUBOT_BOT_ID"] = config.botId;
  if (config.isAdmin) env["NIUBOT_IS_ADMIN"] = "true";
  if (config.workingDirectory) env["NIUBOT_WORK_DIR"] = config.workingDirectory;
  return env;
}
