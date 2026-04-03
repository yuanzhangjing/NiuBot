import type Database from "better-sqlite3";
import { listUserMemory } from "./user-memory.js";
import { getOverview, listDailies, listWeeklies } from "./chat-summary.js";
import { toSunday } from "./chat-summary.js";
import { createLogger } from "../logger.js";
import { localToday, localDateStartUTC, nextDay, utcToLocalHHMM, utcToLocalDateTime } from "../tz.js";

const log = createLogger("inject");

// ── Important context (不能被 compact 丢失) ──────────────────

export interface SceneInfo {
  botName: string;
  userName?: string;
  userId: string;
  chatId: string;
  chatType: "p2p" | "group";
}

/**
 * 构建 important 上下文：当前场景 + 用户记忆。
 * 优先注入 system prompt（CLI），不支持时注入 user prompt 前缀。
 */
export function buildImportantContext(
  db: Database.Database,
  scene: SceneInfo,
): string {
  const parts: string[] = [];

  // 1. 当前场景
  const sceneLines: string[] = [];
  sceneLines.push(`Bot：${scene.botName}`);
  sceneLines.push(`会话：${scene.chatId}（${scene.chatType === "group" ? "群聊" : "私聊"}）`);
  sceneLines.push(`用户：${scene.userName ?? scene.userId}（${scene.userId}）`);
  parts.push(`[当前场景]\n${sceneLines.join("\n")}`);

  // 2. User memory
  const memories = scene.chatType === "p2p"
    ? listUserMemory(db, scene.userId)
    : listUserMemory(db, scene.userId, "public");

  if (memories.length > 0) {
    const label = scene.userName ? `关于 ${scene.userName} 的记忆` : "关于用户的记忆";
    const lines = memories.map((m) => `  #${m.id}  ${m.summary}`);
    lines.push("用 niubot user-memory get <id> 查看详情。");
    parts.push(`[${label}]\n${lines.join("\n")}`);
  }

  return parts.join("\n\n");
}

// ── Normal context (可以接受 compact 压缩) ───────────────────

/**
 * 构建 normal 上下文：chat 摘要 + 今日归档 session + recall。
 * 注入 user prompt 前缀。
 */
export function buildNormalContext(
  db: Database.Database,
  chatId: string,
  chatType: "p2p" | "group",
  recallSessionId?: string,
): string {
  const parts: string[] = [];

  // 1. Chat summary: overview + dailies + weeklies
  const overview = getOverview(db, chatId);
  const dailies = listDailies(db, chatId, { limit: 30 });
  const weeklies = listWeeklies(db, chatId, { limit: 8 });

  const today = localToday();
  const todayStartUTC = localDateStartUTC(today);
  const todayCount = db.prepare(
    "SELECT COUNT(*) as n FROM messages WHERE chat_id = ? AND created_at >= ?",
  ).get(chatId, todayStartUTC) as { n: number };

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

    const weeklyPeriods = new Set(weeklies.map((w) => w.period!));
    for (const d of dailies) {
      if (d.period === today) {
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
      entries.push({ sortKey: sunday, line: `  #${w.id}  [${w.period}~${sunday}] ${w.summary}` });
    }

    entries.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
    const top = entries.slice(0, 10);

    for (const e of top) {
      lines.push(e.line);
    }

    lines.push("用 niubot chat-summary get <id> 查看详情。");
    parts.push(`[对话上下文]\n${lines.join("\n")}`);
  }

  // 2. 今日归档 session 列表
  if (!todayFullyCovered) {
    const archivedSessions = getTodayArchivedSessions(db, chatId);
    if (archivedSessions.length > 0) {
      const lines = archivedSessions.map((s) => {
        const time = utcToLocalHHMM(s.ended_at);
        const summaryText = s.parsedSummary ?? "(无摘要)";
        return `  [${time}] ${summaryText}`;
      });
      parts.push(`[今日对话]\n${lines.join("\n")}`);
    }
  }

  // 3. Recall 上下文
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
        const time = recallSession.ended_at ? utcToLocalDateTime(recallSession.ended_at) : "未知时间";
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

// ── Static context (写入 AGENTS.md) ─────────────────────────

/**
 * 生成 AGENTS.md 的内容：persona + bot 身份 + skill 工具文档 + 行为规则。
 */
export function buildStaticContext(botName: string, persona?: string): string {
  const parts: string[] = [];

  // 1. 基本行为规则
  parts.push(`You are ${botName}, an AI bot running inside NiuBot runtime.
Your responses are automatically delivered to the user — just reply normally.
Do NOT mention NiuBot, Claude, or Anthropic to the user. Present yourself according to your persona below.
All user data (memories, messages) must be accessed through niubot CLI tools. Do NOT directly read database files.
Do NOT use the built-in memory system (auto memory). All persistent information must go through niubot tools.
When you learn something noteworthy about a user, proactively save it as a memory using niubot user-memory add.
If you are unsure about the current user or their preferences, use niubot user-memory list to check.`);

  // 2. Persona
  if (persona) {
    parts.push(persona);
  }

  // 3. Skill: user-memory
  parts.push(`## Tools

### User memory (about people)
Manage per-user memory entries. Use this to remember things about users (preferences, background, experiences).
Each user has a max of 20 entries. Each entry has a summary (always injected) and detail (loaded on demand).
Visibility: "private" (default, only in private chat) or "public" (also visible in group chat).

Add a memory:
  niubot user-memory add --summary "..." [--detail "..."] [--visibility private|public]

List memories:
  niubot user-memory list [--user-id <id>]

Get full detail:
  niubot user-memory get <id>

Update a memory:
  niubot user-memory update <id> [--summary "..."] [--detail "..."] [--visibility private|public]

Delete a memory:
  niubot user-memory del <id>

Notes:
- In group chat, \`user-memory list --user-id U3\` shows only that user's public memories.
- You can only add/update/delete your own memories (the current user's).
- When you learn something noteworthy about a user, proactively save it as a memory.`);

  // 4. Skill: chat-summary
  parts.push(`### Chat memory (about conversations)
System-maintained conversation summaries, auto-generated by the summarizer service.
Three levels: overview (positioning), daily (per-day detail), weekly (per-week topics).

**Reading**: recent summaries are auto-injected into conversation context. Use the commands below to read more history.
**Writing**: all entries are maintained by the auto-summarizer. Do NOT call upsert commands — they are reserved for the summarizer service.

Common options:
      --chat-id <id>       Specify chat (default: current chat)

Delete any entry by ID:
  niubot chat-summary del <id>

#### Overview
Each chat has one overview — a "status card" with conversation positioning, topic index, and current focus.

View overview:
  niubot chat-summary overview [--chat-id <id>]

#### Daily
Per-day conversation summaries recording specific discussions and decisions.

List recent dailies:
  niubot chat-summary daily [--chat-id <id>] [--since <date>] [--before <date>] [--limit N]

View daily detail:
  niubot chat-summary daily get <id>

#### Weekly
Per-week conversation summaries aggregating topics across the week. Covers Monday through Sunday.

List recent weeklies:
  niubot chat-summary weekly [--chat-id <id>] [--since <date>] [--before <date>] [--limit N]

View weekly detail:
  niubot chat-summary weekly get <id>

View any summary by ID:
  niubot chat-summary get <id>`);

  return parts.join("\n\n");
}

// ── Backward compat: old buildSessionContext ─────────────────

/**
 * @deprecated 使用 buildImportantContext + buildNormalContext 替代
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

  if (persona) parts.push(persona);

  const scene: SceneInfo = { botName: "NiuBot", userName, userId, chatId, chatType };
  const important = buildImportantContext(db, scene);
  if (important) parts.push(important);

  const normal = buildNormalContext(db, chatId, chatType, recallSessionId);
  if (normal) parts.push(normal);

  return parts.join("\n\n");
}

// ── Internal helpers ────────────────────────────────────────

function isTodayDailyFullyCovering(
  db: Database.Database,
  chatId: string,
  today: string,
  dailies: Array<{ period: string | null; endMsgId: number | null }>,
): boolean {
  const todayDaily = dailies.find((d) => d.period === today);
  if (!todayDaily?.endMsgId) return false;

  const todayStartUTC = localDateStartUTC(today);
  const tomorrowStartUTC = localDateStartUTC(nextDay(today));
  const maxSession = db.prepare(`
    SELECT MAX(end_msg_id) as max_end
    FROM sessions
    WHERE chat_id = ? AND status = 'archived' AND ended_at >= ? AND ended_at < ?
  `).get(chatId, todayStartUTC, tomorrowStartUTC) as { max_end: number | null } | undefined;

  if (!maxSession?.max_end) return true;

  return todayDaily.endMsgId >= maxSession.max_end;
}

function getTodayArchivedSessions(
  db: Database.Database,
  chatId: string,
): Array<{ id: string; ended_at: string; parsedSummary: string | null }> {
  const today = localToday();
  const todayStartUTC = localDateStartUTC(today);
  const tomorrowStartUTC = localDateStartUTC(nextDay(today));

  const rows = db.prepare(`
    SELECT id, summary, ended_at
    FROM sessions
    WHERE chat_id = ? AND status = 'archived' AND ended_at >= ? AND ended_at < ?
    ORDER BY ended_at ASC
  `).all(chatId, todayStartUTC, tomorrowStartUTC) as Array<{
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
