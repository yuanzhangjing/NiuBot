/**
 * M3 路由决策引擎。
 * 每条消息进来时判断：继续当前 session / 开新 session / 召回之前的 session。
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

const log = createLogger("routing");

/** 时间阈值（毫秒）：距上次消息超过此值才触发 LLM 判断 */
const INTERVAL_THRESHOLD_MS = 60 * 60 * 1000; // 1 小时

/** 路由判断超时（毫秒） */
const ROUTE_TIMEOUT_MS = 30 * 1000; // 30 秒

/** 查询最近消息的条数上限 */
const RECENT_MESSAGES_LIMIT = 20;

export interface RouteDecision {
  action: "continue" | "new" | "recall";
  recallSessionId?: string;
  reason?: string;
}

/**
 * 判断新消息应该继续当前 session 还是开新 session。
 *
 * @param agent - Agent 后端（用于创建临时 LLM session）
 * @param db - 数据库实例
 * @param chatId - 内部 chat ID
 * @param lastActiveAt - 当前 session 最后活跃时间（ISO string）
 * @param newMessage - 用户新消息文本
 * @param currentSessionKey - 当前 session key（用于查询最近消息）
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
  const lastTime = new Date(lastActiveAt.replace(" ", "T") + "Z").getTime(); // SQLite datetime 转 ISO 8601
  const intervalMs = Date.now() - lastTime;

  if (intervalMs < INTERVAL_THRESHOLD_MS) {
    return { action: "continue" };
  }

  const intervalMinutes = Math.round(intervalMs / 60000);
  log.info("interval exceeds threshold, invoking LLM", { chatId, intervalMinutes });

  // 2. 构造 LLM 输入（只取间隔前的消息，避免新消息在 prompt 中重复出现）
  const recentMessages = getRecentMessages(db, currentSessionKey, lastActiveAt);
  const archivedSessions = getTodayArchivedSessions(db, chatId);

  // 单次替换，避免跨占位符污染和 $ 特殊模式问题
  const replacements: Record<string, string> = {
    recentMessages: recentMessages || "（无最近消息）",
    archivedSessions: archivedSessions || "（今日无已归档对话）",
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
    // 带超时的 LLM 调用
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
      recall_session_id?: string;
      reason?: string;
    };

    const action = parsed.action;
    if (action !== "continue" && action !== "new" && action !== "recall") {
      log.warn("route LLM returned invalid action, fallback to continue", { chatId, action });
      return { action: "continue" };
    }

    // recall 需要 session_id
    if (action === "recall" && !parsed.recall_session_id) {
      log.warn("route LLM returned recall without session_id, fallback to new", { chatId });
      return { action: "new", reason: parsed.reason };
    }

    log.info("route decision", { chatId, action, reason: parsed.reason });
    return {
      action,
      recallSessionId: parsed.recall_session_id,
      reason: parsed.reason,
    };
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
function getRecentMessages(db: Database.Database, sessionKey: string, beforeTime: string): string {
  const rows = db.prepare(`
    SELECT m.role, m.content_text, m.created_at, u.name as sender_name
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    WHERE m.session_key = ? AND m.content_text IS NOT NULL AND m.created_at <= ?
    ORDER BY m.id DESC
    LIMIT ?
  `).all(sessionKey, beforeTime, RECENT_MESSAGES_LIMIT) as Array<{
    role: string;
    content_text: string;
    created_at: string;
    sender_name: string | null;
  }>;

  if (rows.length === 0) return "";

  // 倒序查出来的，反转为正序
  rows.reverse();

  return rows.map((r) => {
    const sender = r.role === "assistant" ? "Bot" : (r.sender_name ?? "User");
    const time = r.created_at.slice(11, 16); // HH:MM
    const text = r.content_text.length > 200 ? r.content_text.slice(0, 200) + "..." : r.content_text;
    return `[${time}] ${sender}: ${text}`;
  }).join("\n");
}

/** 查询今日已归档的 session 列表，格式化为文本 */
function getTodayArchivedSessions(db: Database.Database, chatId: string): string {
  const today = new Date().toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT id, summary, topics, ended_at
    FROM sessions
    WHERE chat_id = ? AND status = 'archived' AND DATE(ended_at) = ?
    ORDER BY ended_at ASC
  `).all(chatId, today) as Array<{
    id: string;
    summary: string | null;
    topics: string | null;
    ended_at: string;
  }>;

  if (rows.length === 0) return "";

  return rows.map((r) => {
    const time = r.ended_at.slice(11, 16);
    const summaryObj = r.summary ? tryParseJson(r.summary) : null;
    const summaryText = summaryObj?.summary ?? "(无摘要)";
    const topics = r.topics ? tryParseJson(r.topics) : [];
    const topicStr = Array.isArray(topics) && topics.length > 0 ? ` [${topics.join(", ")}]` : "";
    return `[${time}] (id: ${r.id}) ${summaryText}${topicStr}`;
  }).join("\n");
}

function tryParseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
