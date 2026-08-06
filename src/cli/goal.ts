/**
 * nbt goal — Goal 模式的 Agent 侧命令。
 * 第一阶段只提供 `nbt goal finish`（结束请求，令牌保护）。
 */
import { localApiRequest } from "../local-api/client.js";
import { resolveSendEndpoint } from "./send.js";
import type { GoalFinishCommand, GoalCommandResult } from "../core/goal.js";

/** 当前会话 ID（Engine 注入，不允许命令行覆盖） */
const CHAT_ID = process.env["NIUBOT_CHAT_ID"];

export async function handleGoal(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  if (sub === "--help" || sub === "help" || sub === undefined) {
    console.log(`nbt goal — Goal 模式命令

用法：
  nbt goal finish --outcome <achieved|not_achieved> [--conclusion <结论>]
    结束当前 Goal：目标达成（achieved）或确认无法达成（not_achieved）。
    conclusion 是一句话摘要（建议附证据）。
    必须在 Goal 回合内调用；令牌由 Engine 注入校验。`);
    return;
  }

  if (sub === "finish") {
    await handleGoalFinish(rest);
    return;
  }

  console.error(`Error: 未知子命令: ${sub}`);
  process.exit(1);
}

async function handleGoalFinish(args: string[]): Promise<void> {
  const outcome = args.includes("--outcome") ? args[args.indexOf("--outcome") + 1] : undefined;
  let conclusion: string | undefined;
  const conclusionIndex = args.indexOf("--conclusion");
  if (conclusionIndex >= 0) {
    conclusion = args.slice(conclusionIndex + 1).join(" ").trim() || undefined;
  }
  // 令牌：--token 参数优先，环境变量兜底（prompt 每轮注入的令牌值）
  const token = args.includes("--token")
    ? args[args.indexOf("--token") + 1]
    : process.env["NIUBOT_GOAL_TOKEN"];

  if (!outcome || (outcome !== "achieved" && outcome !== "not_achieved")) {
    console.error("Error: --outcome 必须为 achieved 或 not_achieved");
    process.exit(1);
  }
  if (!CHAT_ID) {
    console.error("Error: NIUBOT_CHAT_ID 未设置（nbt goal 只能在会话内使用）");
    process.exit(1);
  }
  if (!token) {
    console.error("Error: Goal 令牌缺失（--token 或 NIUBOT_GOAL_TOKEN）");
    process.exit(1);
  }

  const command: GoalFinishCommand = { token, outcome, conclusion };
  let response;
  try {
    response = await localApiRequest(resolveSendEndpoint(), "/goal", {
      method: "POST",
      body: { chat_id: CHAT_ID, command },
      timeoutMs: 10_000,
    });
  } catch (error) {
    throw new Error(`无法连接 NiuBot Pipeline: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.statusCode >= 400) {
    let detail = response.body;
    try {
      const parsed = JSON.parse(response.body) as { error?: string };
      detail = parsed.error ?? detail;
    } catch { /* 保留原始响应 */ }
    throw new Error(`Pipeline 拒绝 Goal 操作 (${response.statusCode}): ${detail}`);
  }
  const result = JSON.parse(response.body) as GoalCommandResult;
  console.log(result.output);
}
