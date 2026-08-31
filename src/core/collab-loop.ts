/**
 * 多 Bot 协作回合协议。
 *
 * 这里故意只使用平台稳定用户 ID。每个 Bot 的本地 users.id 可能不同，
 * 不能把本地短号当成跨设备协议字段。
 */

export type CollabStatus = "running" | "finished" | "stopped" | "blocked";

export type CollabParticipant = {
  platformId: string;
  name?: string;
};

export type CollabTurnDecision =
  | { action: "handoff"; to: string }
  | { action: "finish" };

export type CollabState = {
  /** 从启动消息稳定推导的短链号；跨设备协议字段。 */
  chainId: string;
  scopeKey: string;
  chatId: string;
  threadId?: string;
  participants: CollabParticipant[];
  currentBotId: string;
  /** 当前 Bot 的回合编号，从 1 开始。 */
  turn: number;
  status: CollabStatus;
  startPlatformMsgId: string;
  lastPlatformMsgId?: string;
  lastRunId?: string;
};

export type CollabMention = {
  platformUserId?: string;
  name?: string;
  isBot?: boolean;
  isApp?: boolean;
};

export type CollabHistoryMessage = {
  senderPlatformId?: string;
  senderIsBot?: boolean;
  platformMsgId?: string;
  contentText?: string;
  mentions?: CollabMention[];
};

export type CollabDecisionErrorCode =
  | "missing"
  | "invalid-action"
  | "missing-target"
  | "unknown-target"
  | "self-target"
  | "not-current"
  | "not-running";

export type CollabDecisionValidation =
  | { ok: true; decision: CollabTurnDecision }
  | { ok: false; code: CollabDecisionErrorCode; message: string };

export type CollabMessageProtocol = {
  chainId: string;
  turn: number;
  finished: boolean;
};

const COLLAB_PROTOCOL_RE = /〔协作 #([A-Z0-9]{8}) · 第 ([1-9]\d*) 回合( · 完成)?〕/g;

/** 启动消息是唯一跨设备共同可见的链根，短号只用于消息展示和快速匹配。 */
export function collabChainId(startPlatformMsgId: string): string {
  return createHash("sha256").update(`niubot/collab/v1:${startPlatformMsgId}`).digest("hex").slice(0, 8).toUpperCase();
}

/** 协作协议由 Engine 追加到正文末尾，Agent 输出不得自行承担该职责。 */
export function renderCollabProtocol(protocol: CollabMessageProtocol): string {
  return `〔协作 #${protocol.chainId} · 第 ${protocol.turn} 回合${protocol.finished ? " · 完成" : ""}〕`;
}

/** 取正文中最后一条协议；卡片 footer 可能在它后面，因此不要求字符串绝对结尾。 */
export function parseCollabProtocol(text: string): CollabMessageProtocol | undefined {
  let result: CollabMessageProtocol | undefined;
  for (const match of text.matchAll(COLLAB_PROTOCOL_RE)) {
    const turn = Number(match[2]);
    if (!Number.isSafeInteger(turn) || turn < 1) continue;
    result = { chainId: match[1]!, turn, finished: Boolean(match[3]) };
  }
  return result;
}

/** 防止 Agent 回显或伪造协议行；唯一可信来源是 Engine。 */
export function stripCollabProtocols(text: string): string {
  return text.replace(COLLAB_PROTOCOL_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** 按平台消息中的出现顺序提取唯一的应用/Bot 参与者。 */
export function collectCollabParticipants(mentions: readonly CollabMention[] | undefined): CollabParticipant[] {
  const participants: CollabParticipant[] = [];
  const seen = new Set<string>();
  for (const mention of mentions ?? []) {
    const platformId = mention.platformUserId?.trim();
    if (!platformId || (!mention.isApp && !mention.isBot) || seen.has(platformId)) continue;
    seen.add(platformId);
    participants.push({
      platformId,
      name: mention.name?.trim() || undefined,
    });
  }
  return participants;
}

/** 判断一条人类消息是否显式启动了多 Bot 协作。 */
export function isCollabStartMessage(message: CollabHistoryMessage): boolean {
  return !message.senderIsBot && collectCollabParticipants(message.mentions).length >= 2;
}

/** 为第一个被 @ 的 Bot 创建协作状态；其他被 @ 的 Bot 只保存这条消息。 */
export function createCollabState(input: {
  scopeKey: string;
  chatId: string;
  threadId?: string;
  startPlatformMsgId?: string;
  mentions?: readonly CollabMention[];
  currentBotId: string;
}): CollabState | undefined {
  const participants = collectCollabParticipants(input.mentions);
  const startPlatformMsgId = input.startPlatformMsgId?.trim();
  if (participants.length < 2 || !startPlatformMsgId) return undefined;
  if (participants[0]?.platformId !== input.currentBotId) return undefined;
  return {
    chainId: collabChainId(startPlatformMsgId),
    scopeKey: input.scopeKey,
    chatId: input.chatId,
    threadId: input.threadId,
    participants,
    currentBotId: input.currentBotId,
    turn: 1,
    status: "running",
    startPlatformMsgId,
  };
}

/** 严格校验 Agent 提交的回合动作。 */
export function validateCollabTurnDecision(
  raw: unknown,
  state: CollabState,
  currentBotId: string,
): CollabDecisionValidation {
  if (state.status !== "running") {
    return { ok: false, code: "not-running", message: "协作回合已经结束，不能再次提交动作。" };
  }
  if (state.currentBotId !== currentBotId) {
    return { ok: false, code: "not-current", message: "当前 Bot 不是这一回合的执行者。" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "missing", message: "必须提交一次协作回合动作。" };
  }
  const value = raw as Record<string, unknown>;
  if (value.action === "finish") {
    return { ok: true, decision: { action: "finish" } };
  }
  if (value.action !== "handoff") {
    return { ok: false, code: "invalid-action", message: "动作必须是 handoff 或 finish。" };
  }
  if (typeof value.to !== "string" || !value.to.trim()) {
    return { ok: false, code: "missing-target", message: "handoff 必须带目标 Bot 的稳定平台 ID。" };
  }
  const target = value.to.trim();
  if (!state.participants.some((participant) => participant.platformId === target)) {
    return { ok: false, code: "unknown-target", message: "handoff 目标不在本次协作参与者中。" };
  }
  if (target === currentBotId) {
    return { ok: false, code: "self-target", message: "handoff 不能指向当前 Bot 自己。" };
  }
  return { ok: true, decision: { action: "handoff", to: target } };
}

/** 在消息发送成功后推进本地状态。发送失败时不要调用此函数。 */
export function applyCollabDecision(
  state: CollabState,
  decision: CollabTurnDecision,
  platformMsgId?: string,
  runId?: string,
): CollabState {
  const next: CollabState = {
    ...state,
    lastPlatformMsgId: platformMsgId ?? state.lastPlatformMsgId,
    lastRunId: runId ?? state.lastRunId,
  };
  if (decision.action === "finish") {
    next.status = "finished";
    return next;
  }
  next.currentBotId = decision.to;
  next.turn += 1;
  return next;
}

/** 用 Engine 的结构化动作生成一条全员可收到的协议消息。
 * @ 列表第一个 Bot 是下一棒；finish 时没有执行者，按原参与顺序广播收尾。
 */
export function appendCollabProtocolMessage(
  content: string,
  state: CollabState,
  decision: CollabTurnDecision,
  options: { requester?: CollabParticipant } = {},
): string {
  const executorId = decision.action === "handoff" ? decision.to : undefined;
  const ordered = executorId
    ? [
      state.participants.find((participant) => participant.platformId === executorId)!,
      ...state.participants.filter((participant) => participant.platformId !== executorId),
    ]
    : state.participants;
  const mentions = ordered.map((participant) => {
    const escapedId = escapeAtText(participant.platformId);
    const escapedName = escapeAtText(participant.name?.trim() || participant.platformId);
    return `<at user_id="${escapedId}">${escapedName}</at>`;
  }).join(" ");
  const protocol = renderCollabProtocol({
    chainId: state.chainId,
    turn: decision.action === "handoff" ? state.turn + 1 : state.turn,
    finished: decision.action === "finish",
  });
  const requester = decision.action === "finish" && options.requester
    && !state.participants.some((participant) => participant.platformId === options.requester!.platformId)
    ? `<at user_id="${escapeAtText(options.requester.platformId)}">${escapeAtText(options.requester.name?.trim() || options.requester.platformId)}</at>`
    : "";
  return [content.trim(), requester, mentions, protocol].filter(Boolean).join("\n\n");
}

/**
 * 从本地缓存的消息链重建协作状态。
 * 这用于另一台 Bot 设备收到真实 at 后恢复，不依赖共享数据库或共享内存。
 */
export function rebuildCollabState(input: {
  scopeKey: string;
  chatId: string;
  threadId?: string;
  messages: readonly CollabHistoryMessage[];
}): CollabState | undefined {
  let state: CollabState | undefined;
  for (const message of input.messages) {
    if (isCollabStartMessage(message)) {
      const participants = collectCollabParticipants(message.mentions);
      const startPlatformMsgId = message.platformMsgId?.trim();
      if (!startPlatformMsgId || participants.length < 2) continue;
      state = {
        chainId: collabChainId(startPlatformMsgId),
        scopeKey: input.scopeKey,
        chatId: input.chatId,
        threadId: input.threadId,
        participants,
        currentBotId: participants[0]!.platformId,
        turn: 1,
        status: "running",
        startPlatformMsgId,
      };
      continue;
    }
    if (!state || state.status !== "running" || !message.senderIsBot || !message.senderPlatformId) continue;
    const protocol = parseCollabProtocol(message.contentText ?? "");
    const participants = collectCollabParticipants(message.mentions);
    const participantIds = new Set(participants.map((participant) => participant.platformId));
    const validParticipants = participantIds.size === state.participants.length
      && state.participants.every((participant) => participantIds.has(participant.platformId));
    if (!protocol || protocol.chainId !== state.chainId || !validParticipants
      || message.senderPlatformId !== state.currentBotId) continue;
    if (protocol.finished) {
      if (protocol.turn !== state.turn) continue;
      state = applyCollabDecision(state, { action: "finish" }, message.platformMsgId);
      continue;
    }
    const executor = participants[0]?.platformId;
    if (!executor || executor === state.currentBotId || protocol.turn !== state.turn + 1) continue;
    state = applyCollabDecision(state, { action: "handoff", to: executor }, message.platformMsgId);
  }
  return state;
}

/** 给 Agent 的内部回合上下文。稳定 ID 只供命令使用，不应写入用户正文。 */
export function buildCollabTurnContext(state: CollabState, currentBotId: string): string {
  const participants = state.participants
    .map((participant) => `${participant.name || "未命名 Bot"}: ${participant.platformId}`)
    .join("\n");
  return `<bot-collab-loop>
当前是多 Bot 协作第 ${state.turn} 回合。当前执行者：${currentBotId}
参与者（稳定平台 ID）：
${participants}
先写面向用户的本回合报告，再且只能提交一次动作：
- handoff：执行 \`nbt collab turn --action handoff --to <目标稳定平台 ID>\`
- finish：执行 \`nbt collab turn --action finish\`
引擎会负责发送真实 @。不要在正文里手写 @，不要用自然语言代替动作，也不要提交多个动作。
</bot-collab-loop>`;
}

function escapeAtText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
import { createHash } from "node:crypto";
