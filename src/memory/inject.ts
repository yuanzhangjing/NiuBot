import fs from "node:fs";
import type Database from "better-sqlite3";
import { listUserMemory } from "./user-memory.js";
import { formatShortLabel, formatSenderLabel } from "../database/schema.js";
import { listContinuationMessages } from "../messages/store.js";
import { hasEndedUserSession } from "../sessions/store.js";
import { listTasks, type TaskEntry } from "../tasks/store.js";
import { SYSTEM_RULES } from "../system-rules.js";

/** 续接上下文：注入该 chat 最近消息条数 */
const CONTINUATION_TAIL_COUNT = 20;
/** 续接上下文总字符预算，超出时从最旧消息开始移除 */
const CONTINUATION_TOTAL_MAX_LEN = 20_000;
const LEGACY_DEFAULT_BOT_PROFILE = `# Bot Profile

在这里写 bot 的角色、语气和长期行为边界。`;

/** 新 session 首条消息：引导 agent 按需检索历史上下文 */
export const NEW_SESSION_SEARCH_REMINDER =
`<system-reminder>
这是一个全新的对话 session。如果用户提到历史决策、旧任务或你不确定的背景，先使用 nbt sessions search/get 检索当前聊天的原生 session 记录，不要凭记忆猜测。
</system-reminder>`;

/** compact 后下一条消息：提醒 agent 恢复可能被压缩掉的规则和状态 */
export const COMPACT_RECOVERY_REMINDER =
`<compact-recovery>
上一次 agent 会话发生了上下文压缩，早先注入的规则或历史细节可能已被摘要。
如果 NiuBot 系统规则丢失，先运行 nbt system-rules。
如果当前身份、会话或用户记忆丢失，运行 nbt whoami。
如果最近对话丢失，运行 nbt messages list。
如果历史对话细节丢失，使用 nbt sessions search/get 检索当前聊天的原生 session 记录。
如果任务状态丢失，运行 nbt task list，并读取对应 task README。
如果问题涉及项目规则原文，重新读取 workspace 的 AGENTS.md。
不要把 compact 摘要当成原文。
</compact-recovery>`;

export interface StableSystemContextOptions {
  botProfilePath?: string;
  personaPath?: string;
  instructionsPath?: string;
  botName?: string;
  botLabel?: string;
}

export function buildStableSystemContext(options: StableSystemContextOptions = {}): string {
  const parts = [SYSTEM_RULES];
  const botIdentity = buildBotIdentityContext(options);
  if (botIdentity) {
    parts.push(botIdentity);
  }
  const botProfile = readContextFile(options.botProfilePath);
  if (botProfile && !isDefaultBotProfile(botProfile)) {
    parts.push(`<bot-profile>\n${botProfile}\n</bot-profile>`);
    return parts.join("\n\n");
  }

  const persona = readContextFile(options.personaPath);
  if (persona) {
    parts.push(`<bot-persona>\n${persona}\n</bot-persona>`);
  }
  const instructions = readContextFile(options.instructionsPath);
  if (instructions && !isDefaultInstructions(instructions)) {
    parts.push(`<bot-instructions>\n${instructions}\n</bot-instructions>`);
  }
  return parts.join("\n\n");
}

function buildBotIdentityContext(options: StableSystemContextOptions): string | undefined {
  const botDisplay = options.botLabel ?? options.botName;
  if (!botDisplay) return undefined;

  const botName = options.botName ?? extractNameFromShortLabel(options.botLabel);
  const lines = [
    `你就是当前 Bot：${botDisplay}。`,
  ];
  if (botName) {
    lines.push(`对用户来说，你是 ${botName}。`);
  }
  lines.push("不要把 agent、backend、模型或 session 当作用户可见身份。");
  return `<bot-identity>\n${lines.join("\n")}\n</bot-identity>`;
}

function extractNameFromShortLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const match = label.match(/^[^(]+\((.+)\)$/);
  return match?.[1]?.trim() || undefined;
}

function readContextFile(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content.length > 0 ? content : undefined;
  } catch {
    return undefined;
  }
}

function isDefaultInstructions(content: string): boolean {
  return content.includes("在这里写这个 bot 的长期职责、做事规则和边界。");
}

function isDefaultBotProfile(content: string): boolean {
  return normalizeContext(content) === normalizeContext(LEGACY_DEFAULT_BOT_PROFILE);
}

function normalizeContext(content: string): string {
  return content.trim().replace(/\r\n/g, "\n");
}

// ── Session profile (场景 + 私聊用户记忆) ──────────────────

export interface SceneInfo {
  botName: string;
  /** Bot 的 short label，如 "U2(NiuBot)" */
  botLabel?: string;
  /** IM 平台标识，如 "feishu" */
  platform?: string;
  userName?: string;
  /** 群聊时可省略（身份信息改为消息级注入） */
  userId?: string;
  /** 仅私聊管理员可见 */
  botProfilePath?: string;
  chatId: string;
  chatType: "p2p" | "group";
  /** Chat 的 short label，如 "C1(U1(Zen))" */
  chatLabel?: string;
  isAdmin?: boolean;
}

/**
 * 构建 session profile：当前场景 + 私聊用户记忆。
 * 新 session 和 compact recovery 都会通过 user prompt 前缀注入。
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
      if (scene.botProfilePath) {
        sceneLines.push(`Bot profile：${scene.botProfilePath}`);
      }
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

// ── Task and conversation context (可以接受 compact 压缩) ──────

/**
 * 构建 task/conversation 上下文：task 索引 + session 归档目录 + 续接消息。
 * 注入 user prompt 前缀。
 */
export function buildNormalContext(
  db: Database.Database,
  chatId: string,
  workingDirectory: string,
  beforeMsgId?: number,
  chatType: "p2p" | "group" = "p2p",
  userId?: string,
  sessionArchiveDirectory?: string,
): string {
  const parts: string[] = [];

  // 1. 活跃任务索引（统一走 task 管理接口做可见性过滤）
  const taskContext = buildActiveTaskContext(workingDirectory, chatType, userId);
  if (taskContext) parts.push(taskContext);

  // 2. 当前 chat 的完整 session 归档入口
  if (sessionArchiveDirectory) parts.push(buildSessionArchiveContext(sessionArchiveDirectory));

  // 3. 续接上下文：最近对话尾部消息 — 最微观，紧接用户新消息
  const continuation = buildContinuationContext(db, chatId, beforeMsgId);
  if (continuation) {
    parts.push(continuation);
  }

  return parts.join("\n\n");
}

export function buildSessionArchiveContext(sessionArchiveDirectory: string): string {
  return `<session-archives path=${JSON.stringify(sessionArchiveDirectory)}>\n这里保存当前聊天已归档 session 的原生记录链接和元数据。需要恢复更早的事实、决策或执行过程时，使用 nbt sessions list/search/get 检索和解析。\n</session-archives>`;
}

export function buildActiveTaskContext(
  workingDirectory: string,
  chatType: "p2p" | "group" = "p2p",
  userId?: string,
): string {
  const taskBriefs = buildTaskIndex(workingDirectory, chatType, userId);
  return taskBriefs.length > 0
    ? `<active-tasks>\n${taskBriefs.join("\n")}\n</active-tasks>`
    : "";
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
  if (!hasEndedUserSession(db, chatId)) return null;

  // 捞该 chat 最近 N 条消息（截止到当前消息之前，避免把用户刚发的消息当历史注入）
  const rows = listContinuationMessages(db, { chatId, beforeMsgId, limit: CONTINUATION_TAIL_COUNT });

  if (rows.length === 0) return null;

  const lines = rows.map((r) => {
    const sender = formatSenderLabel(r.sender_id, r.sender_name, r.role);
    const text = r.content_text.trim();
    return `${sender}: ${text}`;
  });

  while (lines.length > 1 && lines.join("\n").length > CONTINUATION_TOTAL_MAX_LEN) {
    lines.shift();
  }
  if (lines.length === 1 && lines[0]!.length > CONTINUATION_TOTAL_MAX_LEN) {
    lines[0] = `…${lines[0]!.slice(-(CONTINUATION_TOTAL_MAX_LEN - 1))}`;
  }

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
