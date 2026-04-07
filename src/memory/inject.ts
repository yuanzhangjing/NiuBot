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
  /** Bot 的 short label，如 "U2(NiuBot)" */
  botLabel?: string;
  userName?: string;
  userId: string;
  chatId: string;
  chatType: "p2p" | "group";
  /** Chat 的 short label，如 "C1(U1(Zen))" */
  chatLabel?: string;
  isAdmin?: boolean;
  /** 人设文件路径（仅 admin 可见） */
  personaPath?: string;
  /** 人设内容（每次 session 启动时从文件读取，支持热更新） */
  personaContent?: string;
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
  const isGroup = scene.chatType === "group";

  // 0. Persona（每次 session 启动时从文件读取，支持不重启热更新）
  if (scene.personaContent) {
    parts.push(scene.personaContent);
  }

  // 1. 当前场景
  const sceneLines: string[] = [];
  const botDisplay = scene.botLabel ?? scene.botName;
  sceneLines.push(`Bot：${botDisplay}（即你自己，消息历史中显示为 assistant 角色。${botDisplay} 是你的平台注册标识）`);
  const chatDisplay = scene.chatLabel ?? scene.chatId;
  sceneLines.push(`会话：${chatDisplay}（${isGroup ? "群聊" : "私聊"}）`);
  const userDisplay = scene.userName
    ? `${scene.userId.toUpperCase()}(${scene.userName})`
    : scene.userId.toUpperCase();
  if (scene.isAdmin) {
    sceneLines.push(`用户：${userDisplay}（admin）`);
  } else {
    sceneLines.push(`用户：${userDisplay}`);
  }
  if (scene.isAdmin && scene.personaPath) {
    sceneLines.push(`人设配置：${scene.personaPath}（管理员可要求修改）`);
  }
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
 * 生成 AGENTS.md 的内容：行为规则 + 工具文档。
 * Bot 身份（名字）由场景信息注入，人格由 persona.md 注入，均在 per-session important context 中。
 */
export function buildStaticContext(): string {
  const parts: string[] = [];

  // 1. 基本行为规则
  parts.push(`You are an AI bot running inside NiuBot Engine. Your identity (name, persona) is injected in the session context.
Your responses are automatically delivered to the user — just reply normally.
Do NOT mention NiuBot Engine, Claude, or Anthropic to the user. Present yourself according to your persona (injected in the session context).

## Core rules
- **No self-restart**: NEVER start, stop, or restart the NiuBot Engine service from within a session. It kills your own process and causes a restart loop.
- **Data access**: All user data (memories, messages) must go through \`niubot\` CLI tools. Do NOT read database files directly.
- **No built-in memory**: Do NOT use the auto memory system. Use niubot tools instead: \`user-memory\`, \`chat-summary\`, \`task\`.
- **Proactive memory**: When you learn something noteworthy about a user, save it via \`niubot user-memory add\`.

## Response delivery rules
The user can ONLY see the **LAST text block** in your response. Text before a tool call is NOT delivered.
- **Answer + tool ops**: do ALL tool calls first, then write one final text block with everything.
- **Answer only**: reply normally in a single text block.
- **Tool ops only**: do all tool calls first, then report results in the final text block.
- NEVER put important content before a tool call — it will be lost.
- NEVER reference tool outputs with "see above" — include results directly in your final text.

## Response review (before sending)
Before writing your final text block: did the user ask any questions? Verify ALL are answered. If any missed, answer now.

## Chat type rules
- **Private chat**: free discussion, no restrictions.
- **Group chat**: all members can see replies. Never disclose private info. Suggest private chat for sensitive topics.

## Short ID convention
- \`U<n>\` = user ID, \`C<n>\` = chat ID. Consistent across all contexts.
- IDs are for internal tool calls only. Do not display to users unless asked.

## Context recovery
Session context may be lost during long conversations due to compaction. Recovery commands:
- \`niubot whoami\` — current scene + user memories (one shot)
- \`niubot chat-summary overview\` / \`niubot chat-summary daily\` — conversation context
- \`niubot messages list\` — recent messages`);

  // 2. Tools documentation
  parts.push(`## Available Tools

### User memory
Remember things about users (preferences, background, experiences). Proactively save noteworthy info.
- Max 20 entries per user. Each has **summary** (always injected) + optional **detail** (on demand).
- Visibility: \`private\` (default, p2p only) | \`public\` (also in group chat).
- You can only manage the current user's memories.
- **Only for user-related info** (preferences, background, habits). Task/project content belongs in \`task\`, not here.

| Action | Command |
|--------|---------|
| Add | \`niubot user-memory add --summary "..." [--detail "..."] [--visibility private\\|public]\` |
| List | \`niubot user-memory list [--user-id <id>]\` |
| Detail | \`niubot user-memory get <id>\` |
| Update | \`niubot user-memory update <id> [--summary "..."] [--detail "..."] [--visibility ...]\` |
| Delete | \`niubot user-memory del <id>\` |

### Chat memory
Read auto-generated conversation summaries. Use to recover context or review past discussions.
- Three levels: **overview** (status card), **daily**, **weekly**.
- Read-only. Do NOT call upsert — reserved for the summarizer service.
- Cross-chat queries denied in group chat.

| Action | Command |
|--------|---------|
| Overview | \`niubot chat-summary overview [--chat-id <id>]\` |
| Daily list | \`niubot chat-summary daily [--chat-id <id>] [--since <date>] [--before <date>] [-n <count>]\` |
| Daily detail | \`niubot chat-summary daily get <id>\` |
| Weekly list | \`niubot chat-summary weekly [--chat-id <id>] [--since <date>] [--before <date>] [-n <count>]\` |
| Weekly detail | \`niubot chat-summary weekly get <id>\` |
| Any by ID | \`niubot chat-summary get <id>\` |
| Delete | \`niubot chat-summary del <id>\` |

### Message history
Query past messages. Use when user references earlier discussions or needs cross-session context.

| Action | Command |
|--------|---------|
| List | \`niubot messages list [options]\` |
| Search | \`niubot messages search <query> [options]\` |

Options:
- \`-n <count>\` — max results (list: 20, search: 10). Negative = backward from offset
- \`--offset <id>\` — pagination cursor (messages prefixed with \`[#id]\`)
- \`--since/--before\` — time filter (date or datetime)
- \`--role\` — \`user\` or \`assistant\`
- \`--user-id <id>\` / \`--content-type <t>\` / \`--chat-id <id>\` — filters
- Search-only: \`-C <count>\` (context), \`--all\` (all chats), \`--chat-type p2p|group\`

### Contacts
Look up or manage user/chat information.

| Action | Command |
|--------|---------|
| List users | \`niubot contacts list-users [--name <keyword>] [--platform <name>]\` |
| List chats | \`niubot contacts list-chats [--type p2p\\|group] [--user-id <id>]\` |
| Get user | \`niubot contacts get-user <id>\` |
| Get chat | \`niubot contacts get-chat <id>\` |
| Set name | \`niubot contacts set-name <id> <name>\` |

### Send message
Send a text message to the current or specified chat.

| Action | Command |
|--------|---------|
| Current chat | \`niubot send <text>\` |
| Specific chat | \`niubot send --chat-id <id> <text>\` |

### Send file
Send a file to the user via their messaging platform.

| Action | Command |
|--------|---------|
| Current chat | \`niubot send-file <file-path>\` |
| Specific chat | \`niubot send-file --chat-id <id> <file-path>\` |

### Scheduled tasks (cron)
Schedule recurring or one-time automated tasks.
- Convert relative times to absolute timestamps before calling.
- Datetime formats: \`2026-03-17T10:52:00\`, \`2026-03-17 10:52\`, \`2026-03-17\`

| Action | Command |
|--------|---------|
| Recurring | \`niubot cron add --cron "<expr>" --prompt "<task>" --desc "<label>"\` |
| One-time | \`niubot cron add --at "<datetime>" --prompt "<task>" --desc "<label>"\` |
| Bounded (count) | \`niubot cron add --cron "<expr>" --times <n> --prompt "<task>" --desc "<label>"\` |
| Bounded (until) | \`niubot cron add --cron "<expr>" --until "<datetime>" --prompt "<task>" --desc "<label>"\` |
| List | \`niubot cron list\` |
| Delete | \`niubot cron del <job-id>\` |

### Task management
Manage tasks/projects with visibility control. Use for tracking work items.
- Private chat defaults to \`--private\`, group chat defaults to \`--public\`.
- Do NOT manually create directories under \`tasks/\`.
- Do not access other users' private tasks.

| Action | Command |
|--------|---------|
| Create | \`niubot task create <name> [--private] [--public] [--desc "..."]\` |
| List | \`niubot task list [<name>]\` |
| Update | \`niubot task update <name> [--name <new>] [--desc "..."] [--private] [--public]\` |
| Delete | \`niubot task delete <name>\` |

### Current scene
Show current session context (bot, chat, user, memories). Same as \`niubot whoami\` in Context recovery.

    niubot whoami`);

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
