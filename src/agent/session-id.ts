import { randomUUID } from "node:crypto";

/**
 * Session 身份只有这三种，禁止混用。
 *
 * 1. ChatSessionId — NiuBot 会话记录
 *    `sessions.id`（8 位），内部主键。`nbt sessions list` 显示这个短号；get/search 短号和原生 id 都能查。
 *
 * 2. EngineHandle — 引擎内部句柄
 *    `AgentSession.id`，形如 `grok_1787630975612_af90f32a`。
 *    只当 CliAgentBackend 的 Map 键。禁止 --resume，禁止写入 `sessions.agent_session_id`。
 *
 * 3. NativeSessionId — backend 原生 id（真会话 id）
 *    grok UUID / claude session / codex thread。
 *    唯一允许 --resume 和落库 `sessions.agent_session_id` 的值。
 *    必须经 `nativeSessionId()` 才能写入或续接。
 */
export type ChatSessionId = string;
export type EngineHandle = string;
export type NativeSessionId = string;

/** EngineHandle：`${backend}_${Date.now()}_${uuid.slice(0, 8)}`。 */
const ENGINE_HANDLE = /^[a-z][a-z0-9-]*_\d{12,}_[0-9a-f]{8}$/i;

export function createEngineHandle(backendName: string): EngineHandle {
  return `${backendName}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

export function isEngineHandle(id: string | null | undefined): boolean {
  return Boolean(id && ENGINE_HANDLE.test(id));
}

/**
 * 只接受 NativeSessionId。EngineHandle、空值、与当前句柄相同的值一律丢掉。
 * persist / resume / 写入 BaseCliSession.agentSessionId 都必须走这里。
 */
export function nativeSessionId(
  reported: string | null | undefined,
  engineHandle?: string | null,
): NativeSessionId | undefined {
  const id = reported?.trim();
  if (!id) return undefined;
  if (engineHandle && id === engineHandle) return undefined;
  if (isEngineHandle(id)) return undefined;
  return id;
}

/** @deprecated 用 nativeSessionId */
export const nativeAgentSessionId = nativeSessionId;
