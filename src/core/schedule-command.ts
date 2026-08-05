import { TZ } from "../tz.js";
import { validateCronExpression } from "./cron.js";

/**
 * 统一调度命令：触发参数（every/at/after/cron）与运行模式（loop/cron）正交，全部组合可用。
 * - mode 只决定上下文：loop=复用主会话，cron=独立会话
 * - trigger 只决定何时执行：every=循环，at=定时一次，after=延迟一次，cron=日历表达式
 */
export type ScheduleTrigger = "every" | "at" | "after" | "cron";

export interface CreateScheduleCommand {
  type: "create.schedule";
  mode: "loop" | "cron";
  trigger: ScheduleTrigger;
  prompt: string;
  /** trigger=every：循环间隔（秒） */
  intervalSeconds?: number;
  /** trigger=at：本地时间（如 "2026-08-05 18:00"） */
  at?: string;
  /** trigger=after：延迟秒数 */
  afterSeconds?: number;
  /** trigger=cron：5 段表达式（仅 cron 模式） */
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
      // 兼容旧格式：等价于 mode=loop + trigger=every
      requireString(command.prompt, "prompt");
      requirePositiveInteger(command.intervalSeconds, "intervalSeconds");
      optionalPositiveInteger(command.maxTimes, "maxTimes");
      optionalPositiveInteger(command.durationSeconds, "durationSeconds");
      return {
        type: "create.schedule",
        mode: "loop",
        trigger: "every",
        intervalSeconds: command.intervalSeconds,
        prompt: command.prompt,
        maxTimes: command.maxTimes,
        durationSeconds: command.durationSeconds,
        timeZone: TZ,
      };
    }
    case "create.cron": {
      // 兼容旧格式：等价于 mode=cron + trigger=cron|at
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
        mode: "cron",
        trigger: command.cronExpr ? "cron" : "at",
        cronExpr: command.cronExpr,
        at: command.runAt,
        prompt: command.prompt,
        description: command.description,
        maxTimes: command.maxTimes,
        untilTime: command.untilTime,
        timeZone: command.timeZone ?? TZ,
      };
    }
    case "cancel":
      requireString(command.scheduleId, "scheduleId");
      return { type: "cancel", scheduleId: command.scheduleId };
    default:
      throw new Error(`未知调度操作: ${String(command.type)}`);
  }
}

function parseCreateSchedule(command: Record<string, unknown>): CreateScheduleCommand {
  requireString(command.prompt, "prompt");
  const mode = command.mode;
  if (mode !== "loop" && mode !== "cron") throw new Error("mode 必须是 loop 或 cron");
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
    timeZone: command.timeZone ?? TZ,
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
