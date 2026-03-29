import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentBackend, AgentSession, AgentResponse, SessionConfig } from "../types.js";
import { createLogger } from "../../logger.js";

const log = createLogger("acp");

export class AcpBackend implements AgentBackend {
  private command: string;
  private process: ChildProcess | null = null;
  private connection: acp.ClientSideConnection | null = null;

  /** 每个 session 的累计输出文本（聚合 agent_message_chunk） */
  private sessionOutputs = new Map<string, string[]>();

  /** 每个 session 的累计字节数 */
  private sessionBytes = new Map<string, number>();

  /** prompt 完成信号 */
  private promptResolvers = new Map<string, {
    resolve: (resp: AgentResponse) => void;
    reject: (err: Error) => void;
  }>();

  constructor(command: string) {
    this.command = command;
  }

  async start(): Promise<void> {
    const [cmd, ...args] = this.command.split(" ");
    if (!cmd) throw new Error("Empty agent command");

    log.info("spawning ACP server", { command: this.command });

    this.process = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.process.on("exit", (code) => {
      log.warn("ACP process exited", { code });
      // 拒绝所有等待中的 prompt
      for (const [sessionId, resolver] of this.promptResolvers) {
        resolver.reject(new Error(`ACP process exited with code ${code}`));
        this.promptResolvers.delete(sessionId);
      }
    });

    const input = Writable.toWeb(this.process.stdin!) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(this.process.stdout!) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const client: acp.Client = {
      requestPermission: async (params) => {
        // M1: 自动批准所有权限请求
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
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.connection = null;
    log.info("ACP backend stopped");
  }

  async createSession(config: SessionConfig): Promise<AgentSession> {
    if (!this.connection) throw new Error("ACP not initialized");

    const session = await this.connection.newSession({
      cwd: config.workingDirectory ?? process.cwd(),
      systemPrompt: config.systemPrompt,
      mcpServers: [],
    });

    const sessionId = session.sessionId;
    this.sessionOutputs.set(sessionId, []);
    this.sessionBytes.set(sessionId, 0);

    log.info("session created", { sessionId });
    return { id: sessionId };
  }

  async sendMessage(session: AgentSession, message: string): Promise<AgentResponse> {
    if (!this.connection) throw new Error("ACP not initialized");

    // 重置输出缓冲
    this.sessionOutputs.set(session.id, []);

    log.info("sending prompt", { sessionId: session.id, textLength: message.length });

    // prompt 是阻塞调用，等 agent 完成整个 turn
    const result = await this.connection.prompt({
      sessionId: session.id,
      prompt: [{ type: "text", text: message }],
    });

    const chunks = this.sessionOutputs.get(session.id) ?? [];
    const text = chunks.join("");

    log.info("prompt completed", {
      sessionId: session.id,
      stopReason: result.stopReason,
      responseLength: text.length,
      cumulativeBytes: this.sessionBytes.get(session.id),
    });

    return { text: text || "(no response)" };
  }

  async cancelSession(session: AgentSession): Promise<void> {
    if (!this.connection) return;

    log.info("cancelling session", { sessionId: session.id });
    await this.connection.cancel({ sessionId: session.id });
  }

  async closeSession(session: AgentSession): Promise<void> {
    // ACP 没有显式 close session，清理本地状态即可
    this.sessionOutputs.delete(session.id);
    this.sessionBytes.delete(session.id);
    log.info("session closed", { sessionId: session.id });
  }

  /** 获取 session 累计字节数 */
  getCumulativeBytes(sessionId: string): number {
    return this.sessionBytes.get(sessionId) ?? 0;
  }

  private handleSessionUpdate(params: acp.SessionNotification): void {
    const { sessionId, update } = params;
    const bytes = JSON.stringify(update).length;

    // 累加字节数
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
