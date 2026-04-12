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
  "open": "未完成的意图、待验证项、讨论到一半的线头（都闭合了则设为 null）",
  "tags": ["关键词1", "关键词2", "..."]
}

要求：
- details 写结论、产出和关键决策，不写讨论过程
- open 是对话续接的关键：提出但没落地的事项必须记录。全部闭合则设为 null
- tags 提取 3-5 个关键词，有辨识度。涉及具体项目/任务时放入任务名。不要太泛（如"开发"、"讨论"）
- 对话内容太少或没有实质内容（如简单寒暄），整体返回 null
- 只输出 JSON 或 null，不要其他内容`;
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
