/**
 * nbt goal — Goal 模式的 Agent 侧命令。
 * 提供 `nbt goal start`（进入 Goal 模式）与 `nbt goal finish`（结束请求）；
 * 请求自动携带会话 chatId，引擎校验活动 Goal。
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
  nbt goal start <目标描述>
    进入 Goal 模式：创建 Goal，当前回合计入第 1 轮。
    用于需要多轮执行/持续跟踪的任务。
  nbt goal progress <步骤> [--status <全局状态>]
    中间轮记录进展（静默，不发送；每轮注入防遗忘）：
    步骤一两句话；--status 为任务整体状态（进行到哪、还剩什么），覆盖式更新。
  nbt goal finish --outcome <achieved|not_achieved> [--conclusion <结论>]
    结束当前 Goal：目标达成（achieved）；未完成即结束（卡住/条件不满足）为 not_achieved。
    conclusion 是当前状态与总结。`);
    return;
  }

  if (sub === "start") {
    await handleGoalStart(rest);
    return;
  }

  if (sub === "progress") {
    await handleGoalProgress(rest);
    return;
  }

  if (sub === "finish") {
    await handleGoalFinish(rest);
    return;
  }

  console.error(`Error: 未知子命令: ${sub}`);
  process.exit(1);
}

async function handleGoalStart(args: string[]): Promise<void> {
  const objective = args.join(" ").trim();
  if (!objective) {
    console.error("Error: nbt goal start 需要目标描述");
    process.exit(1);
  }
  if (!CHAT_ID) {
    console.error("Error: NIUBOT_CHAT_ID 未设置（nbt goal 只能在会话内使用）");
    process.exit(1);
  }
  const result = await postGoal("/goal/start", { objective });
  console.log(result.output);
}

/** goal 子命令共用的本地 API 请求：连接错误包装 + 非 2xx 解码 + JSON 解析。 */
async function postGoal(path: string, body: Record<string, unknown>): Promise<GoalCommandResult> {
  let response;
  try {
    response = await localApiRequest(resolveSendEndpoint(), path, {
      method: "POST",
      body: { chat_id: CHAT_ID, ...body },
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
  return JSON.parse(response.body) as GoalCommandResult;
}

async function handleGoalProgress(args: string[]): Promise<void> {
  // 步骤内容 + 可选 --status <全局状态>（覆盖式：任务整体进行到哪、还剩什么）
  let status: string | undefined;
  const statusIndex = args.indexOf("--status");
  if (statusIndex >= 0) {
    status = args.slice(statusIndex + 1).join(" ").trim();
    args = args.slice(0, statusIndex);
  }
  const content = args.join(" ").trim();
  if (!content) {
    console.error("Error: nbt goal progress 需要进展内容");
    process.exit(1);
  }
  if (!CHAT_ID) {
    console.error("Error: NIUBOT_CHAT_ID 未设置（nbt goal 只能在会话内使用）");
    process.exit(1);
  }
  const result = await postGoal("/goal/progress", { content, status });
  console.log(result.output);
}

async function handleGoalFinish(args: string[]): Promise<void> {
  const outcome = args.includes("--outcome") ? args[args.indexOf("--outcome") + 1] : undefined;
  let conclusion: string | undefined;
  const conclusionIndex = args.indexOf("--conclusion");
  if (conclusionIndex >= 0) {
    conclusion = args.slice(conclusionIndex + 1).join(" ").trim() || undefined;
  }
  if (!outcome || (outcome !== "achieved" && outcome !== "not_achieved")) {
    console.error("Error: --outcome 必须为 achieved 或 not_achieved");
    process.exit(1);
  }
  if (!CHAT_ID) {
    console.error("Error: NIUBOT_CHAT_ID 未设置（nbt goal 只能在会话内使用）");
    process.exit(1);
  }

  const command: GoalFinishCommand = { outcome, conclusion };
  const result = await postGoal("/goal", { command });
  console.log(result.output);
}
