/**
 * Core pipeline prompts — 归档摘要、路由决策等。
 */

/** Session 归档摘要 prompt — 用 lite model 基于对话记录生成结构化摘要 */
export function buildArchiveSummaryPrompt(conversationText: string): string {
  return `以下是一段对话记录：

${conversationText}

请总结这次对话，输出 JSON 格式：
{
  "summary": "一句话概括整体内容",
  "details": "做了什么、关键决策、踩过的坑。把重要上下文讲清楚，不必刻意压缩",
  "open": "未完成的意图、待验证项、讨论到一半的线头（都闭合了则设为 null）"
}

要求：
- details 写结论、产出和关键决策，不写讨论过程
- open 是对话续接的关键：提出但没落地的事项必须记录。全部闭合则设为 null
- 对话内容太少或没有实质内容（如简单寒暄），整体返回 null
- 只输出 JSON 或 null，不要其他内容`;
}

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
  "topics": [{
    "title": "话题名",
    "status": "进行中|已完成|搁置",
    "progress": "已完成的进展，一两句话",
    "next": "下一步计划或待办（已完成的话题可省略）"
  }]
}

规则：
- 相关话题合并，topics 上限 7 条，按最近活跃倒序
- 已完结且不再相关的话题直接移除
- progress 写结论和产出，不写实现细节
- next 只写进行中话题的下一步，已完成的省略该字段
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
