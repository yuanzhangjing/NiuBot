import { describe, expect, test } from "vitest";
import { resolveBotRuntimeConfig } from "./runtime-config.js";

describe("resolveBotRuntimeConfig", () => {
  test("uses the persisted bot default as a complete package", () => {
    expect(resolveBotRuntimeConfig("claude", { backendType: "codex", model: "gpt-5.5", effort: "high" }, ["claude", "codex"]))
      .toEqual({ backendType: "codex", model: "gpt-5.5", effort: "high" });
  });

  test("falls back to config backend as a complete package when persisted backend is unavailable", () => {
    const resolved = resolveBotRuntimeConfig("claude", { backendType: "missing-backend", model: "runtime-model" }, ["claude", "codex"]);
    expect(resolved).toEqual({ backendType: "claude" });
    expect(resolved).not.toHaveProperty("model");
  });

  test("picks first available backend when no config backend", () => {
    expect(resolveBotRuntimeConfig(undefined, undefined, ["codex", "claude"]))
      .toEqual({ backendType: "codex", model: undefined });
  });

  test("normalizes legacy cursor-agent runtime backend to cursor when config backend is unavailable", () => {
    expect(resolveBotRuntimeConfig("missing", { backendType: "cursor-agent" }, ["claude", "cursor"]).backendType).toBe("cursor");
  });
});
