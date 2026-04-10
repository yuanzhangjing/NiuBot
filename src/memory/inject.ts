import type Database from "better-sqlite3";
import { listUserMemory } from "./user-memory.js";
import { formatShortLabel, formatSenderLabel } from "../database/schema.js";
import { loadStaticContextTemplate } from "../static-context.js";

/** 冷启动注入最近 session summary 的个数 */
const RECENT_SESSION_SUMMARY_COUNT = 3;
/** 续接上下文：注入上一个 session 尾部消息条数 */
const CONTINUATION_TAIL_COUNT = 5;
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
        topics?: Array<{ title: string; status?: string; summary: string }>;
      };
      const lines: string[] = [];
      if (state.summary) {
        lines.push(state.summary);
      }
      if (state.topics?.length) {
        lines.push("");
        for (const t of state.topics) {
          const status = t.status ? `[${t.status}]` : "";
          lines.push(`- ${t.title}${status}`);
          lines.push(`  ${t.summary}`);
        }
      }
      parts.push(`[对话全局状态]\n${lines.join("\n")}`);
    } catch {
      // state_summary 解析失败，跳过
    }
  }

  // 2. 最近 N 个归档 session 的结构化摘要（短期记忆）
  const recentSessions = getRecentArchivedSessions(db, chatId, RECENT_SESSION_SUMMARY_COUNT);
  if (recentSessions.length > 0) {
    const sessionBlocks = recentSessions.map((s, i) => {
      const lines: string[] = [];
      lines.push(`${i + 1}. ${s.parsed.summary ?? "(无摘要)"}`);
      if (s.parsed.topics?.length) {
        const topicTitles = s.parsed.topics.map((t) => typeof t === "string" ? t : t.title);
        lines.push(`   话题：${topicTitles.join("、")}`);
      }
      // 旧格式：顶层 decisions/open_items
      if (s.parsed.decisions?.length) {
        lines.push(`   决策：${s.parsed.decisions.join("；")}`);
      }
      if (s.parsed.open_items?.length) {
        lines.push(`   遗留：${s.parsed.open_items.join("；")}`);
      }
      return lines.join("\n");
    });
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

function getRecentArchivedSessions(
  db: Database.Database,
  chatId: string,
  limit: number,
): Array<{ id: string; ended_at: string; parsed: ParsedSessionSummary }> {
  const rows = db.prepare(`
    SELECT id, summary, ended_at
    FROM sessions
    WHERE chat_id = ? AND status = 'archived' AND summary IS NOT NULL AND source = 'user'
    ORDER BY ended_at DESC
    LIMIT ?
  `).all(chatId, limit) as Array<{
    id: string;
    summary: string;
    ended_at: string;
  }>;

  const results: Array<{ id: string; ended_at: string; parsed: ParsedSessionSummary }> = [];
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.summary) as ParsedSessionSummary;
      results.push({ id: r.id, ended_at: r.ended_at, parsed });
    } catch { /* skip malformed */ }
  }

  return results;
}

/**
 * 构建续接上下文：上一个 session 的尾部消息 + 引导提示。
 * 让模型意识到自己是在延续一个对话流，而不是从零开始。
 */
function buildContinuationContext(
  db: Database.Database,
  chatId: string,
): string | null {
  // 找到该 chat 最近一个已归档的 user session
  const lastSession = db.prepare(`
    SELECT id FROM sessions
    WHERE chat_id = ? AND status = 'archived' AND source = 'user'
    ORDER BY ended_at DESC
    LIMIT 1
  `).get(chatId) as { id: string } | undefined;

  if (!lastSession) return null;

  // 捞该 session 的最后 N 条消息
  const rows = db.prepare(`
    SELECT m.sender_id, m.role, u.name AS sender_name, m.content_text
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    WHERE m.session_key = ? AND m.content_text IS NOT NULL
    ORDER BY m.id DESC
    LIMIT ?
  `).all(lastSession.id, CONTINUATION_TAIL_COUNT) as Array<{
    sender_id: string | null;
    role: string;
    sender_name: string | null;
    content_text: string;
  }>;

  if (rows.length === 0) return null;

  rows.reverse();

  const lines = rows.map((r) => {
    const sender = formatSenderLabel(r.sender_id, r.sender_name, r.role);
    const text = r.content_text.length > CONTINUATION_MSG_MAX_LEN
      ? r.content_text.slice(0, CONTINUATION_MSG_MAX_LEN) + "…"
      : r.content_text;
    return `${sender}: ${text}`;
  });

  return `[对话延续]\n上一个会话已归档，以下是最后几条消息：\n\n${lines.join("\n")}\n\n结合全局状态和会话摘要，你已具备完整上下文，自然延续即可。`;
}
