import { describe, expect, test } from "vitest";
import { resolveBotRuntimeConfig } from "./runtime-config.js";

describe("resolveBotRuntimeConfig", () => {
  test("uses persisted runtime backend and models", () => {
    const resolved = resolveBotRuntimeConfig(
      "claude",
      { backendType: "codex", model: "gpt-5.5", liteModel: "gpt-5.4-mini" },
      ["claude", "codex"],
    );

    expect(resolved).toEqual({
      backendType: "codex",
      model: "gpt-5.5",
      liteModel: "gpt-5.4-mini",
      defaultLiteModel: "gpt-5.4-mini",
    });
  });

  test("falls back to config backend when persisted backend is unavailable", () => {
    const resolved = resolveBotRuntimeConfig(
      "claude",
      { backendType: "missing-backend", model: "runtime-model" },
      ["claude", "codex"],
    );

    expect(resolved.backendType).toBe("claude");
    expect(resolved.model).toBe("runtime-model");
  });

  test("picks first available backend when no config backend", () => {
    const resolved = resolveBotRuntimeConfig(
      undefined,
      undefined,
      ["codex", "claude"],
    );

    expect(resolved.backendType).toBe("codex");
    expect(resolved.model).toBeUndefined();
    expect(resolved.defaultLiteModel).toBe("gpt-5.4-mini");
  });

  test("uses backend default lite model when no runtime state", () => {
    const resolved = resolveBotRuntimeConfig(
      "claude",
      undefined,
      ["claude", "codex"],
    );

    expect(resolved).toEqual({
      backendType: "claude",
      model: undefined,
      liteModel: "haiku",
      defaultLiteModel: "haiku",
    });
  });

  test("normalizes legacy cursor-agent runtime backend to cursor", () => {
    const resolved = resolveBotRuntimeConfig(
      "claude",
      { backendType: "cursor-agent" },
      ["claude", "cursor"],
    );

    expect(resolved.backendType).toBe("cursor");
    expect(resolved.liteModel).toBe("composer-2.5-fast");
  });

  test("model is undefined when no runtime model set — backend uses its own default", () => {
    const resolved = resolveBotRuntimeConfig(
      "claude",
      { backendType: "codex" },
      ["claude", "codex"],
    );

    expect(resolved.backendType).toBe("codex");
    expect(resolved.model).toBeUndefined();
    expect(resolved.liteModel).toBe("gpt-5.4-mini");
    expect(resolved.defaultLiteModel).toBe("gpt-5.4-mini");
  });
});
