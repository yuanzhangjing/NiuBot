/**
 * Agent 后端适配层接口。
 * 换 agent 只需实现 AgentBackend，不改 Core。
 */

/** 模型档位：default 用主力模型，lite 用轻量模型（成本低、速度快） */
export type ModelTier = "default" | "lite";

/** 用户可见错误信息最大长度（字符数），超出则截断 */
export const ERROR_DISPLAY_MAX_LEN = 2000;

export interface SessionConfig {
  /** agent 工作目录 */
  workingDirectory?: string;
  /** 模型档位，不设则用 default */
  modelTier?: ModelTier;
  /** 主模型 ID（覆盖 backend 默认值） */
  model?: string;
  /** 轻量模型 ID（覆盖 backend 默认值） */
  liteModel?: string;
  /** stable system context（backend 在 createSession/buildInput 自行交付；仅 needsStableUserPrefix 时由 pipeline 前缀注入） */
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
  /** IM 平台标识（传递给 agent 环境变量） */
  platform?: string;
  /** 是否为管理员（传递给 agent 环境变量） */
  isAdmin?: boolean;
  /** Bot profile 路径（仅管理员 session 传递给 agent 环境变量） */
  botProfilePath?: string;
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
  /** 模型上下文窗口大小 */
  contextWindow?: number;
  /** 本次调用使用的模型 */
  model?: string;
  /** 累计 compact 次数 */
  compactCount?: number;
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

  /** 更新已存在 session 的模型配置（可选，用于运行时 /model 切换） */
  updateSessionModels?(
    sessionId: string,
    models: { model?: string; liteModel?: string },
  ): void;

  /** 获取 session 累计字节数（可选，用于统计） */
  getCumulativeBytes?(sessionId: string): number;

  /** 获取 agent 侧 session ID（用于持久化，recover 时 resume） */
  getAgentSessionId?(sessionId: string): string | undefined;

  /**
   * stable context 是否由 pipeline 前缀进首条 user（及 compact 后重灌）。
   * false 时 backend 自行交付（如 system prompt、workspace rules）。
   */
  needsStableUserPrefix(): boolean;

  /** 探测模型名是否可用 */
  validateModel(modelName: string): Promise<{ valid: boolean; error?: string }>;
}

// ── Activity Watchdog 相关类型 ──────────────────────────────

export type AgentExecutionStatus =
  | "pending" | "running" | "finished" | "failed" | "cancelled";

export interface AgentSessionActivity {
  status: AgentExecutionStatus;
  startedAt: number;
  lastActiveAt: number;
  lastExitAt?: number;
  /** stdout 流式解析检测到完成事件 */
  completionDetected?: boolean;
  /** 是否正在做上下文压缩 */
  compacting?: boolean;
  /** 当前 exec 的子进程 PID（用于 watchdog kill） */
  pid?: number;
  /** 最近 3 条原始 stdout 行（环形 buffer，供 /progress 卡片展示） */
  recentLines: string[];
  /** 本轮已发送的通知次数（封顶 2 次） */
  notifyCount: number;
  /** 上次通知时间 */
  lastNotifiedAt?: number;
  /** 上次长时间运行提醒时间 */
  lastLongRunningNotifiedAt?: number;
}

/** exec() 流式 hooks，由各 backend 提供 */
export interface ExecHooks {
  /** 每行 stdout 回调（用于早期 session ID 捕获等） */
  onLine?: (line: string) => void;
  /** 判断某行是否为完成事件。返回 true 则标记 completionDetected */
  isComplete?: (line: string) => boolean;
  /** 状态变更回调（如 compacting）。通知上层展示提示 */
  onStatus?: (status: string) => void;
}
