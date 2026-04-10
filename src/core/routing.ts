/**
 * 路由决策引擎。
 * 每条消息进来时判断：继续当前 session / 开新 session。
 *
 * 规则：
 * - 距上次消息 < 1小时 → continue（零成本，不调 LLM）
 * - 距上次消息 ≥ 1小时 → 调 LLM（lite model）判断话题
 * - LLM 超时/失败 → 兜底 continue
 */

import type Database from "better-sqlite3";
import type { AgentBackend } from "../agent/types.js";
import { ROUTE_DECISION_PROMPT } from "./prompts.js";
import { createLogger } from "../logger.js";
import { utcToLocalHHMM } from "../tz.js";

const log = createLogger("routing");

/** 时间阈值（毫秒）：距上次消息超过此值才触发 LLM 判断 */
const INTERVAL_THRESHOLD_MS = 60 * 60 * 1000; // 1 小时

/** 路由判断超时（毫秒） */
const ROUTE_TIMEOUT_MS = 30 * 1000; // 30 秒

/** 查询最近消息的条数上限 */
const RECENT_MESSAGES_LIMIT = 20;

export interface RouteDecision {
  action: "continue" | "new";
  reason?: string;
}

/**
 * 判断新消息应该继续当前 session 还是开新 session。
 */
export async function decideRoute(
  agent: AgentBackend,
  db: Database.Database,
  chatId: string,
  lastActiveAt: string,
  newMessage: string,
  currentSessionKey: string,
): Promise<RouteDecision> {
  // 1. 计算时间间隔
  const lastTime = new Date(lastActiveAt.replace(" ", "T") + "Z").getTime();
  const intervalMs = Date.now() - lastTime;

  if (intervalMs < INTERVAL_THRESHOLD_MS) {
    return { action: "continue" };
  }

  const intervalMinutes = Math.round(intervalMs / 60000);
  log.info("interval exceeds threshold, invoking LLM", { chatId, intervalMinutes });

  // 2. 构造 LLM 输入
  const recentMessages = getRecentMessages(db, currentSessionKey, lastActiveAt);

  const replacements: Record<string, string> = {
    recentMessages: recentMessages || "（无最近消息）",
    newMessage: newMessage,
    intervalMinutes: String(intervalMinutes),
  };
  const prompt = ROUTE_DECISION_PROMPT.replace(
    /\{(\w+)\}/g,
    (match, key: string) => replacements[key] ?? match,
  );

  // 3. 调 LLM（lite model，独立 session）
  let session;
  try {
    session = await agent.createSession({ modelTier: "lite" });
  } catch (err) {
    log.warn("failed to create routing session, fallback to continue", { chatId, error: String(err) });
    return { action: "continue" };
  }

  try {
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("route decision timed out")), ROUTE_TIMEOUT_MS);
    });

    let responseText: string;
    try {
      const response = await Promise.race([
        agent.sendMessage(session, prompt),
        timeoutPromise,
      ]);
      responseText = response.text;
    } finally {
      clearTimeout(timer!);
    }

    // 4. 解析 JSON 响应
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn("route LLM response has no JSON, fallback to continue", { chatId });
      return { action: "continue" };
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      action?: string;
      reason?: string;
    };

    const action = parsed.action;
    if (action !== "continue" && action !== "new") {
      log.warn("route LLM returned invalid action, fallback to continue", { chatId, action });
      return { action: "continue" };
    }

    log.info("route decision", { chatId, action, reason: parsed.reason });
    return { action, reason: parsed.reason };
  } catch (err) {
    log.warn("route decision failed, fallback to continue", { chatId, error: String(err) });
    return { action: "continue" };
  } finally {
    await agent.closeSession(session).catch((err) => {
      log.warn("failed to close routing session", { chatId, error: String(err) });
    });
  }
}

/** 查询当前 session 最近 N 条消息（截止到 beforeTime），格式化为文本 */
function getRecentMessages(db: Database.Database, sessionId: string, beforeTime: string): string {
  const rows = db.prepare(`
    SELECT m.role, m.content_text, m.created_at, u.name as sender_name
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    WHERE m.session_key = ? AND m.content_text IS NOT NULL AND m.created_at <= ?
    ORDER BY m.id DESC
    LIMIT ?
  `).all(sessionId, beforeTime, RECENT_MESSAGES_LIMIT) as Array<{
    role: string;
    content_text: string;
    created_at: string;
    sender_name: string | null;
  }>;

  if (rows.length === 0) return "";

  rows.reverse();

  return rows.map((r) => {
    const sender = r.role === "assistant" ? "Bot" : (r.sender_name ?? "User");
    const time = utcToLocalHHMM(r.created_at);
    const text = r.content_text.length > 200 ? r.content_text.slice(0, 200) + "..." : r.content_text;
    return `[${time}] ${sender}: ${text}`;
  }).join("\n");
}
