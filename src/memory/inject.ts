import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import yaml from "yaml";
import { listUserMemory } from "./user-memory.js";
import { formatShortLabel, formatSenderLabel } from "../database/schema.js";
import { loadStaticContextTemplate } from "../static-context.js";
import { utcToLocalDateTime } from "../tz.js";

/** 冷启动注入最近 session 的时间窗口（小时） */
const RECENT_SESSION_HOURS = 168;
/** 冷启动注入最近 session 的最大条数 */
const RECENT_SESSION_MAX_COUNT = 10;
/** 续接上下文：注入该 chat 最近消息条数 */
const CONTINUATION_TAIL_COUNT = 10;
/** 续接上下文：每条消息最大长度 */
const CONTINUATION_MSG_MAX_LEN = 200;

/** 新 session 首条消息：引导 agent 按需检索历史上下文 */
const NEW_SESSION_SEARCH_REMINDER =
`<system-reminder>
这是一个全新的对话 session。你当前的上下文有限，仅包含活跃任务列表和最近一次会话摘要。

如果用户的消息涉及之前讨论过的内容、历史决策、或你不确定的背景信息，请先使用工具检索再回答，不要凭记忆猜测。

可用的检索工具：
- \`niubot sessions list [--since <date>]\` — 查看历史会话列表
- \`niubot sessions search <query>\` — 按关键词搜索历史会话
- \`niubot messages search <query> [-C <n>]\` — 搜索历史消息（支持上下文）
- \`niubot task list\` — 查看全部任务（含 inactive），活跃任务已在上方注入
- 读取 <path>/README.md — 查看具体任务进展（path 见活跃任务列表）

不需要每次都检索。如果用户的意图清晰且不依赖历史上下文（如简单问答、新话题），直接回答即可。
</system-reminder>`;

// ── Important context (不能被 compact 丢失) ──────────────────

export interface SceneInfo {
  botName: string;
  /** Bot 的 short label，如 "U2(NiuBot)" */
  botLabel?: string;
  userName?: string;
  /** 群聊时可省略（身份信息改为消息级注入） */
  userId?: string;
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

  if (isGroup) {
    // 群聊：不在 session 级注入用户身份，由消息级 <current-speaker> 动态注入
  } else if (scene.userId) {
    // 私聊：在 session 级注入用户身份和记忆
    const userDisplay = formatShortLabel(scene.userId, scene.userName);
    if (scene.isAdmin) {
      sceneLines.push(`用户：${userDisplay}（admin）`);
    } else {
      sceneLines.push(`用户：${userDisplay}`);
    }
    if (scene.isAdmin && scene.personaPath) {
      sceneLines.push(`人设配置：${scene.personaPath}（管理员可要求修改）`);
    }
  }
  parts.push(`[当前场景]\n${sceneLines.join("\n")}`);

  // 2. User memory（仅私聊注入，群聊由消息级注入）
  if (!isGroup && scene.userId) {
    const memories = listUserMemory(db, scene.userId);

    if (memories.length > 0) {
      const label = scene.userName ? `关于 ${scene.userName} 的记忆` : "关于用户的记忆";
      const lines = memories.map((m) => `  #${m.id}  ${m.summary}`);
      lines.push("用 niubot user-memory get <id> 查看详情。");
      parts.push(`[${label}]\n${lines.join("\n")}`);
    }
  }

  return parts.join("\n\n");
}

// ── Speaker context (群聊消息级注入) ────────────────────────

export interface SpeakerInfo {
  userId: string;
  userName?: string;
  isAdmin?: boolean;
}

/**
 * 构建群聊消息级 speaker 上下文。
 * 单人消息：`<current-speaker>` 块。
 * 多人合并消息：`<speakers>` 块，列出每个 sender。
 */
export function buildSpeakerContext(
  db: Database.Database,
  speakers: SpeakerInfo[],
): string {
  if (speakers.length === 0) return "";

  if (speakers.length === 1) {
    const s = speakers[0];
    const label = formatShortLabel(s.userId, s.userName);
    const adminTag = s.isAdmin ? "（admin）" : "";
    const lines: string[] = [`用户：${label}${adminTag}`];
    const memories = listUserMemory(db, s.userId, "public");
    if (memories.length > 0) {
      lines.push("记忆：");
      for (const m of memories) {
        lines.push(`  #${m.id}  ${m.summary}`);
      }
    }
    return `<current-speaker>\n${lines.join("\n")}\n</current-speaker>`;
  }

  // 多人合并消息
  const blocks: string[] = [];
  for (const s of speakers) {
    const label = formatShortLabel(s.userId, s.userName);
    const adminTag = s.isAdmin ? "（admin）" : "";
    const memLines: string[] = [];
    const memories = listUserMemory(db, s.userId, "public");
    for (const m of memories) {
      memLines.push(`  #${m.id}  ${m.summary}`);
    }
    blocks.push(memLines.length > 0
      ? `${label}${adminTag}：\n${memLines.join("\n")}`
      : `${label}${adminTag}`);
  }
  return `<speakers>\n${blocks.join("\n")}\n</speakers>`;
}

// ── Normal context (可以接受 compact 压缩) ───────────────────

/**
 * 构建 normal 上下文：task 索引 + 最近 session summary + 续接消息。
 * 注入 user prompt 前缀。
 */
export function buildNormalContext(
  db: Database.Database,
  chatId: string,
  workingDirectory: string,
  beforeMsgId?: number,
  chatType: "p2p" | "group" = "p2p",
): string {
  const parts: string[] = [];

  // 1. 活跃任务索引（实时从 tasks/index.yaml 读取，群聊仅 public）
  const taskBriefs = buildTaskIndex(workingDirectory, chatType);
  if (taskBriefs.length > 0) {
    const lines = ["[活跃任务]", ...taskBriefs];
    parts.push(`<active-tasks>\n${lines.join("\n")}\n</active-tasks>`);
  }

  // 2. 最近归档 session 的摘要（短期记忆）— 最近一条完整，其余精简
  const recentSessions = getRecentArchivedSessions(db, chatId, RECENT_SESSION_HOURS, RECENT_SESSION_MAX_COUNT);
  if (recentSessions.length > 0) {
    const blocks = recentSessions.map((s, i) => {
      const header = formatSessionHeader(s);
      return i === 0
        ? formatSessionBrief(header, s.parsed)
        : formatSessionMeta(header, s.parsed);
    });
    parts.push(`<recent-sessions>\n${blocks.join("\n")}\n</recent-sessions>`);
  }

  // 3. 续接上下文：最近对话尾部消息 — 最微观，紧接用户新消息
  const continuation = buildContinuationContext(db, chatId, beforeMsgId);
  if (continuation) {
    parts.push(continuation);
  }

  // 4. 新 session 引导检索提示
  parts.push(NEW_SESSION_SEARCH_REMINDER);

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
  /** 未闭合的线头：提出但未落地的意图、待验证项 */
  open?: string;
  decisions?: string[];
  open_items?: string[];
}

interface ParsedSessionSummary {
  summary?: string;
  /** 新格式（平铺）：details + open */
  details?: string;
  open?: string;
  /** 旧格式（topics）：兼容已有归档数据 */
  topics?: (string | TopicDetail)[];
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

/** 注入用（完整）：summary + details + open，用于最近一条 session */
function formatSessionBrief(header: string, parsed: ParsedSessionSummary): string {
  const lines: string[] = [];
  lines.push(`- ${header}`);
  lines.push(`  ${parsed.summary ?? "(无摘要)"}`);
  if (parsed.details) lines.push(`  ${parsed.details}`);
  if (parsed.open) lines.push(`  [未完成] ${parsed.open}`);
  return lines.join("\n");
}

/** 注入用（精简）：仅 meta + summary，用于较早的 session */
function formatSessionMeta(header: string, parsed: ParsedSessionSummary): string {
  return `- ${header}\n  ${parsed.summary ?? "(无摘要)"}`;
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
  hours: number,
  maxCount: number,
): ArchivedSessionInfo[] {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = db.prepare(`
    SELECT id, summary, started_at, ended_at, start_msg_id, end_msg_id
    FROM sessions
    WHERE chat_id = ? AND status = 'archived' AND summary IS NOT NULL AND source = 'user'
      AND ended_at >= ?
    ORDER BY ended_at DESC
    LIMIT ?
  `).all(chatId, since, maxCount) as Array<{
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
  beforeMsgId?: number,
): string | null {
  // 确认该 chat 存在已归档的 session（没有历史 session 则不需要续接）
  const hasArchived = db.prepare(`
    SELECT 1 FROM sessions
    WHERE chat_id = ? AND status = 'archived' AND source = 'user'
    LIMIT 1
  `).get(chatId);

  if (!hasArchived) return null;

  // 捞该 chat 最近 N 条消息（截止到当前消息之前，避免把用户刚发的消息当历史注入）
  const cutoff = beforeMsgId != null ? `AND m.id < ?` : "";
  const params: (string | number)[] = [chatId];
  if (beforeMsgId != null) params.push(beforeMsgId);
  params.push(CONTINUATION_TAIL_COUNT);
  const rows = db.prepare(`
    SELECT m.sender_id, m.role, u.name AS sender_name, m.content_text
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    WHERE m.chat_id = ? AND m.content_text IS NOT NULL ${cutoff}
    ORDER BY m.id DESC
    LIMIT ?
  `).all(...params) as Array<{
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
    return `${sender}: ${text}`;
  });

  return `<recent-messages>\n以下是最近的对话记录：\n\n${lines.join("\n")}\n\n不必复述，结合全局状态自然延续即可。\n</recent-messages>`;
}

// ── Task index ─────────────────────────────────────────────

interface TaskEntry {
  name: string;
  description: string;
  path: string;
  owner: string;
  visibility: "public" | "private";
  status?: string;
}

/**
 * 从 tasks/index.yaml 实时读取活跃任务列表，生成简要索引。
 * 只展示非 archived、非 inactive 的任务（名称 + 描述）。
 * 群聊时只展示 public 任务。
 */
function buildTaskIndex(workingDirectory: string, chatType: "p2p" | "group" = "p2p"): string[] {
  const indexPath = path.join(workingDirectory, "tasks", "index.yaml");
  try {
    if (!fs.existsSync(indexPath)) return [];
    const content = fs.readFileSync(indexPath, "utf-8");
    const parsed = yaml.parse(content) as { tasks?: TaskEntry[] } | null;
    if (!parsed?.tasks?.length) return [];

    let active = parsed.tasks.filter((t) => !t.status || t.status === "active");
    if (chatType === "group") {
      active = active.filter((t) => t.visibility === "public");
    }
    if (active.length === 0) return [];

    return active.map((t) => {
      const desc = t.description
        ? ` — ${t.description.length > 200 ? t.description.slice(0, 200) + "…" : t.description}`
        : "";
      return `- ${t.name} (${t.path})${desc}`;
    });
  } catch {
    return [];
  }
}
