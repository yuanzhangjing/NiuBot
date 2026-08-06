/**
 * Goal 模式（纯内存版）——第一阶段最小闭环。
 *
 * 一个 Goal = 同一个 Run 内主 Agent 连续多轮执行，直到 Agent 调用
 * `nbt goal finish` 显式结束。无 DB、无恢复；重启即断（重启重置语义）。
 */

/** Goal 结局（结束原因分类）。 */
export type GoalOutcome = "achieved" | "not_achieved" | "stopped" | "failed";

/** 进行中的 Goal（内存对象）。 */
export interface ActiveGoal {
  /** 目标原文（/goal <目标> 的输入） */
  objective: string;
  /** 创建者用户 ID（群聊控制权限用） */
  userId: string;
  /** 已执行的外层轮次（每轮 = 一次 backend 调用 = 一个 agent turn） */
  turnCount: number;
  /** 开始时间 */
  startedAt: number;
  /** 结束时间（未结束时 undefined） */
  endedAt?: number;
  /** 结束结局 */
  outcome?: GoalOutcome;
  /** 结束结论（Agent 在 finish 里给出，落库摘要） */
  conclusion?: string;
  /** 调用 finish 的轮次上下文（校验令牌 + Run ID 一致性） */
  finishRunId?: string;
  /** 本轮 Agent 回合是否请求了结束（finish 令牌校验通过后置位） */
  finishRequested?: boolean;
}

/** Goal 结束请求（Agent 通过 nbt goal finish 提交）。 */
export interface GoalFinishCommand {
  /** 令牌：只注入当前 Goal 的主 Agent Session，防跨会话借用 */
  token: string;
  outcome: "achieved" | "not_achieved";
  conclusion?: string;
}

export interface GoalFinishRequest {
  chatId: string;
  command: GoalFinishCommand;
  scheduleToken?: string;
}

export interface GoalCommandResult {
  output: string;
}

/** 对外 API 处理器接口（core/api.ts 路由用）。 */
export interface GoalApiHandler {
  executeGoalFinishCommand(chatId: string, command: GoalFinishCommand, token?: string): Promise<GoalCommandResult>;
}

/** Goal 阶段参数（可配置默认值）。 */
export const GOAL_DEFAULTS = {
  /** 连续 backend 失败上限 → 结束为 failed */
  maxConsecutiveFailures: 3,
  /** 最大外层轮次 → 结束为 failed（值设宽，正常任务到不了，防失控兜底） */
  maxTurns: 100,
  /** 目标长度上限 */
  maxObjectiveLength: 4000,
  /** 全局并发 Goal 上限 */
  maxConcurrentGoals: 2,
} as const;
