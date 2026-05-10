import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INSTALL_GUIDE_COMMAND } from "./install-guide.js";
import { generateBotProfileTemplate, generateConfigTemplate, getTodayLogFilePath, getSuggestedLiteModel } from "./user-cli.js";

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

  it("limits bot profile updates to admins in the default template", () => {
    const profile = generateBotProfileTemplate();

    expect(profile).toContain("只有管理员可以要求 bot 修改此文件");
    expect(profile).toContain("# Bot Profile");
  });

  it("points agents to INSTALL.md in the top-level help", () => {
    const expectedCommand = "npm explore -g @yuanzhangjing/niubot -- cat INSTALL.md";
    expect(INSTALL_GUIDE_COMMAND).toBe(expectedCommand);

    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const tsxCliPath = path.join(srcDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const output = execFileSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "--help"],
      { encoding: "utf8" },
    );

    expect(output).toContain(`Agent install guide: run \`${expectedCommand}\` and follow it.`);
  });
});
