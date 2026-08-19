import { TZ } from "../tz.js";
import { validateCronExpression } from "./cron.js";

/**
 * 统一调度命令：触发参数（every/at/after/cron）与会话模式（main/isolated）正交，全部组合可用。
 * - mode 只决定上下文：main=复用当前聊天主会话，isolated=每次独立会话
 * - trigger 只决定何时执行：every=循环，at=定时一次，after=延迟一次，cron=日历表达式
 */
export type ScheduleTrigger = "every" | "at" | "after" | "cron";
export type ScheduleMode = "main" | "isolated";

export interface CreateScheduleCommand {
  type: "create.schedule";
  mode: ScheduleMode;
  trigger: ScheduleTrigger;
  prompt: string;
  /** trigger=every：循环间隔（秒） */
  intervalSeconds?: number;
  /** trigger=at：本地时间（如 "2026-08-05 18:00"） */
  at?: string;
  /** trigger=after：延迟秒数 */
  afterSeconds?: number;
  /** trigger=cron：5 段表达式 */
  cronExpr?: string;
  description?: string;
  maxTimes?: number;
  durationSeconds?: number;
  untilTime?: string;
  timeZone?: string;
}

export type ScheduleAgentCommand =
  | CreateScheduleCommand
  | {
      type: "cancel";
      scheduleId: string;
    };

export interface ScheduleAgentCommandResult {
  output: string;
}

/**
 * 解析调度命令并归一化：旧格式 create.loop / create.cron 兼容映射到 create.schedule。
 */
export function parseScheduleAgentCommand(value: unknown): ScheduleAgentCommand {
  if (!value || typeof value !== "object") throw new Error("调度命令必须是对象");
  const command = value as Record<string, unknown>;
  switch (command.type) {
    case "create.schedule":
      return parseCreateSchedule(command);
    case "create.loop": {
      // 兼容旧格式：等价于 mode=main + trigger=every
      requireString(command.prompt, "prompt");
      requirePositiveInteger(command.intervalSeconds, "intervalSeconds");
      optionalPositiveInteger(command.maxTimes, "maxTimes");
      optionalPositiveInteger(command.durationSeconds, "durationSeconds");
      return {
        type: "create.schedule",
        mode: "main",
        trigger: "every",
        intervalSeconds: command.intervalSeconds,
        prompt: command.prompt,
        maxTimes: command.maxTimes,
        durationSeconds: command.durationSeconds,
        timeZone: TZ,
      };
    }
    case "create.cron": {
      // 兼容旧格式：等价于 mode=isolated + trigger=cron|at
      requireString(command.prompt, "prompt");
      optionalString(command.cronExpr, "cronExpr");
      optionalString(command.runAt, "runAt");
      optionalString(command.description, "description");
      optionalString(command.untilTime, "untilTime");
      optionalString(command.timeZone, "timeZone");
      optionalPositiveInteger(command.maxTimes, "maxTimes");
      if ((command.cronExpr ? 1 : 0) + (command.runAt ? 1 : 0) !== 1) {
        throw new Error("Cron 必须且只能提供 cronExpr 或 runAt");
      }
      return {
        type: "create.schedule",
        mode: "isolated",
        trigger: command.cronExpr ? "cron" : "at",
        cronExpr: command.cronExpr,
        at: command.runAt,
        prompt: command.prompt,
        description: command.description,
        maxTimes: command.maxTimes,
        untilTime: command.untilTime,
        timeZone: TZ,
      };
    }
    case "cancel":
      requireString(command.scheduleId, "scheduleId");
      return { type: "cancel", scheduleId: command.scheduleId };
    default:
      throw new Error(`未知调度操作: ${String(command.type)}`);
  }
}

/** 归一化会话模式：新名 current_session/new_session（直白），兼容名 main/isolated、旧名 loop/cron。 */
export function normalizeScheduleMode(value: unknown): ScheduleMode {
  if (value === "main" || value === "loop" || value === "current_session") return "main";
  if (value === "isolated" || value === "cron" || value === "new_session") return "isolated";
  throw new Error("mode 必须是 current_session（当前对话）或 new_session（新开会话）");
}

function parseCreateSchedule(command: Record<string, unknown>): CreateScheduleCommand {
  requireString(command.prompt, "prompt");
  const mode = normalizeScheduleMode(command.mode);
  const trigger = command.trigger;
  if (trigger !== "every" && trigger !== "at" && trigger !== "after" && trigger !== "cron") {
    throw new Error("trigger 必须是 every、at、after 或 cron");
  }
  let intervalSeconds: number | undefined;
  let at: string | undefined;
  let afterSeconds: number | undefined;
  let cronExpr: string | undefined;
  switch (trigger) {
    case "every": {
      const value = command.intervalSeconds;
      requirePositiveInteger(value, "intervalSeconds");
      intervalSeconds = value;
      break;
    }
    case "at": {
      const value = command.at;
      requireString(value, "at");
      at = value;
      break;
    }
    case "after": {
      const value = command.afterSeconds;
      requirePositiveInteger(value, "afterSeconds");
      afterSeconds = value;
      break;
    }
    case "cron": {
      const value = command.cronExpr;
      requireString(value, "cronExpr");
      validateCronExpression(value);
      cronExpr = value;
      break;
    }
  }
  optionalString(command.description, "description");
  optionalString(command.untilTime, "untilTime");
  optionalString(command.timeZone, "timeZone");
  optionalPositiveInteger(command.maxTimes, "maxTimes");
  optionalPositiveInteger(command.durationSeconds, "durationSeconds");
  return {
    type: "create.schedule",
    mode,
    trigger,
    prompt: command.prompt,
    intervalSeconds,
    at,
    afterSeconds,
    cronExpr,
    description: command.description,
    maxTimes: command.maxTimes,
    durationSeconds: command.durationSeconds,
    untilTime: command.untilTime,
    timeZone: TZ,
  };
}

function requireString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 必须是非空字符串`);
}

function optionalString(value: unknown, name: string): asserts value is string | undefined {
  if (value !== undefined && (typeof value !== "string" || !value.trim())) {
    throw new Error(`${name} 必须是非空字符串`);
  }
}

function requirePositiveInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${name} 必须是正整数`);
}

function optionalPositiveInteger(value: unknown, name: string): asserts value is number | undefined {
  if (value !== undefined && (!Number.isInteger(value) || Number(value) <= 0)) {
    throw new Error(`${name} 必须是正整数`);
  }
}
