/**
 * Core pipeline prompts — 归档摘要、路由决策等。
 */

/** Session 归档摘要 prompt — 发送给当前 agent session 做自我总结 */
export const ARCHIVE_SUMMARY_PROMPT = `请用以下 JSON 格式总结这次对话的要点：
{
  "summary": "一两句话概括讨论内容和结论",
  "decisions": ["做出的关键决策"],
  "open_items": ["未完成的事项"],
  "topics": ["话题标签"],
  "key_data": ["关键数据/数字"]
}
只输出 JSON，不要其他内容。`;

/** 路由决策 prompt — 用 lite model 判断新消息应该继续/新建/召回 session */
export const ROUTE_DECISION_PROMPT = `你是一个对话路由助手。根据以下信息判断用户新消息应该：
- continue: 继续当前对话（话题相关）
- new: 开始新对话（话题无关）
- recall: 恢复之前的某个对话（用户想回到之前讨论的话题）

当前对话最近消息：
{recentMessages}

今日已归档的对话：
{archivedSessions}

用户新消息：
{newMessage}

距上次对话已过 {intervalMinutes} 分钟。

请用 JSON 格式回复：
{"action": "continue"|"new"|"recall", "recall_session_id": "...", "reason": "..."}
只输出 JSON。`;
