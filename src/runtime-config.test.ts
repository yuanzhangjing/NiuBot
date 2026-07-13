import { describe, expect, test } from "vitest";
import { resolveBotRuntimeConfig } from "./runtime-config.js";

describe("resolveBotRuntimeConfig", () => {
  test("uses persisted runtime backend and model", () => {
    expect(resolveBotRuntimeConfig("claude", { backendType: "codex", model: "gpt-5.5" }, ["claude", "codex"]))
      .toEqual({ backendType: "codex", model: "gpt-5.5" });
  });

  test("falls back to config backend when persisted backend is unavailable", () => {
    const resolved = resolveBotRuntimeConfig("claude", { backendType: "missing-backend", model: "runtime-model" }, ["claude", "codex"]);
    expect(resolved).toEqual({ backendType: "claude", model: "runtime-model" });
  });

  test("picks first available backend when no config backend", () => {
    expect(resolveBotRuntimeConfig(undefined, undefined, ["codex", "claude"]))
      .toEqual({ backendType: "codex", model: undefined });
  });

  test("normalizes legacy cursor-agent runtime backend to cursor", () => {
    expect(resolveBotRuntimeConfig("claude", { backendType: "cursor-agent" }, ["claude", "cursor"]).backendType).toBe("cursor");
  });
});
