export type ScheduleAgentCommand =
  | {
      type: "create.loop";
      intervalSeconds: number;
      prompt: string;
      maxTimes?: number;
      durationSeconds?: number;
    }
  | {
      type: "create.cron";
      cronExpr?: string;
      runAt?: string;
      prompt: string;
      description?: string;
      maxTimes?: number;
      untilTime?: string;
      timeZone: string;
    }
  | {
      type: "cancel";
      scheduleId: string;
    };

export interface ScheduleAgentCommandResult {
  output: string;
}

export function parseScheduleAgentCommand(value: unknown): ScheduleAgentCommand {
  if (!value || typeof value !== "object") throw new Error("调度命令必须是对象");
  const command = value as Record<string, unknown>;
  switch (command.type) {
    case "create.loop":
      requireString(command.prompt, "prompt");
      requirePositiveInteger(command.intervalSeconds, "intervalSeconds");
      optionalPositiveInteger(command.maxTimes, "maxTimes");
      optionalPositiveInteger(command.durationSeconds, "durationSeconds");
      return command as unknown as ScheduleAgentCommand;
    case "create.cron":
      requireString(command.prompt, "prompt");
      optionalString(command.cronExpr, "cronExpr");
      optionalString(command.runAt, "runAt");
      optionalString(command.description, "description");
      optionalString(command.untilTime, "untilTime");
      optionalString(command.timeZone, "timeZone");
      optionalPositiveInteger(command.maxTimes, "maxTimes");
      return command as unknown as ScheduleAgentCommand;
    case "cancel":
      requireString(command.scheduleId, "scheduleId");
      return command as unknown as ScheduleAgentCommand;
    default:
      throw new Error(`未知调度操作: ${String(command.type)}`);
  }
}

function requireString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 必须是非空字符串`);
}

function optionalString(value: unknown, name: string): void {
  if (value !== undefined && (typeof value !== "string" || !value.trim())) {
    throw new Error(`${name} 必须是非空字符串`);
  }
}

function requirePositiveInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${name} 必须是正整数`);
}

function optionalPositiveInteger(value: unknown, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || Number(value) <= 0)) {
    throw new Error(`${name} 必须是正整数`);
  }
}
