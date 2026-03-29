/**
 * Agent 后端适配层接口。
 * 换 agent 只需实现 AgentBackend，不改 Core。
 */

export interface SessionConfig {
  systemPrompt: string;
  workingDirectory?: string;
}

export interface AgentSession {
  id: string;
}

export interface AgentResponse {
  text: string;
  filesChanged?: string[];
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
}
