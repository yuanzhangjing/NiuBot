import type Database from "better-sqlite3";
import { listUserMemory } from "./user-memory.js";
import { formatShortLabel, formatSenderLabel } from "../database/schema.js";
import { loadStaticContextTemplate } from "../static-context.js";
import { utcToLocalDateTime } from "../tz.js";

/** 冷启动注入最近 session summary 的个数 */
const RECENT_SESSION_SUMMARY_COUNT = 3;
/** 续接上下文：注入该 chat 最近消息条数 */
const CONTINUATION_TAIL_COUNT = 10;
/** 续接上下文：每条消息最大长度 */
const CONTINUATION_MSG_MAX_LEN = 200;

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
  const userDisplay = formatShortLabel(scene.userId, scene.userName);
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
 * 构建 normal 上下文：全局摘要 + 最近 session summaries。
 * 注入 user prompt 前缀。
 */
export function buildNormalContext(
  db: Database.Database,
  chatId: string,
): string {
  const parts: string[] = [];

  // 0. 续接上下文：上一个 session 的尾部消息
  const continuation = buildContinuationContext(db, chatId);
  if (continuation) {
    parts.push(continuation);
  }

  // 1. 全局摘要（长期记忆）
  const chatRow = db.prepare(
    "SELECT state_summary FROM chats WHERE id = ?",
  ).get(chatId) as { state_summary: string | null } | undefined;

  if (chatRow?.state_summary) {
    try {
      const state = JSON.parse(chatRow.state_summary) as {
        summary?: string;
        topics?: Array<{ title: string; status?: string; summary?: string; progress?: string; next?: string }>;
      };
      const lines: string[] = [];
      if (state.summary) {
        lines.push(`[总结] ${state.summary}`);
      }
      if (state.topics?.length) {
        for (const t of state.topics) {
          const status = t.status ? ` [${t.status}]` : "";
          lines.push(`**${t.title}**${status}`);
          // 新格式：progress + next
          if (t.progress) lines.push(`- 进展: ${t.progress}`);
          if (t.next) lines.push(`- 计划: ${t.next}`);
          // 兼容旧格式：summary
          if (!t.progress && !t.next && t.summary) lines.push(`- ${t.summary}`);
        }
      }
      parts.push(`[对话全局状态]\n${lines.join("\n")}`);
    } catch {
      // state_summary 解析失败，跳过
    }
  }

  // 2. 最近 N 个归档 session 的结构化摘要（短期记忆）
  // 最近一个 session 展开写（话题详情、决策、遗留），其余只保留 summary
  const recentSessions = getRecentArchivedSessions(db, chatId, RECENT_SESSION_SUMMARY_COUNT);
  if (recentSessions.length > 0) {
    const sessionBlocks: string[] = [];
    for (let i = 0; i < recentSessions.length; i++) {
      const s = recentSessions[i];
      const header = formatSessionHeader(s);
      if (i === 0) {
        sessionBlocks.push(formatSessionExpanded(header, s.parsed));
      } else {
        sessionBlocks.push(`- ${header}\n  [总结] ${s.parsed.summary ?? "(无摘要)"}`);
      }
    }
    parts.push(`[最近对话]\n${sessionBlocks.join("\n")}`);
  }

  return parts.join("\n\n");
}

// ── Static context (写入 AGENTS.md) ─────────────────────────

/**
 * 生成 AGENTS.md 的内容：行为规则 + 工具文档。
 */
export function buildStaticContext(): string {
  return loadStaticContextTemplate();
}

// ── Internal helpers ────────────────────────────────────────

interface TopicDetail {
  title: string;
  summary?: string;
  progress?: string;
  next?: string;
  decisions?: string[];
  open_items?: string[];
}

interface ParsedSessionSummary {
  summary?: string;
  /** 新格式: TopicDetail[]; 旧格式: string[] */
  topics?: (string | TopicDetail)[];
  /** 旧格式顶层 decisions，新格式在 topics 内部 */
  decisions?: string[];
  open_items?: string[];
}

/** Session 元信息头：[id] 时间 ~ 时间, N条, #start~#end */
function formatSessionHeader(s: ArchivedSessionInfo): string {
  const shortId = s.id.slice(0, 8);
  const start = utcToLocalDateTime(s.startedAt);
  const end = utcToLocalDateTime(s.endedAt);
  // 同一天只显示一次日期：2026-04-10 16:30 ~ 17:46
  const endDisplay = start.slice(0, 10) === end.slice(0, 10) ? end.slice(11) : end;
  const meta = s.startMsgId > 0 ? `, ${s.msgCount}条, #${s.startMsgId}~#${s.endMsgId}` : "";
  return `[${shortId}] ${start} ~ ${endDisplay}${meta}`;
}

/** 展开格式化最近一个 session */
function formatSessionExpanded(header: string, parsed: ParsedSessionSummary): string {
  const lines: string[] = [];
  lines.push(`- ${header}`);
  lines.push(`  [总结] ${parsed.summary ?? "(无摘要)"}`);

  if (parsed.topics?.length) {
    for (const t of parsed.topics) {
      if (typeof t === "string") {
        lines.push(`  **${t}**`);
        continue;
      }
      lines.push(`  **${t.title}**`);
      if (t.summary) lines.push(`  - ${t.summary}`);
      // 兼容旧格式：decisions / open_items
      if (t.decisions?.length) {
        for (const d of t.decisions) lines.push(`  - 决策: ${d}`);
      }
      if (t.open_items?.length) {
        for (const o of t.open_items) lines.push(`  - 待办: ${o}`);
      }
    }
  }

  // 兼容旧格式：顶层 decisions/open_items
  if (parsed.decisions?.length) {
    for (const d of parsed.decisions) lines.push(`  - 决策: ${d}`);
  }
  if (parsed.open_items?.length) {
    for (const o of parsed.open_items) lines.push(`  - 待办: ${o}`);
  }

  return lines.join("\n");
}

interface ArchivedSessionInfo {
  id: string;
  startedAt: string;
  endedAt: string;
  msgCount: number;
  startMsgId: number;
  endMsgId: number;
  parsed: ParsedSessionSummary;
}

function getRecentArchivedSessions(
  db: Database.Database,
  chatId: string,
  limit: number,
): ArchivedSessionInfo[] {
  const rows = db.prepare(`
    SELECT id, summary, started_at, ended_at, start_msg_id, end_msg_id
    FROM sessions
    WHERE chat_id = ? AND status = 'archived' AND summary IS NOT NULL AND source = 'user'
    ORDER BY ended_at DESC
    LIMIT ?
  `).all(chatId, limit) as Array<{
    id: string;
    summary: string;
    started_at: string;
    ended_at: string;
    start_msg_id: number | null;
    end_msg_id: number | null;
  }>;

  const results: ArchivedSessionInfo[] = [];
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.summary) as ParsedSessionSummary;
      const msgCount = (r.start_msg_id != null && r.end_msg_id != null)
        ? r.end_msg_id - r.start_msg_id + 1
        : 0;
      results.push({
        id: r.id,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        msgCount,
        startMsgId: r.start_msg_id ?? 0,
        endMsgId: r.end_msg_id ?? 0,
        parsed,
      });
    } catch { /* skip malformed */ }
  }

  return results;
}

/**
 * 构建续接上下文：该 chat 最近的尾部消息 + 引导提示。
 * 让模型意识到自己是在延续一个对话流，而不是从零开始。
 * 按 chat_id 查最近消息，不按 session_key，避免归档后存的消息（如 /new 回复）被遗漏。
 */
function buildContinuationContext(
  db: Database.Database,
  chatId: string,
): string | null {
  // 确认该 chat 存在已归档的 session（没有历史 session 则不需要续接）
  const hasArchived = db.prepare(`
    SELECT 1 FROM sessions
    WHERE chat_id = ? AND status = 'archived' AND source = 'user'
    LIMIT 1
  `).get(chatId);

  if (!hasArchived) return null;

  // 捞该 chat 最近 N 条消息
  const rows = db.prepare(`
    SELECT m.sender_id, m.role, u.name AS sender_name, m.content_text
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    WHERE m.chat_id = ? AND m.content_text IS NOT NULL
    ORDER BY m.id DESC
    LIMIT ?
  `).all(chatId, CONTINUATION_TAIL_COUNT) as Array<{
    sender_id: string | null;
    role: string;
    sender_name: string | null;
    content_text: string;
  }>;

  if (rows.length === 0) return null;

  rows.reverse();

  const lines = rows.map((r) => {
    const sender = formatSenderLabel(r.sender_id, r.sender_name, r.role);
    let text = r.content_text.replace(/\s+/g, " ").trim();
    if (text.length > CONTINUATION_MSG_MAX_LEN) {
      text = text.slice(0, CONTINUATION_MSG_MAX_LEN) + "…";
    }
    return `${sender} ${text}`;
  });

  return `[对话延续]\n以下是最近的对话记录：\n\n${lines.join("\n")}\n\n不必复述，结合全局状态自然延续即可。`;
}
