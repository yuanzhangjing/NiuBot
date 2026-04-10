/**
 * Core pipeline prompts — 归档摘要、路由决策等。
 */

/** Session 归档摘要 prompt — 发送给当前 agent session 做自我总结 */
export const ARCHIVE_SUMMARY_PROMPT = `请总结这次对话，输出 JSON 格式：
{
  "summary": "一句话概括这次对话的整体内容",
  "topics": [
    {
      "title": "话题名称",
      "summary": "这个话题讨论了什么、过程是怎样的、最终结论或产出是什么。写充分，让没参与对话的人也能看懂。",
      "decisions": ["相关的关键决策，说清楚决定了什么、为什么"],
      "open_items": ["这个话题下的遗留问题或待跟进事项"]
    }
  ]
}

要求：
- 按话题组织，每个话题独立描述，不要把所有内容堆在 summary 里
- 话题的 summary 是核心，要有来龙去脉，不要只写结论
- decisions 和 open_items 归到对应话题下，没有则留空数组或省略
- 对话内容太少或没有实质内容（如简单寒暄），返回 null
- 只输出 JSON 或 null，不要其他内容`;

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
  "topics": [{"title": "话题名", "status": "进行中|已完成|搁置", "summary": "当前状态，包括未完成事项"}]
}

规则：
- topics 按最近活跃倒序，上限 10 条。已完结且不再相关的话题可移除
- 未完成事项写进对应 topic 的 summary 里，不要单独列
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
