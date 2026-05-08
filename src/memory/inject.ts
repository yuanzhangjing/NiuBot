import type Database from "better-sqlite3";
import { listUserMemory } from "./user-memory.js";
import { formatShortLabel, formatSenderLabel } from "../database/schema.js";
import { listContinuationMessages } from "../messages/store.js";
import { hasUserArchivedSession, listRecentUserArchivedSessions } from "../sessions/store.js";
import { listTasks, type TaskEntry } from "../tasks/store.js";
import { utcDateTimeForSql, utcToLocalDateTime } from "../tz.js";

/** 冷启动注入最近 session 的时间窗口（小时） */
const RECENT_SESSION_HOURS = 168;
/** 冷启动注入最近 session 的最大条数 */
const RECENT_SESSION_MAX_COUNT = 10;
/** 续接上下文：注入该 chat 最近消息条数 */
const CONTINUATION_TAIL_COUNT = 10;
/** 续接上下文：每条消息最大长度 */
const CONTINUATION_MSG_MAX_LEN = 200;

/** 新 session 首条消息：引导 agent 按需检索历史上下文 */
export const NEW_SESSION_SEARCH_REMINDER =
`<system-reminder>
这是一个全新的对话 session。如果用户提到历史决策、旧任务或你不确定的背景，先用 nbt 检索再回答，不要凭记忆猜测。
</system-reminder>`;

// ── Important context (不能被 compact 丢失) ──────────────────

export interface SceneInfo {
  botName: string;
  /** Bot 的 short label，如 "U2(NiuBot)" */
  botLabel?: string;
  /** IM 平台标识，如 "feishu" */
  platform?: string;
  userName?: string;
  /** 群聊时可省略（身份信息改为消息级注入） */
  userId?: string;
  chatId: string;
  chatType: "p2p" | "group";
  /** Chat 的 short label，如 "C1(U1(Zen))" */
  chatLabel?: string;
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
  const isGroup = scene.chatType === "group";

  // 1. 当前场景
  const sceneLines: string[] = [];
  const botDisplay = scene.botLabel ?? scene.botName;
  sceneLines.push(`Bot：${botDisplay}`);
  if (scene.platform) {
    sceneLines.push(`平台：${scene.platform}`);
  }
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
  }
  parts.push(`<current-scene>\n${sceneLines.join("\n")}\n</current-scene>`);

  // 2. User memory（仅私聊注入，群聊由消息级注入）
  if (!isGroup && scene.userId) {
    const memories = listUserMemory(db, scene.userId);

    if (memories.length > 0) {
      const label = scene.userName ? `关于 ${scene.userName} 的记忆` : "关于用户的记忆";
      const lines = memories.map((m) => `  #${m.id}  ${m.summary}`);
      lines.push("用 nbt user-memory get <id> 查看详情。");
      const safeLabel = label.replace(/["<>&]/g, "");
      parts.push(`<user-memory label="${safeLabel}">\n${lines.join("\n")}\n</user-memory>`);
    }
  }

  const inner = parts.join("\n\n");
  return `<session-profile desc="上下文压缩时必须保留，丢失后用 nbt whoami 恢复">\n${inner}\n</session-profile>`;
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
  userId?: string,
): string {
  const parts: string[] = [];

  // 1. 活跃任务索引（统一走 task 管理接口做可见性过滤）
  const taskBriefs = buildTaskIndex(workingDirectory, chatType, userId);
  if (taskBriefs.length > 0) {
    parts.push(`<active-tasks>\n${taskBriefs.join("\n")}\n</active-tasks>`);
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

  return parts.join("\n\n");
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
  const since = utcDateTimeForSql(new Date(Date.now() - hours * 3600_000));
  const rows = listRecentUserArchivedSessions(db, { chatId, since, limit: maxCount });

  const results: ArchivedSessionInfo[] = [];
  for (const r of rows) {
    if (!r.ended_at) continue;
    try {
      const parsed = JSON.parse(r.summary ?? "") as ParsedSessionSummary;
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
  if (!hasUserArchivedSession(db, chatId)) return null;

  // 捞该 chat 最近 N 条消息（截止到当前消息之前，避免把用户刚发的消息当历史注入）
  const rows = listContinuationMessages(db, { chatId, beforeMsgId, limit: CONTINUATION_TAIL_COUNT });

  if (rows.length === 0) return null;

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

/**
 * 通过 task 管理接口读取活跃任务列表，生成简要索引。
 */
function buildTaskIndex(workingDirectory: string, chatType: "p2p" | "group" = "p2p", userId?: string): string[] {
  const active = listTasks({ workingDirectory, chatType, userId });
  return active.map(formatTaskBrief);
}

function formatTaskBrief(t: TaskEntry): string {
  const desc = t.description
    ? ` — ${t.description.length > 200 ? t.description.slice(0, 200) + "…" : t.description}`
    : "";
  return `- ${t.name} (${t.path})${desc}`;
}
