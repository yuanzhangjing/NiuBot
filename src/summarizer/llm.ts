import type { AgentBackend } from "../agent/types.js";
import { createLogger } from "../logger.js";

const log = createLogger("summarizer-llm");

export interface SummaryResult {
  summary: string;
  detail: string;
}

/** 通过 agent backend 生成摘要（固定使用 lite 档位），解析 JSON 返回 */
export async function generateSummary(agent: AgentBackend, prompt: string): Promise<SummaryResult> {
  // 每个 prompt 独立 session，不 resume，避免累积上下文
  const session = await agent.createSession({ modelTier: "lite" });

  try {
    const response = await agent.sendMessage(session, prompt);
    const text = response.text;

    log.debug("agent response", { textLength: text.length });

    // 从返回文本中提取 JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Agent response does not contain valid JSON");
    }

    const parsed = JSON.parse(jsonMatch[0]) as { summary?: string; detail?: string };
    if (!parsed.summary) {
      throw new Error("Agent response missing 'summary' field");
    }

    return {
      summary: parsed.summary.slice(0, 500),
      detail: (parsed.detail ?? "").slice(0, 10000),
    };
  } finally {
    await agent.closeSession(session);
  }
}
