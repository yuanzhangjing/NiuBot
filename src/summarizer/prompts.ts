/** 生成 daily 摘要的 prompt */
export function dailyPrompt(date: string, messages: string): string {
  return `请为 ${date} 的对话生成摘要。

对话内容：
${messages}

请输出 JSON 格式：
{
  "summary": "概括当天做了什么、推进到什么程度、有哪些关键决策（一句话，不超过 200 字）",
  "detail": "按话题组织，相关话题合并，控制在 3-5 个话题。每个话题一句话总结关键进展。零散小事合并到「其他」。如当天内容很少可留空。"
}

只输出 JSON，不要有其他内容。`;
}

/** 生成 weekly 摘要的 prompt */
export function weeklyPrompt(monday: string, sunday: string, dailySummaries: string): string {
  return `请为 ${monday} ~ ${sunday} 生成周摘要。

已有 daily 摘要：
${dailySummaries}

综合以上内容生成 weekly 摘要，输出 JSON 格式：
{
  "summary": "概括本周核心进展、关键决策和推进到的阶段（一句话，不超过 200 字）",
  "detail": "按话题聚合本周进展，相关话题合并，控制在 3-7 个话题。每个话题一句话总结关键进展，不按天拆分。"
}

只输出 JSON，不要有其他内容。`;
}

/** 生成/更新 overview 摘要的 prompt */
export function overviewPrompt(currentOverview: string | null, newSummaries: string): string {
  const existing = currentOverview
    ? `当前 overview：\n${currentOverview}\n\n`
    : "";

  return `${existing}请${currentOverview ? "更新" : "生成"}对话总览摘要。

新增摘要条目：
${newSummaries}

综合以上内容，${currentOverview ? "更新" : "生成"} overview（对话状态卡片），输出 JSON 格式：
{
  "summary": "让不了解这个对话的人一句话知道这里在聊什么、当前关注什么。包含：对话的性质和主要内容方向 + 近期焦点。",
  "detail": "结构如下：\\n**话题索引**：按话题聚合（相关内容合并为一个话题），5-10 条，每条一句话总结当前状态。按最近活跃时间倒序排列（最新的在前）\\n**当前焦点**：正在推进的 1-3 项核心事项"
}

只输出 JSON，不要有其他内容。`;
}
