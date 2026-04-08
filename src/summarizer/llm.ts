import type { AgentBackend } from "../agent/types.js";
import { createLogger } from "../logger.js";

const log = createLogger("summarizer-llm");

export interface SummaryResult {
  summary: string;
  detail: string;
}

function parseSummaryResult(text: string): SummaryResult {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Agent response does not contain valid JSON");
  }

  const parsed = JSON.parse(jsonMatch[0]) as { summary?: unknown; detail?: unknown };
  if (typeof parsed.summary !== "string" || parsed.summary.trim() === "") {
    throw new Error("Agent response missing string 'summary' field");
  }
  if (parsed.detail !== undefined && typeof parsed.detail !== "string") {
    throw new Error("Agent response 'detail' field must be a string");
  }

  return {
    summary: parsed.summary.slice(0, 500),
    detail: (parsed.detail ?? "").slice(0, 10000),
  };
}

/** 通过 agent backend 生成摘要（固定使用 lite 档位），解析 JSON 返回 */
export async function generateSummary(agent: AgentBackend, prompt: string): Promise<SummaryResult> {
  // 每个 prompt 独立 session，不 resume，避免累积上下文
  const session = await agent.createSession({ modelTier: "lite" });

  try {
    const response = await agent.sendMessage(session, prompt);
    log.debug("agent response", { textLength: response.text.length });

    try {
      return parseSummaryResult(response.text);
    } catch (error) {
      log.warn("invalid summary response, requesting repair", { error: String(error) });

      const repaired = await agent.sendMessage(
        session,
        "你上一条输出不是合法结果。请严格只输出合法 JSON，格式为 {\"summary\":\"...\",\"detail\":\"...\"}，且两个字段都必须是字符串。不要输出解释、Markdown 或代码块。",
      );

      log.debug("agent repair response", { textLength: repaired.text.length });
      return parseSummaryResult(repaired.text);
    }
  } finally {
    await agent.closeSession(session);
  }
}
