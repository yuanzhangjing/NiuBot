import type Database from "better-sqlite3";
import { listUserMemory } from "./user-memory.js";
import { getOverview, listDailies, listWeeklies } from "./chat-summary.js";
import { toSunday } from "./chat-summary.js";
import { createLogger } from "../logger.js";

const log = createLogger("inject");

/**
 * 组装注入到 session 的上下文文本。
 * 包含 user_memory summaries + chat_summary (overview + recent dailies + weeklies)。
 * 格式对齐 cc-connect buildSessionContext。
 */
export function buildSessionContext(
  db: Database.Database,
  userId: string,
  chatId: string,
  chatType: "p2p" | "group",
  userName?: string,
  recallSessionId?: string,
  persona?: string,
): string {
  const parts: string[] = [];

  // 0. 人格注入（如有）
  if (persona) {
    parts.push(persona);
  }

  // 1. User memory
  const memories = chatType === "p2p"
    ? listUserMemory(db, userId)
    : listUserMemory(db, userId, "public");

  if (memories.length > 0) {
    const label = userName ? `关于 ${userName} 的记忆` : "关于用户的记忆";
    const lines = memories.map((m) => `  #${m.id}  ${m.summary}`);
    lines.push("用 user-memory get <id> 查看详情。");
    parts.push(`[${label}]\n${lines.join("\n")}`);
  }

  // 2. Chat summary: overview + dailies + weeklies, 合并后取最近 10 条
  const overview = getOverview(db, chatId);
  const dailies = listDailies(db, chatId, { limit: 30 });
  const weeklies = listWeeklies(db, chatId, { limit: 8 });

  // 今日消息数
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = db.prepare(
    "SELECT COUNT(*) as n FROM messages WHERE chat_id = ? AND created_at >= ?",
  ).get(chatId, today) as { n: number };

  // 判断今日 daily 是否全覆盖所有归档 session（section 2 和 3 都用到）
  const todayFullyCovered = isTodayDailyFullyCovering(db, chatId, today, dailies);

  if (overview || dailies.length > 0 || weeklies.length > 0 || todayCount.n > 0) {
    const lines: string[] = [];

    if (todayCount.n > 0) {
      lines.push(`  [今日] ${todayCount.n} 条消息（可能不在当前上下文中，可按需查看）`);
    }

    if (overview) {
      if (overview.period) {
        lines.push(`  [总览]（截至 ${overview.period}）${overview.summary}`);
      } else {
        lines.push(`  [总览] ${overview.summary}`);
      }
    }

    // 合并 dailies + weeklies，按时间倒序，取 top 10
    const entries: Array<{ sortKey: string; line: string }> = [];

    // 过滤掉被 weekly 覆盖的 daily
    const weeklyPeriods = new Set(weeklies.map((w) => w.period!));
    for (const d of dailies) {
      if (d.period === today) {
        // 今日 daily 存在时：全覆盖→用 daily 替代 session 列表；部分覆盖→都保留
        entries.push({ sortKey: d.period!, line: `  #${d.id}  [${d.period}] ${d.summary}` });
        continue;
      }
      const covered = [...weeklyPeriods].some((monday) => {
        const sunday = toSunday(monday);
        return d.period! >= monday && d.period! <= sunday;
      });
      if (!covered) {
        entries.push({ sortKey: d.period!, line: `  #${d.id}  [${d.period}] ${d.summary}` });
      }
    }

    for (const w of weeklies) {
      const sunday = toSunday(w.period!);
      // sortKey 用 sunday（周末）对齐 cc-connect
      entries.push({ sortKey: sunday, line: `  #${w.id}  [${w.period}~${sunday}] ${w.summary}` });
    }

    entries.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
    const top = entries.slice(0, 10);

    for (const e of top) {
      lines.push(e.line);
    }

    lines.push("用 chat-summary get <id> 查看详情。");
    parts.push(`[对话上下文]\n${lines.join("\n")}`);
  }

  // 3. 今日归档 session 列表（M3: 让 agent 知道今天聊过什么）
  // 如果今日 daily 已全覆盖所有归档 session，跳过（由 daily 替代）
  if (!todayFullyCovered) {
    const archivedSessions = getTodayArchivedSessions(db, chatId);
    if (archivedSessions.length > 0) {
      const lines = archivedSessions.map((s) => {
        const time = s.ended_at.slice(11, 16);
        const summaryText = s.parsedSummary ?? "(无摘要)";
        return `  [${time}] ${summaryText}`;
      });
      parts.push(`[今日对话]\n${lines.join("\n")}`);
    }
  }

  // 4. Recall 上下文（M3: 路由决策为 recall 时注入被召回 session 的详情）
  if (recallSessionId) {
    const recallSession = db.prepare(
      "SELECT summary, ended_at FROM sessions WHERE id = ?",
    ).get(recallSessionId) as { summary: string | null; ended_at: string | null } | undefined;

    if (!recallSession?.summary) {
      log.warn("recall session not found or has no summary", { recallSessionId });
    } else {
      try {
        const parsed = JSON.parse(recallSession.summary) as {
          summary?: string;
          decisions?: string[];
          open_items?: string[];
        };
        const recallLines: string[] = [];
        const time = recallSession.ended_at?.slice(0, 16).replace("T", " ") ?? "未知时间";
        recallLines.push(`之前讨论（${time}）：${parsed.summary ?? ""}`);
        if (parsed.decisions?.length) {
          recallLines.push(`决策：${parsed.decisions.join("；")}`);
        }
        if (parsed.open_items?.length) {
          recallLines.push(`待办：${parsed.open_items.join("；")}`);
        }
        parts.push(`[恢复的话题]\n${recallLines.join("\n")}`);
      } catch {
        // summary 解析失败，跳过
      }
    }
  }

  return parts.join("\n\n");
}

/**
 * 判断今日 daily 是否全覆盖所有归档 session。
 * 全覆盖 = daily 的 end_msg_id >= 所有今日归档 session 的 max(end_msg_id)。
 * 有交集但不全覆盖时返回 false，保证上下文完整。
 */
function isTodayDailyFullyCovering(
  db: Database.Database,
  chatId: string,
  today: string,
  dailies: Array<{ period: string | null; endMsgId: number | null }>,
): boolean {
  const todayDaily = dailies.find((d) => d.period === today);
  if (!todayDaily?.endMsgId) return false;

  const maxSession = db.prepare(`
    SELECT MAX(end_msg_id) as max_end
    FROM sessions
    WHERE chat_id = ? AND status = 'archived' AND DATE(ended_at) = ?
  `).get(chatId, today) as { max_end: number | null } | undefined;

  // 没有归档 session → daily 覆盖一切
  if (!maxSession?.max_end) return true;

  return todayDaily.endMsgId >= maxSession.max_end;
}

/** 查询今日已归档的 session */
function getTodayArchivedSessions(
  db: Database.Database,
  chatId: string,
): Array<{ id: string; ended_at: string; parsedSummary: string | null }> {
  const today = new Date().toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT id, summary, ended_at
    FROM sessions
    WHERE chat_id = ? AND status = 'archived' AND DATE(ended_at) = ?
    ORDER BY ended_at ASC
  `).all(chatId, today) as Array<{
    id: string;
    summary: string | null;
    ended_at: string;
  }>;

  return rows.map((r) => {
    let parsedSummary: string | null = null;
    if (r.summary) {
      try {
        const obj = JSON.parse(r.summary);
        parsedSummary = obj.summary ?? null;
      } catch { /* ignore */ }
    }
    return { id: r.id, ended_at: r.ended_at, parsedSummary };
  });
}
