/**
 * CLI Agent 基类：封装"起子进程、传 prompt、解析输出"的通用逻辑。
 * 新增 CLI agent 只需继承并实现抽象方法。
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { AgentBackend, AgentSession, AgentResponse, SessionConfig } from "./types.js";
import { createLogger } from "../logger.js";
import { prependNiubotBinToPath } from "../niubot-cli.js";

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
  protected log;

  constructor(protected name: string) {
    this.log = createLogger(name);
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

    this.log.info("sending prompt", { sessionId: agentSession.id, textLength: message.length });

    try {
      const stdout = await this.exec(this.command(), args, {
        cwd: s.workingDirectory,
        env: { ...s.extraEnv, ...this.agentEnv() },
        stdin,
      }, agentSession.id);

      // 进程可能收到 SIGTERM 后仍以 code 0 退出，检查 cancel 标记
      if (this.cancelledSessions.delete(agentSession.id)) {
        this.log.info("prompt cancelled (process exited gracefully)", { sessionId: agentSession.id });
        return { text: "", cancelled: true };
      }

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
      if (this.cancelledSessions.delete(agentSession.id)) {
        this.log.warn("prompt cancelled", { sessionId: agentSession.id });
        return { text: "", cancelled: true };
      }
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
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts?.cwd,
        env: { ...process.env, ...opts?.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (sessionId) this.activeProcesses.set(sessionId, child);

      const chunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      child.on("close", (code) => {
        if (sessionId) this.activeProcesses.delete(sessionId);
        const stdout = Buffer.concat(chunks).toString();
        const stderr = Buffer.concat(stderrChunks).toString();
        if (code !== 0) {
          const details = stderr || stdout;
          const err = new Error(`Command failed: ${cmd} ${args.join(" ")}\n${details}`);
          (err as any).stdout = stdout;
          (err as any).stderr = stderr;
          (err as any).code = code;
          reject(err);
        } else {
          resolve(stdout);
        }
      });

      child.on("error", (err) => {
        if (sessionId) this.activeProcesses.delete(sessionId);
        reject(err);
      });

      if (opts?.stdin) {
        child.stdin.write(opts.stdin);
        child.stdin.end();
      } else {
        child.stdin.end();
      }
    });
  }
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
