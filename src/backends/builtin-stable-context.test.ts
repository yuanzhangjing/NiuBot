/**
 * 内置 backend 的 stable context 契约：
 * - needsStableUserPrefix：pipeline 是否前缀注入 / compact 重灌
 * - needsCompactRecoveryReminder：compact 后是否注入恢复提醒
 * - 其余交付由 backend 在 createSession / buildInput 自行处理
 */
import { describe, expect, it } from "vitest";
import ClaudeBackend from "./claude.js";
import CodexBackend from "./codex.js";
import CursorAgentBackend from "./cursor-agent.js";
import OpencodeBackend from "./opencode.js";
import TraeCliBackend from "./traecli.js";
import PiBackend from "./pi.js";

const BUILTIN_BACKENDS = [
  { name: "claude", backend: new ClaudeBackend(), needsPrefix: false },
  { name: "codex", backend: new CodexBackend(), needsPrefix: true },
  { name: "traecli", backend: new TraeCliBackend(), needsPrefix: true },
  { name: "opencode", backend: new OpencodeBackend(), needsPrefix: true },
  { name: "cursor", backend: new CursorAgentBackend(), needsPrefix: false },
  { name: "pi", backend: new PiBackend(), needsPrefix: false },
];

describe("builtin backend stable context", () => {
  it.each(BUILTIN_BACKENDS)("$name needsStableUserPrefix=$needsPrefix", ({ backend, needsPrefix }) => {
    expect(backend.needsStableUserPrefix()).toBe(needsPrefix);
  });

  it("cursor skips compact recovery reminder because workspace rules carry recovery", () => {
    const backend = new CursorAgentBackend();
    expect(backend.needsCompactRecoveryReminder()).toBe(false);
  });
});
