import { execFile } from "node:child_process";
import type { AgentBackend, AgentSession, AgentResponse, SessionConfig } from "../types.js";
import { createLogger } from "../../logger.js";

const log = createLogger("claude-cli");

/** prompt 超时时间（ms） */
const PROMPT_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟

const DEFAULT_LITE_MODEL = "claude-haiku-4-5-20251001";

interface CliSession {
  /** Claude Code session ID（首次调用后由 CLI 生成） */
  claudeSessionId?: string;
  workingDirectory: string;
  model?: string;
  /** important 上下文，通过 --append-system-prompt 注入 */
  importantContext?: string;
  /** 传递给 agent 进程的额外环境变量 */
  extraEnv: Record<string, string>;
  cumulativeBytes: number;
}

export class ClaudeCliBackend implements AgentBackend {
  private permissionMode: string;
  private liteModel: string;
  private sessions = new Map<string, CliSession>();

  /** CLI 模式支持 system prompt 注入 */
  readonly supportsSystemPrompt = true;

  constructor(permissionMode = "bypassPermissions", liteModel?: string) {
    this.permissionMode = permissionMode;
    this.liteModel = liteModel ?? DEFAULT_LITE_MODEL;
  }

  async start(): Promise<void> {
    // 验证 claude CLI 存在
    try {
      await execPromise("claude", ["--version"]);
      log.info("claude CLI found");
    } catch {
      throw new Error("claude CLI not found in PATH");
    }
  }

  async stop(): Promise<void> {
    this.sessions.clear();
    log.info("claude-cli backend stopped");
  }

  async createSession(config: SessionConfig): Promise<AgentSession> {
    const id = `cli_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    const extraEnv: Record<string, string> = {};
    if (config.userId) extraEnv["NIUBOT_USER_ID"] = config.userId;
    if (config.chatId) extraEnv["NIUBOT_CHAT_ID"] = config.chatId;
    if (config.chatType) extraEnv["NIUBOT_CHAT_TYPE"] = config.chatType;
    if (config.dbPath) extraEnv["NIUBOT_DB_PATH"] = config.dbPath;
    if (config.botId) extraEnv["NIUBOT_BOT_ID"] = config.botId;
    if (config.botName) extraEnv["NIUBOT_BOT_NAME"] = config.botName;

    this.sessions.set(id, {
      workingDirectory: config.workingDirectory ?? process.cwd(),
      model: config.modelTier === "lite" ? (config.liteModel ?? this.liteModel) : undefined,
      importantContext: config.importantContext,
      extraEnv,
      cumulativeBytes: 0,
    });

    log.info("session created", { sessionId: id });
    return { id };
  }

  async sendMessage(session: AgentSession, message: string): Promise<AgentResponse> {
    const s = this.sessions.get(session.id);
    if (!s) throw new Error(`Session not found: ${session.id}`);

    const args = [
      "-p", message,
      "--output-format", "json",
      "--permission-mode", this.permissionMode,
    ];

    if (s.model) {
      args.push("--model", s.model);
    }

    if (s.importantContext) {
      args.push("--append-system-prompt", s.importantContext);
    }

    if (s.claudeSessionId) {
      args.push("--resume", s.claudeSessionId);
    }

    log.info("sending prompt", { sessionId: session.id, textLength: message.length, resume: !!s.claudeSessionId });

    try {
      const result = await execPromise("claude", args, {
        cwd: s.workingDirectory,
        timeout: PROMPT_TIMEOUT_MS,
        env: s.extraEnv,
      });

      s.cumulativeBytes += result.length;

      // 解析 JSON 输出
      let text = result;
      let sessionId: string | undefined;

      try {
        const parsed = JSON.parse(result) as {
          result?: string;
          session_id?: string;
          is_error?: boolean;
        };
        text = (parsed.result ?? result).trim();
        sessionId = parsed.session_id;
      } catch {
        // 非 JSON 输出，直接使用原始文本
      }

      // 保存 session ID 供后续 resume
      if (sessionId) {
        s.claudeSessionId = sessionId;
      }

      log.info("prompt completed", {
        sessionId: session.id,
        claudeSessionId: s.claudeSessionId,
        responseLength: text.length,
        cumulativeBytes: s.cumulativeBytes,
      });

      return { text };
    } catch (err: any) {
      if (err.killed) {
        log.warn("prompt timed out", { sessionId: session.id });
        return { text: "", cancelled: true };
      }
      throw err;
    }
  }

  async cancelSession(_session: AgentSession): Promise<void> {
    // -p 模式每次是独立进程，无法 cancel 正在运行的进程
    // pipeline 层面的 cancel 会在 queue 层处理
    log.debug("cancel requested (no-op for CLI mode)", { sessionId: _session.id });
  }

  async closeSession(session: AgentSession): Promise<void> {
    this.sessions.delete(session.id);
    log.info("session closed", { sessionId: session.id });
  }

  getCumulativeBytes(sessionId: string): number {
    return this.sessions.get(sessionId)?.cumulativeBytes ?? 0;
  }
}

/** execFile 的 Promise 封装 */
function execPromise(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number; env?: Record<string, string> },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd: opts?.cwd,
      timeout: opts?.timeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: {
        ...process.env,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        ...opts?.env,
      },
    }, (err, stdout, stderr) => {
      if (err) {
        (err as any).stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}
