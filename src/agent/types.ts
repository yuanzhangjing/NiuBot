/**
 * Agent 后端适配层接口。
 * 换 agent 只需实现 AgentBackend，不改 Core。
 */

/** 模型档位：default 用主力模型，lite 用轻量模型（成本低、速度快） */
export type ModelTier = "default" | "lite";

export interface SessionConfig {
  /** agent 工作目录 */
  workingDirectory?: string;
  /** 模型档位，不设则用 default */
  modelTier?: ModelTier;
  /** 轻量模型 ID（覆盖 backend 默认值） */
  liteModel?: string;
  /** important 上下文（通过 system prompt 注入） */
  importantContext?: string;
  /** 当前用户 ID（传递给 agent 环境变量） */
  userId?: string;
  /** 当前会话 ID（传递给 agent 环境变量） */
  chatId?: string;
  /** 当前会话类型（传递给 agent 环境变量） */
  chatType?: "p2p" | "group";
  /** 数据库路径（传递给 agent 环境变量，确保 CLI 工具访问正确的数据库） */
  dbPath?: string;
  /** Bot ID（传递给 agent 环境变量） */
  botId?: string;
  /** Bot 名称（传递给 agent 环境变量） */
  botName?: string;
  /** 是否为管理员（传递给 agent 环境变量） */
  isAdmin?: boolean;
  /** Agent 侧 session ID（用于 recover 时 resume） */
  agentSessionId?: string;
}

export interface AgentSession {
  id: string;
}

export interface AgentResponse {
  text: string;
  cancelled?: boolean;
  filesChanged?: string[];
  /** 本次调用的上下文 token 总数 */
  contextTokens?: number;
  /** 本次调用使用的模型 */
  model?: string;
}

export interface AgentBackend {
  /** 启动后端（spawn 进程等） */
  start(): Promise<void>;

  /** 停止后端 */
  stop(): Promise<void>;

  /** 创建 agent session */
  createSession(config: SessionConfig): Promise<AgentSession>;

  /** 发送消息，等待完整响应（非流式） */
  sendMessage(
    session: AgentSession,
    message: string,
  ): Promise<AgentResponse>;

  /** 取消当前执行 */
  cancelSession(session: AgentSession): Promise<void>;

  /** 关闭 session */
  closeSession(session: AgentSession): Promise<void>;

  /** 获取 session 累计字节数（可选，用于统计） */
  getCumulativeBytes?(sessionId: string): number;

  /** 获取 agent 侧 session ID（用于持久化，recover 时 resume） */
  getAgentSessionId?(sessionId: string): string | undefined;

  /** 是否支持 system prompt 注入 */
  supportsSystemPrompt?: boolean;
}
