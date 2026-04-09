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

/** 全局摘要滚动更新 prompt — 用 lite model 基于旧摘要 + 新 session summary 合并 */
export function buildStateSummaryPrompt(currentState: string | null, sessionSummary: string): string {
  const existing = currentState
    ? `当前全局摘要：\n${currentState}\n\n`
    : "";

  return `${existing}一个新的对话 session 已结束，以下是它的摘要：
${sessionSummary}

请${currentState ? "更新" : "生成"}对话全局摘要，输出 JSON 格式：
{
  "summary": "一句话概括对话整体方向和当前焦点",
  "topics": [{"title": "话题名", "summary": "当前状态"}],
  "open_items": ["待办事项"],
  "recent_changes": ["最近的重要变更"]
}

规则：
- topics 按最近活跃倒序，上限 10 条。已完结的话题可移除
- open_items 上限 5 条，已完成的移除
- recent_changes 上限 3 条，只保留最新的
- 这是滚动更新，不是追加。合并、替换、精简

只输出 JSON，不要其他内容。`;
}

/** 路由决策 prompt — 用 lite model 判断新消息应该继续还是新建 session */
export const ROUTE_DECISION_PROMPT = `你是一个对话路由助手。根据以下信息判断用户新消息应该：
- continue: 继续当前对话（话题相关）
- new: 开始新对话（话题无关）

当前对话最近消息：
{recentMessages}

用户新消息：
{newMessage}

距上次对话已过 {intervalMinutes} 分钟。

请用 JSON 格式回复：
{"action": "continue"|"new", "reason": "..."}
只输出 JSON。`;
