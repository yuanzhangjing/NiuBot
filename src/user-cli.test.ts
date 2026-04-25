import { afterEach, describe, expect, it, vi } from "vitest";
import { generateConfigTemplate, getTodayLogFilePath, getSuggestedLiteModel } from "./user-cli.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("user-cli init model configuration", () => {
  it("suggests built-in lite models per backend", () => {
    expect(getSuggestedLiteModel("claude")).toBe("haiku");
    expect(getSuggestedLiteModel("codex")).toBe("gpt-5.4-mini");
    expect(getSuggestedLiteModel("traecli")).toBe("Gemini-3-Flash-Preview");
    expect(getSuggestedLiteModel("my-agent")).toBeUndefined();
  });

  it("writes chosen model settings into config.yaml", () => {
    const config = generateConfigTemplate("codex", undefined, "NiuBot", "app-id", "app-secret", "gpt-5.4", "gpt-5.4-mini");

    expect(config).toContain('model: "gpt-5.4"');
    expect(config).toContain('liteModel: "gpt-5.4-mini"');
    expect(config).not.toContain('# model: ""');
    expect(config).not.toContain('# liteModel: ""');
  });

  it("uses the local calendar date for log file paths", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 25, 0, 30, 0));

    expect(getTodayLogFilePath("/tmp/niubot")).toBe("/tmp/niubot/logs/niubot-2026-04-25.log");
  });
});
