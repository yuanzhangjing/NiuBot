import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INSTALL_GUIDE_COMMAND } from "./install-guide.js";
import {
  generateBotProfileTemplate,
  generateConfigTemplate,
  getTodayLogFilePath,
  getSuggestedLiteModel,
  resolveRunningStatusDetails,
} from "./user-cli.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

  it("includes an output rewrite placeholder in new config.yaml", () => {
    const config = generateConfigTemplate("codex", undefined, "NiuBot", "app-id", "app-secret");

    expect(config).toContain("# Optional final-response rewrite. Off by default; uncomment to enable.");
    expect(config).toContain("# outputRewrite:");
    expect(config).toContain("#   model: deepseek-v4-flash");
    expect(config).toContain("#   # marker_enable: false");
  });

  it("uses the local calendar date for log file paths", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 25, 0, 30, 0));

    expect(getTodayLogFilePath("/tmp/niubot")).toBe("/tmp/niubot/logs/niubot-2026-04-25.log");
  });

  it("reports the running process path, log file, and package version when available", () => {
    const tempDir = makeTempDir("niubot-status-");
    const runningRoot = path.join(tempDir, "release", "package");
    const realLog = path.join(tempDir, "logs", "niubot-2026-05-12.log");
    const todayLog = path.join(tempDir, "logs", "niubot-2026-05-21.log");
    fs.mkdirSync(runningRoot, { recursive: true });
    fs.mkdirSync(path.dirname(realLog), { recursive: true });
    fs.writeFileSync(path.join(runningRoot, "package.json"), JSON.stringify({ name: "@yuanzhangjing/niubot", version: "1.2.3" }));
    fs.writeFileSync(realLog, "");
    fs.writeFileSync(path.join(tempDir, "niubot.version"), "0.9.0");

    const details = resolveRunningStatusDetails({
      niubotHome: tempDir,
      cliPath: "/repo/dist",
      todayLogFile: todayLog,
      processCwd: runningRoot,
      processStdoutPath: realLog,
    });

    expect(details.version).toBe("1.2.3");
    expect(details.path).toBe(runningRoot);
    expect(details.logFile).toBe(realLog);
  });

  it("ignores unrelated process cwd packages and non-file stdout paths", () => {
    const tempDir = makeTempDir("niubot-status-");
    const unrelatedRoot = path.join(tempDir, "other-project");
    const stdoutDir = path.join(tempDir, "stdout-dir");
    const todayLog = path.join(tempDir, "logs", "niubot-2026-05-21.log");
    fs.mkdirSync(unrelatedRoot, { recursive: true });
    fs.mkdirSync(stdoutDir, { recursive: true });
    fs.writeFileSync(path.join(unrelatedRoot, "package.json"), JSON.stringify({ name: "other-project", version: "9.9.9" }));
    fs.writeFileSync(path.join(tempDir, "niubot.version"), "0.9.0");

    const details = resolveRunningStatusDetails({
      niubotHome: tempDir,
      cliPath: "/repo/dist",
      todayLogFile: todayLog,
      processCwd: unrelatedRoot,
      processStdoutPath: stdoutDir,
    });

    expect(details.version).toBe("0.9.0");
    expect(details.path).toBe("/repo/dist");
    expect(details.logFile).toBe(todayLog);
  });

  it("limits bot profile updates to admins in the default template", () => {
    const profile = generateBotProfileTemplate();

    expect(profile).toContain("只有管理员可以要求 bot 修改此文件");
    expect(profile).toContain("# Bot Profile");
    expect(profile).toContain("简洁清晰、有温度");
    expect(profile).toContain("平实中文");
    expect(profile).not.toContain("当前工作区");
    expect(profile).not.toContain("repos/");
    expect(profile).not.toContain("tmp/");
    expect(profile).not.toContain("NiuBot Engine");
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
