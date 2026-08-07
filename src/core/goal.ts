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
  /** 调用 finish 的轮次上下文（Run ID 一致性） */
  finishRunId?: string;
  /** 本轮 Agent 回合是否请求了结束（finish 校验通过后置位） */
  finishRequested?: boolean;
  /** 启动回合的 Run ID（Agent 通过 nbt goal start 主动进入时记录，用于当前回合并入第 1 轮） */
  startRunId?: string;
  /** 中间轮进展步骤（nbt goal progress 记录，保留最近 N 条细节，一两句话） */
  progressSteps: string[];
  /** 全局进展状态（nbt goal progress --status 覆盖更新：任务整体进行到哪、还剩什么） */
  progressStatus: string;
  /** Goal 从 Worker 验收回合接管时消费的 Continuation ID 列表（结算时标记完成，防重复投递） */
  adoptedContinuationIds?: string[];
}

/**
 * Goal 结束请求（Agent 通过 nbt goal finish 提交）。
 *
 * 无令牌：请求自动携带 chatId（agent 进程 env 注入），引擎校验该 chat 的
 * active Goal 与运行状态即视为本 Goal 的 Agent 行为；一个 chat 一个 Goal，
 * 进程级隔离由 chatId 承担。
 */
export interface GoalFinishCommand {
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
  /** Agent 主动进入 Goal 模式：创建 Goal 并把当前回合计入第 1 轮 */
  executeGoalStartCommand(chatId: string, objective: string, token?: string): Promise<GoalCommandResult>;
  /** 主 Agent Goal progress 操作：中间轮静默记录进展（步骤 + 全局状态，随每轮注入）。 */
  executeGoalProgressCommand(chatId: string, content: string, status?: string): Promise<GoalCommandResult>;
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
  /** progress 步骤细节保留条数（最近 N 条） */
  maxProgressSteps: 10,
  /** progress 单条步骤/全局状态长度上限（防注入膨胀） */
  maxProgressLength: 500,
} as const;
