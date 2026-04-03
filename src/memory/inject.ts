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
  isAdmin?: boolean;
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
  const adminLabel = scene.isAdmin ? "，admin" : "";
  sceneLines.push(`用户：${scene.userName ?? scene.userId}（${scene.userId}${adminLabel}）`);
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

  // 3. Tools documentation
  parts.push(`## Available Tools

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
View overview:
  niubot chat-summary overview [--chat-id <id>]

#### Daily
List recent dailies:
  niubot chat-summary daily [--chat-id <id>] [--since <date>] [--before <date>] [--limit N]

View daily detail:
  niubot chat-summary daily get <id>

#### Weekly
List recent weeklies:
  niubot chat-summary weekly [--chat-id <id>] [--since <date>] [--before <date>] [--limit N]

View weekly detail:
  niubot chat-summary weekly get <id>

View any summary by ID:
  niubot chat-summary get <id>`);

  parts.push(`### Message history
Query past conversation messages.

List messages (chronological order):
  niubot messages list [options]

Full-text search:
  niubot messages search <query> [options]

Common options:
  -n, --limit <count>      Max results (list: default 20, search: default 10)
      --offset <id>        Pagination cursor: show messages after [#id]
      --since <time>       Only messages after this time
      --before <time>      Only messages before this time
      --role <role>        Filter by "user" or "assistant"
      --user-id <id>       Filter by sender (short ID like U1)
      --content-type <t>   Filter by content type: text/image/audio/file/mixed
      --chat-id <id>       Specify chat (default: current chat)

Search-only options:
  -C, --context <count>    Show N messages before and after each match
      --all                Search across all chats (default: current chat only)

Output format:
  Each message is prefixed with [#id], a database-assigned sequential ID.

Examples:
  niubot messages list
  niubot messages list --user-id U1
  niubot messages list --since "2026-03-08" --role user
  niubot messages search "部署"
  niubot messages search "bug" --all --context 3`);

  parts.push(`### Contacts
Query user/chat information.

List users/chats:
  niubot contacts list-users [--name <keyword>]
  niubot contacts list-chats [--type p2p|group] [--user-id <id>]

Get details (accepts short ID like U1/C1):
  niubot contacts get-user <id>
  niubot contacts get-chat <id>

Set user display name:
  niubot contacts set-name <id> <name>

Examples:
  niubot contacts list-users
  niubot contacts list-users --name 张三
  niubot contacts list-chats --type group
  niubot contacts get-user U1`);

  parts.push(`### Send message
Send a message to a chat via IPC.

  niubot send <text>
  niubot send --chat-id <id> <text>

### Send file
Send a file to a chat.

  niubot send-file <file-path>
  niubot send-file --chat-id <id> <file-path>`);

  parts.push(`### Scheduled tasks (cron)
Schedule recurring or one-time tasks.

Recurring tasks (cron expression):
  niubot cron add --cron "<min> <hour> <day> <month> <weekday>" --prompt "<task>" --desc "<label>"

One-time tasks:
  niubot cron add --at "<datetime>" --prompt "<task>" --desc "<label>"

Bounded recurring tasks:
  niubot cron add --cron "<expr>" --times <n> --prompt "<task>" --desc "<label>"
  niubot cron add --cron "<expr>" --until "<datetime>" --prompt "<task>" --desc "<label>"

List or delete cron jobs:
  niubot cron list
  niubot cron del <job-id>

Examples:
  niubot cron add --cron "0 9 * * *" --prompt "Daily summary" --desc "Morning Report"
  niubot cron add --at "2026-04-05 10:00" --prompt "Remind: meeting" --desc "Meeting"
  niubot cron del 3`);

  parts.push(`### Task management
Manage tasks with visibility control. Tasks are organized in a tasks/ directory.

Create a task:
  niubot task create <name> [--private] [--public] [--desc "..."]

List visible tasks:
  niubot task list [<name>]

Update a task:
  niubot task update <name> [--name <new-name>] [--desc "..."] [--private] [--public]

Delete a task (archives):
  niubot task delete <name>

Private chat defaults to --private, group chat defaults to --public.

Examples:
  niubot task create my-research --desc "AI research project"
  niubot task list
  niubot task update my-research --desc "Updated description"
  niubot task delete my-research`);

  parts.push(`### Restart bot
Restart the bot process (admin only, via IPC to the running daemon).

  niubot restart

This sends a restart signal to the daemon. The process exits cleanly and the supervisor restarts it.
Only available to admin users.`);

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
