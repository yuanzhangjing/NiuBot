/** nbt collab — Agent 侧提交当前多 Bot 协作回合动作。 */

import type { CollabTurnDecision } from "../core/collab-loop.js";
import { localApiRequest } from "../local-api/client.js";
import { resolveSendEndpoint } from "./send.js";

export async function handleCollab(args: string[]): Promise<void> {
  const chatId = process.env["NIUBOT_CHAT_ID"];
  const scopeKey = process.env["NIUBOT_SCOPE_KEY"];
  const threadId = process.env["NIUBOT_THREAD_ID"] || undefined;
  const replyToMsgId = process.env["NIUBOT_WAKE_REPLY_TO"] || undefined;
  const collabToken = process.env["NIUBOT_COLLAB_TOKEN"];
  const sub = args[0]?.toLowerCase();
  if (sub === undefined || sub === "help" || sub === "--help") {
    console.log(`nbt collab — 多 Bot 协作回合命令

用法：
  nbt collab turn --action handoff --to <目标稳定平台 ID>
  nbt collab turn --action finish`);
    return;
  }
  if (sub !== "turn") fail("Error: 用法是 nbt collab turn --action <handoff|finish> [--to <平台 ID>]");
  if (!chatId || !collabToken) fail("Error: nbt collab turn 只能在当前协作 Agent 回合内使用");

  const action = flag(args.slice(1), "--action");
  let decision: CollabTurnDecision;
  if (action === "finish") {
    decision = { action: "finish" };
  } else if (action === "handoff") {
    const target = flag(args.slice(1), "--to")?.trim();
    if (!target) fail("Error: handoff 需要 --to <目标稳定平台 ID>");
    decision = { action: "handoff", to: target };
  } else {
    fail("Error: --action 必须是 handoff 或 finish");
  }

  let response;
  try {
    response = await localApiRequest(resolveSendEndpoint(), "/collab/turn", {
      method: "POST",
      body: {
        chat_id: chatId,
        decision,
        collab_token: collabToken,
        scope_key: scopeKey,
        thread_id: threadId,
        reply_to_msg_id: replyToMsgId,
      },
      timeoutMs: 10_000,
    });
  } catch (error) {
    throw new Error(`无法连接 NiuBot Pipeline: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.statusCode >= 400) {
    let detail = response.body;
    try {
      detail = (JSON.parse(response.body) as { error?: string }).error ?? detail;
    } catch { /* 保留原始响应 */ }
    throw new Error(`Pipeline 拒绝协作动作 (${response.statusCode}): ${detail}`);
  }
  console.log("Collab turn recorded.");
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
