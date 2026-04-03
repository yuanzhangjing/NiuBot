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

  // 0. 场景规则（群聊隐私 / 私聊自由）
  if (isGroup) {
    parts.push(`你现在在群聊中，回复内容对所有群成员可见。
- 不要提及任何用户隐私信息（个人经历、健康状况、私聊内容等）
- 涉及隐私话题时，引导用户回私聊继续
- 回复面向所有群成员，保持中立`);
  } else {
    parts.push("这是你和用户的私密空间，可以自由讨论。");
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

  // 短标识说明
  parts.push("短标识说明：U+数字（如 U1）是用户的本地唯一标识，C+数字（如 C1）是会话的本地唯一标识。同一用户/会话在所有场景中标识相同，可用于跨会话检索。\n注意：所有 ID 标识（Short ID、平台 user ID 等）仅供内部工具调用使用，对话中不要主动向用户展示，除非用户明确要求。");

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
Do NOT mention NiuBot, Claude, or Anthropic to the user. Present yourself according to your persona (injected in the session context).
The user can ONLY see the LAST text block in your response — any text you write before a tool call is NOT delivered to the user.
Therefore: complete ALL tool calls first, then write your final response containing all important content. Do NOT interleave important content between tool calls.
You MUST include any important results (command output, file content, query results, etc.) directly in your final text. Never assume the user has seen tool outputs, and never reference them with phrases like "see above" or "as shown in the output".
NEVER attempt to start, stop, or restart the NiuBot service from within an agent session. Doing so will kill the process hosting your session, causing a restart loop. Service management must be done by the user from an external terminal.
All user data (memories, messages) must be accessed through niubot CLI tools. Do NOT directly read database files.
Do NOT use the built-in memory system (auto memory). All persistent information must go through niubot tools: \`user-memory\` for user-specific data, \`chat-summary\` for conversation summaries, \`task\` for project tracking.
When you learn something noteworthy about a user, proactively save it as a memory using niubot user-memory add.`);

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
      --chat-id <id>       Specify chat (short ID like C1 or chat_id, default: current chat)

Access control: cross-chat queries are denied in group chat. In private chat, you can only access chats you participate in.

Delete any entry by ID:
  niubot chat-summary del <id>

#### Overview
Each chat has one overview — a "status card" with conversation positioning, topic index, and current focus.

View overview (outputs summary + detail):
  niubot chat-summary overview [--chat-id <id>]

#### Daily
Per-day conversation summaries recording specific discussions and decisions.

List recent dailies (summary only):
  niubot chat-summary daily [options]

Options:
      --chat-id <id>       Specify chat (short ID like C1 or chat_id, default: current chat)
      --since <date>       Only entries after this date
      --before <date>      Only entries before this date
  -n, --limit <count>      Max results (default 7)

View daily detail (summary + detail):
  niubot chat-summary daily get <id>

#### Weekly
Per-week conversation summaries aggregating topics across the week. Covers Monday through Sunday.

List recent weeklies (summary only):
  niubot chat-summary weekly [options]

Options:
      --chat-id <id>       Specify chat (short ID like C1 or chat_id, default: current chat)
      --since <date>       Only entries after this date
      --before <date>      Only entries before this date
  -n, --limit <count>      Max results (default 4)

View weekly detail (summary + detail):
  niubot chat-summary weekly get <id>

View any summary by ID:
  niubot chat-summary get <id>

Notes:
- \`daily get\` / \`weekly get\` by ID also enforces access control on the entry's chat.`);

  parts.push(`### Message history
Query past conversation messages. Use when the user references earlier discussions or needs cross-session context.

List messages (chronological order):
  niubot messages list [options]

Full-text search (supports Chinese):
  niubot messages search <query> [options]

Common options:
  -n, --limit <count>      Max results (list: default 20, search: default 10). Negative = backward from --offset
      --offset <id>        Pagination cursor (exclusive): show messages after [#id], or before [#id] with negative --limit. IDs are global and may not be consecutive within a chat
      --since <time>       Only messages after this time
      --before <time>      Only messages before this time
      --role <role>        Filter by "user" or "assistant"
      --user-id <id>       Filter by sender (short ID like U1 or user_id)
      --content-type <t>   Filter by content type: text/image/audio/file/mixed
      --chat-id <id>       Specify chat (short ID like C1 or chat_id, default: current chat)

  Time supports date ("2026-03-08") or datetime ("2026-03-08 14:30:00").

Output format:
  Each message is prefixed with [#id], a database-assigned sequential ID.
  Use this ID with --offset for pagination (e.g., --offset 1045 to continue from that point).

Search-only options:
  -C, --context <count>    Show N messages before and after each match
      --all                Search across all chats (default: current chat only)
      --chat-type <type>   Filter by chat type: p2p/group (with --all)

Examples:
  niubot messages list
  niubot messages list --user-id U1
  niubot messages list --chat-id C1
  niubot messages list --offset 100 --limit -20   # 20 messages before #100
  niubot messages list --since "2026-03-08" --role user
  niubot messages search "部署"
  niubot messages search "bug" --all --context 3
  niubot messages search "deploy" --all --chat-type group`);

  parts.push(`### Contacts
Query and manage user/chat information.

List users/chats:
  niubot contacts list-users [options]
  niubot contacts list-chats [options]

List options:
  --name <keyword>       Filter by name (substring, case-insensitive)
  --platform <name>      Filter by platform
  --type <type>          (chats only) Filter by "p2p" or "group"
  --user-id <id>         (chats only) Filter by associated user

Get details (accepts short ID like U1/C1 or platform ID):
  niubot contacts get-user <id>
  niubot contacts get-chat <id>

Set user name:
  niubot contacts set-name <id> <name>

Examples:
  niubot contacts list-users
  niubot contacts list-users --name 张三
  niubot contacts list-chats --type group
  niubot contacts list-chats --user-id U1
  niubot contacts get-user U1
  niubot contacts get-chat C1
  niubot contacts set-name U1 张三`);

  parts.push(`### Send message
Send a message to a chat via IPC.

  niubot send <text>
  niubot send --chat-id <id> <text>

### Send file
Send a file to the user via their messaging platform:

  niubot send-file <file-path>
  niubot send-file --chat-id <id> <file-path>

Examples:
  niubot send-file /path/to/report.pdf
  niubot send-file ./screenshot.png`);

  parts.push(`### Scheduled tasks (cron)
When the user asks you to do something on a schedule, use the Bash tool to run:

**Recurring tasks** (cron expression):
  niubot cron add --cron "<min> <hour> <day> <month> <weekday>" --prompt "<task description>" --desc "<short label>"

**One-time tasks at a specific time** (absolute timestamp):
  niubot cron add --at "<datetime>" --prompt "<task description>" --desc "<short label>"

**Bounded recurring tasks** (with execution limits):
  niubot cron add --cron "<expr>" --times <n> --prompt "<task>" --desc "<label>"
  niubot cron add --cron "<expr>" --until "<datetime>" --prompt "<task>" --desc "<label>"

Datetime formats: "2026-03-17T10:52:00", "2026-03-17 10:52", "2026-03-17"
Convert relative times (e.g. "5 minutes from now") to absolute timestamps before calling.

Examples:
  niubot cron add --cron "0 6 * * *" --prompt "Collect GitHub trending repos" --desc "Daily Trending"
  niubot cron add --at "2026-04-05 10:00" --prompt "Remind: meeting" --desc "Meeting"
  niubot cron add --cron "0 9 * * *" --times 10 --prompt "Morning exercise" --desc "10-day challenge"
  niubot cron add --cron "0 18 * * 1,3,5" --until "2026-03-31" --prompt "Review PRs" --desc "PR Review"

List or delete cron jobs:
  niubot cron list
  niubot cron del <job-id>`);

  parts.push(`### Task management
Manage tasks and projects with visibility control. Tasks are organized in a \`tasks/\` directory.
Public tasks are visible to all users. Private tasks are only visible to the owner.

Create a task:
  niubot task create <name> [--private] [--public] [--desc "..."]

  Private chat defaults to --private, group chat defaults to --public.

List visible tasks (public + own private):
  niubot task list [<name>]

Options:
      <name> or --name <name>    Filter tasks whose name contains this substring (case-insensitive)

Update a task (own tasks only):
  niubot task update <name> [--name <new-name>] [--desc "..."] [--private] [--public]

Delete a task (own tasks only, archives):
  niubot task delete <name>

Examples:
  niubot task create my-research --desc "AI research project"
  niubot task create health-tracking --private
  niubot task list
  niubot task list research          # lists tasks with "research" in the name
  niubot task update my-research --desc "Updated description"
  niubot task update my-research --public
  niubot task delete my-research

Notes:
- Always use \`niubot task create\` to create tasks, do not manually create directories under \`tasks/\`.
- Do not access other users' private tasks.`);

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
