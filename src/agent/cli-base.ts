/**
 * CLI Agent 基类：封装"起子进程、传 prompt、解析输出"的通用逻辑。
 * 新增 CLI agent 只需继承并实现抽象方法。
 */

import { spawn } from "node:child_process";
import type { AgentBackend, AgentSession, AgentResponse, SessionConfig } from "./types.js";
import { createLogger } from "../logger.js";
import { prependNiubotBinToPath } from "../niubot-cli.js";

/** 子类 session 的基础字段 */
export interface BaseCliSession {
  workingDirectory: string;
  model?: string;
  importantContext?: string;
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
}

export abstract class CliAgentBackend<S extends BaseCliSession = BaseCliSession> implements AgentBackend {
  protected sessions = new Map<string, S>();
  protected log;

  /** 默认超时 10 分钟 */
  protected promptTimeoutMs = 10 * 60 * 1000;

  constructor(protected name: string) {
    this.log = createLogger(name);
  }

  // ── 子类必须实现 ──────────────────────────────────────────

  /** CLI 命令名（如 "claude"、"codex"） */
  abstract command(): string;

  /** 构建 CLI 参数（prompt、model、resume 等） */
  abstract buildArgs(session: S, message: string): string[];

  /** 解析 CLI 输出为 text + 可选的 agent session ID */
  abstract parseOutput(stdout: string): ParsedOutput;

  /** 检查 CLI 工具是否可用（start 时调用） */
  abstract checkAvailable(): Promise<void>;

  /** 首次创建 session 时，构造 agent 特有的 session 字段 */
  abstract buildSession(config: SessionConfig): S;

  /** 收到 agent 响应后更新 session 状态（如保存 resume ID） */
  abstract updateSession(session: S, parsed: ParsedOutput): void;

  /** 每次执行子进程时需要额外设置的环境变量 */
  protected agentEnv(): Record<string, string> {
    return {};
  }

  /** 构建 stdin 内容，子类可覆盖（如 stream-json 格式包装） */
  buildStdin(message: string): string {
    return message;
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
    const id = `${this.name}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const session = this.buildSession(config);
    this.sessions.set(id, session);
    this.log.info("session created", { sessionId: id });
    return { id };
  }

  async sendMessage(agentSession: AgentSession, message: string): Promise<AgentResponse> {
    const s = this.sessions.get(agentSession.id);
    if (!s) throw new Error(`Session not found: ${agentSession.id}`);

    const args = this.buildArgs(s, message);

    this.log.info("sending prompt", { sessionId: agentSession.id, textLength: message.length });

    try {
      const stdout = await this.exec(this.command(), args, {
        cwd: s.workingDirectory,
        timeout: this.promptTimeoutMs,
        env: { ...s.extraEnv, ...this.agentEnv() },
        stdin: this.buildStdin(message),
      });

      s.cumulativeBytes += stdout.length;

      const parsed = this.parseOutput(stdout);
      this.updateSession(s, parsed);

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
      if (err.killed) {
        this.log.warn("prompt timed out", { sessionId: agentSession.id });
        return { text: "", cancelled: true };
      }
      throw err;
    }
  }

  async cancelSession(_session: AgentSession): Promise<void> {
    this.log.debug("cancel requested (no-op for CLI mode)", { sessionId: _session.id });
  }

  async closeSession(session: AgentSession): Promise<void> {
    this.sessions.delete(session.id);
    this.log.info("session closed", { sessionId: session.id });
  }

  getCumulativeBytes(sessionId: string): number {
    return this.sessions.get(sessionId)?.cumulativeBytes ?? 0;
  }

  // ── 子进程执行 ───────────────────────────────────────────

  protected exec(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number; env?: Record<string, string>; stdin?: string },
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts?.cwd,
        env: { ...process.env, ...opts?.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const chunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      let timer: ReturnType<typeof setTimeout> | undefined;
      if (opts?.timeout) {
        timer = setTimeout(() => {
          child.kill();
          const err = new Error(`Command timed out after ${opts.timeout}ms`);
          (err as any).killed = true;
          reject(err);
        }, opts.timeout);
      }

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        const stdout = Buffer.concat(chunks).toString();
        const stderr = Buffer.concat(stderrChunks).toString();
        if (code !== 0) {
          const err = new Error(`Command failed: ${cmd} ${args.join(" ")}\n${stderr}`);
          (err as any).stderr = stderr;
          (err as any).code = code;
          reject(err);
        } else {
          resolve(stdout);
        }
      });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
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
  if (config.botName) env["NIUBOT_BOT_NAME"] = config.botName;
  if (config.isAdmin) env["NIUBOT_IS_ADMIN"] = "true";
  if (config.workingDirectory) env["NIUBOT_WORK_DIR"] = config.workingDirectory;
  return env;
}
