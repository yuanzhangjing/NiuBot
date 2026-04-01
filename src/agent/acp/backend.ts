import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentBackend, AgentSession, AgentResponse, SessionConfig } from "../types.js";
import { createLogger } from "../../logger.js";

const log = createLogger("acp");

/** prompt 超时时间（ms），防止 agent 卡死 */
const PROMPT_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟

const DEFAULT_LITE_MODEL = "claude-haiku-4-5-20251001";

export class AcpBackend implements AgentBackend {
  private command: string;
  private permissionMode: "bypass" | "autoApprove";
  private liteModel: string;
  private process: ChildProcess | null = null;
  private connection: acp.ClientSideConnection | null = null;

  /** 每个 session 的累计输出文本（聚合 agent_message_chunk） */
  private sessionOutputs = new Map<string, string[]>();

  /** 每个 session 的累计字节数 */
  private sessionBytes = new Map<string, number>();

  /** 每个 session 的 important 上下文（ACP 不支持 system prompt，拼到首条消息前缀） */
  private sessionImportantContext = new Map<string, string>();

  /** 记录每个 session 是否已发送过消息（用于判断是否需要拼前缀） */
  private sessionFirstMessage = new Set<string>();

  /** ACP 模式不支持 system prompt 注入 */
  readonly supportsSystemPrompt = false;

  constructor(command: string, permissionMode: "bypass" | "autoApprove" = "autoApprove", liteModel?: string) {
    this.command = command;
    this.permissionMode = permissionMode;
    this.liteModel = liteModel ?? DEFAULT_LITE_MODEL;
  }

  async start(): Promise<void> {
    log.info("spawning ACP server", { command: this.command });

    this.process = spawn(this.command, {
      stdio: ["pipe", "pipe", "inherit"],
      shell: true,
    });

    this.process.on("exit", (code) => {
      log.error("ACP process exited unexpectedly", { code });
      this.connection = null;
      // ACP 进程崩溃后 bot 无法工作，主动退出让 supervisor 重启
      if (code !== 0 && code !== null) {
        log.error("ACP crash is fatal, exiting process for supervisor restart");
        process.exit(1);
      }
    });

    const input = Writable.toWeb(this.process.stdin!) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(this.process.stdout!) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const client: acp.Client = {
      requestPermission: async (params) => {
        log.debug("auto-approving permission", { tool: params.title });
        return {
          outcome: { outcome: "selected", optionId: params.options[0]!.optionId },
        };
      },
      sessionUpdate: async (params) => {
        this.handleSessionUpdate(params);
      },
    };

    this.connection = new acp.ClientSideConnection((_agent) => client, stream);

    const initResult = await this.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    log.info("ACP initialized", {
      serverName: initResult.serverInfo?.name,
      protocolVersion: initResult.protocolVersion,
    });
  }

  async stop(): Promise<void> {
    this.connection = null;
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    log.info("ACP backend stopped");
  }

  async createSession(config: SessionConfig): Promise<AgentSession> {
    if (!this.connection) throw new Error("ACP not initialized");

    const session = await this.connection.newSession({
      cwd: config.workingDirectory ?? process.cwd(),
      mcpServers: [],
    });

    const sessionId = session.sessionId;
    this.sessionOutputs.set(sessionId, []);
    this.sessionBytes.set(sessionId, 0);

    // 保存 important 上下文，在首条消息时拼到前缀
    if (config.importantContext) {
      this.sessionImportantContext.set(sessionId, config.importantContext);
    }
    this.sessionFirstMessage.add(sessionId);

    if (this.permissionMode === "bypass") {
      try {
        await this.connection!.setSessionMode({
          sessionId,
          modeId: "bypassPermissions",
        });
        log.info("session created with bypassPermissions", { sessionId });
      } catch (err) {
        log.warn("failed to set bypassPermissions, falling back to autoApprove", {
          sessionId,
          error: String(err),
        });
      }
    } else {
      log.info("session created with autoApprove", { sessionId });
    }

    // 设置模型档位（如有指定，per-session liteModel 优先于 backend 默认值）
    const model = config.modelTier === "lite" ? (config.liteModel ?? this.liteModel) : undefined;
    if (model) {
      try {
        await this.connection!.unstable_setSessionModel({
          sessionId,
          modelId: model,
        });
        log.info("session model set", { sessionId, model });
      } catch (err) {
        log.warn("failed to set session model, using default", {
          sessionId,
          model,
          error: String(err),
        });
      }
    }

    return { id: sessionId };
  }

  async sendMessage(session: AgentSession, message: string): Promise<AgentResponse> {
    if (!this.connection) throw new Error("ACP not initialized");

    // 首条消息：拼接 important 上下文前缀
    let finalMessage = message;
    if (this.sessionFirstMessage.has(session.id)) {
      this.sessionFirstMessage.delete(session.id);
      const importantContext = this.sessionImportantContext.get(session.id);
      if (importantContext) {
        finalMessage = `<system-context>\n${importantContext}\n</system-context>\n\n${message}`;
        this.sessionImportantContext.delete(session.id);
      }
    }

    // 重置输出缓冲
    this.sessionOutputs.set(session.id, []);

    log.info("sending prompt", { sessionId: session.id, textLength: finalMessage.length });

    // prompt + 超时保护（清理 timer 防止泄漏）
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Prompt timed out after ${PROMPT_TIMEOUT_MS / 1000}s`)),
        PROMPT_TIMEOUT_MS,
      );
    });

    let result: Awaited<ReturnType<acp.ClientSideConnection["prompt"]>>;
    try {
      result = await Promise.race([
        this.connection.prompt({
          sessionId: session.id,
          prompt: [{ type: "text", text: finalMessage }],
        }),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timer!);
    }

    const chunks = this.sessionOutputs.get(session.id) ?? [];
    const text = chunks.join("").trim();

    log.info("prompt completed", {
      sessionId: session.id,
      stopReason: result.stopReason,
      responseLength: text.length,
      cumulativeBytes: this.sessionBytes.get(session.id),
    });

    const cancelled = result.stopReason === "cancelled";
    return { text: text || (cancelled ? "" : "(no response)"), cancelled };
  }

  async cancelSession(session: AgentSession): Promise<void> {
    if (!this.connection) return;

    log.info("cancelling session", { sessionId: session.id });
    await this.connection.cancel({ sessionId: session.id });
  }

  async closeSession(session: AgentSession): Promise<void> {
    this.sessionOutputs.delete(session.id);
    this.sessionBytes.delete(session.id);
    this.sessionImportantContext.delete(session.id);
    this.sessionFirstMessage.delete(session.id);
    log.info("session closed", { sessionId: session.id });
  }

  /** 获取 session 累计字节数 */
  getCumulativeBytes(sessionId: string): number {
    return this.sessionBytes.get(sessionId) ?? 0;
  }

  private handleSessionUpdate(params: acp.SessionNotification): void {
    const { sessionId, update } = params;
    const bytes = JSON.stringify(update).length;

    this.sessionBytes.set(sessionId, (this.sessionBytes.get(sessionId) ?? 0) + bytes);

    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type === "text") {
        const chunks = this.sessionOutputs.get(sessionId);
        if (chunks) chunks.push(update.content.text);
      }
    } else if (update.sessionUpdate === "tool_call") {
      log.debug("tool call", { sessionId, title: update.title });
    } else if (update.sessionUpdate === "tool_call_update") {
      log.debug("tool call update", { sessionId, status: update.status });
    }
  }
}
