import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import yaml from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INSTALL_GUIDE_COMMAND } from "./install-guide.js";
import {
  appendBotToConfig,
  generateBotProfileTemplate,
  generateConfigTemplate,
  getTodayLogFilePath,
  inspectBotStatuses,
  resolveRunningStatusDetails,
  parseNiubotVersionOutput,
  resolveNiubotHome,
  collectStatusHomes,
  decideProductionUpdate,
  readRegisteredHomes,
  registerHomePath,
  runSequentialHomeUpdates,
} from "./user-cli.js";
import { writeAutoUpdateEnabledToConfig } from "./config.js";

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

describe("add-bot config update", () => {
  it("re-reads the locked config and preserves an auto-update change made during earlier interaction", () => {
    const dir = makeTempDir("niubot-add-bot-config-");
    const configPath = path.join(dir, "config.yaml");
    fs.writeFileSync(configPath, yaml.stringify({
      bots: [{ id: "Existing", appId: "id", appSecret: "secret" }],
      autoUpdate: false,
    }));

    // 模拟 add-bot 已读过旧配置，但交互期间 Engine 开启了自动升级。
    writeAutoUpdateEnabledToConfig(configPath, true);
    appendBotToConfig(configPath, { id: "Added", backend: "codex", appId: "new-id", appSecret: "new-secret" });

    const updated = yaml.parse(fs.readFileSync(configPath, "utf-8"));
    expect(updated.autoUpdate).toBe(true);
    expect(updated.bots.map((bot: { id: string }) => bot.id)).toEqual(["Existing", "Added"]);
  });
});

describe("user-cli init model configuration", () => {
  it("parses niubot version command output", () => {
    expect(parseNiubotVersionOutput("niubot v0.1.81\n")).toBe("0.1.81");
    expect(parseNiubotVersionOutput("unexpected\n")).toBeUndefined();
  });

  it("resolves relative NIUBOT_HOME before passing it to the engine", () => {
    const cwd = path.resolve(os.tmpdir(), "workspace");
    expect(resolveNiubotHome(".niubot-2", undefined, cwd)).toBe(path.resolve(cwd, ".niubot-2"));
    expect(resolveNiubotHome(undefined, ".env-home", cwd)).toBe(path.resolve(cwd, ".env-home"));
    const absolute = path.resolve(os.tmpdir(), "absolute-home");
    expect(resolveNiubotHome(absolute, ".env-home", cwd)).toBe(absolute);
  });

  it("stores registered homes as a de-duplicated path list", () => {
    const tempDir = makeTempDir("niubot-home-registry-");
    const registryPath = path.join(tempDir, "instances.json");
    const firstHome = path.join(tempDir, "niubot-a");
    const secondHome = path.join(tempDir, "niubot-b");

    registerHomePath(registryPath, firstHome);
    registerHomePath(registryPath, firstHome);
    registerHomePath(registryPath, secondHome);

    expect(readRegisteredHomes(registryPath)).toEqual([firstHome, secondHome]);
  });

  it("collects status homes from the current default home and registry", () => {
    const root = path.resolve(os.tmpdir(), "niubot-status-homes");
    const defaultHome = path.join(root, "default");
    const firstHome = path.join(root, "a");
    const secondHome = path.join(root, "b");
    expect(collectStatusHomes(defaultHome, [firstHome, defaultHome, secondHome]))
      .toEqual([defaultHome, firstHome, secondHome]);
  });

  it("keeps DEV Homes isolated and never downgrades production Homes", () => {
    expect(decideProductionUpdate("0.2.20-dev.3", "0.2.21")).toBe("dev");
    expect(decideProductionUpdate("0.2.20", "0.2.21", "dev")).toBe("dev");
    expect(decideProductionUpdate("0.2.20-beta.1", "0.2.21")).toBe("unsupported");
    expect(decideProductionUpdate("0.2.21", "0.2.21")).toBe("up-to-date");
    expect(decideProductionUpdate("0.2.22", "0.2.21")).toBe("up-to-date");
    expect(decideProductionUpdate("0.2.20", "0.2.21")).toBe("update");
    expect(decideProductionUpdate(undefined, "0.2.21")).toBe("update");
  });

  it("updates registered Homes sequentially and continues after one Home fails", async () => {
    const events: string[] = [];
    await runSequentialHomeUpdates(
      ["home-a", "home-b", "home-c"],
      async (home) => {
        events.push(`start:${home}`);
        if (home === "home-b") throw new Error("broken config");
        events.push(`done:${home}`);
      },
      (home, error) => events.push(`error:${home}:${error instanceof Error ? error.message : String(error)}`),
    );

    expect(events).toEqual([
      "start:home-a",
      "done:home-a",
      "start:home-b",
      "error:home-b:broken config",
      "start:home-c",
      "done:home-c",
    ]);
  });

  it("writes the chosen model into config.yaml", () => {
    const config = generateConfigTemplate("codex", "NiuBot", "app-id", "app-secret", "gpt-5.4");

    expect(config).toContain('model: "gpt-5.4"');
    expect(config).not.toContain('# model: ""');
    expect(config).not.toContain("liteModel");
  });

  it("does not include an output rewrite placeholder in new config.yaml", () => {
    const config = generateConfigTemplate("codex", "NiuBot", "app-id", "app-secret");

    expect(config).not.toContain("outputRewrite");
    expect(config).not.toContain("deepseek-v4-flash");
    expect(config).not.toContain("marker_enable");
  });

  it("uses the local calendar date for log file paths", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 25, 0, 30, 0));

    const home = path.resolve(os.tmpdir(), "niubot-log-home");
    expect(getTodayLogFilePath(home)).toBe(path.join(home, "logs", "niubot-2026-04-25.log"));
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
    fs.writeFileSync(path.join(tempDir, "niubot.node"), "/opt/homebrew/bin/node v22.1.0 ABI 127");

    const details = resolveRunningStatusDetails({
      niubotHome: tempDir,
      cliPath: "/repo/dist",
      todayLogFile: todayLog,
      processCwd: runningRoot,
      processStdoutPath: realLog,
    });

    expect(details.version).toBe("1.2.3");
    expect(details.path).toBe(runningRoot);
    expect(details.node).toBe("/opt/homebrew/bin/node v22.1.0 ABI 127");
    expect(details.logFile).toBe(realLog);
  });

  it("shows Engine and Bot status as separate levels", () => {
    const tempDir = makeTempDir("niubot-status-levels-");
    fs.writeFileSync(
      path.join(tempDir, "config.yaml"),
      generateConfigTemplate("codex", "TestBot", "app-id", "app-secret"),
    );
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const tsxCliPath = path.join(srcDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const output = execFileSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "status", "--home", tempDir],
      { encoding: "utf8" },
    );

    expect(output).toContain(`Home: ${tempDir}`);
    expect(output).toContain("Engine: stopped");
    expect(output).toContain("Bots:");
    expect(output).toContain("TestBot: unavailable");
    expect(output).toContain("API:");
  });

  it("checks running Bot APIs concurrently and distinguishes healthy from unhealthy", async () => {
    const tempDir = makeTempDir("niubot-status-health-");
    fs.writeFileSync(path.join(tempDir, "config.yaml"), [
      "bots:",
      "  - id: HealthyBot",
      "    backend: codex",
      "    appId: app-a",
      "    appSecret: secret-a",
      "  - id: UnhealthyBot",
      "    backend: codex",
      "    appId: app-b",
      "    appSecret: secret-b",
      "",
    ].join("\n"));
    let calls = 0;
    let active = 0;
    let maxActive = 0;

    const statuses = await inspectBotStatuses(tempDir, "running", async () => {
      const index = calls++;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, index === 0 ? 10 : 5));
      active -= 1;
      return index === 0;
    });

    expect(maxActive).toBe(2);
    expect(statuses.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "HealthyBot", status: "healthy" },
      { id: "UnhealthyBot", status: "unhealthy" },
    ]);
  });

  it("does not probe Bot APIs when the Engine is stopped", async () => {
    const tempDir = makeTempDir("niubot-status-stopped-");
    fs.writeFileSync(
      path.join(tempDir, "config.yaml"),
      generateConfigTemplate("codex", "TestBot", "app-id", "app-secret"),
    );
    const probe = vi.fn(async () => true);

    const statuses = await inspectBotStatuses(tempDir, "stopped", probe);

    expect(probe).not.toHaveBeenCalled();
    expect(statuses[0]?.status).toBe("unavailable");
  });

  it("rejects --detach before checking for updates when the Engine is stopped", () => {
    const tempDir = makeTempDir("niubot-update-detach-stopped-");
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const tsxCliPath = path.join(srcDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const result = spawnSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "update", "--detach", "--home", tempDir],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("--detach requires a running Engine");
    expect(result.stdout).not.toContain("Checking npm registry");
  });

  it("requires --home when detaching an update instead of silently detaching a batch", () => {
    const tempDir = makeTempDir("niubot-update-detach-batch-");
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const tsxCliPath = path.join(srcDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const result = spawnSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "update", "--detach"],
      { encoding: "utf8", env: { ...process.env, NIUBOT_HOME: tempDir } },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("--detach requires --home");
    expect(result.stdout).not.toContain("Checking npm registry");
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
    const expectedCommand = "niubot install-guide";
    expect(INSTALL_GUIDE_COMMAND).toBe(expectedCommand);

    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const tsxCliPath = path.join(srcDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const output = execFileSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "--help"],
      { encoding: "utf8" },
    );

    expect(output).toContain(`Agent install guide: run \`${expectedCommand}\` and follow it.`);
    expect(output).toContain("bot list");
    expect(output).toContain("bot add");
    expect(output).toContain("bot export");
    expect(output).toContain("niubot bot --help");
    expect(output).not.toContain("  add-bot");
    expect(output).not.toContain("--include-secrets");
  });

  it("shows command-specific help without running the command", () => {
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const tsxCliPath = path.join(srcDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const statusHelp = execFileSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "status", "--help", "--home", "/missing-home"],
      { encoding: "utf8" },
    );
    const exportHelp = execFileSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "bot", "export", "--help"],
      { encoding: "utf8" },
    );
    const nestedExportHelp = execFileSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "help", "bot", "export"],
      { encoding: "utf8" },
    );
    const addHelp = execFileSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "bot", "add", "--help"],
      { encoding: "utf8" },
    );

    expect(statusHelp).toContain("Usage: niubot status");
    expect(statusHelp).toContain("niubot bot list");
    expect(statusHelp).not.toContain("Home: /missing-home");
    expect(exportHelp).toContain("Usage: niubot bot export <bot-id>");
    expect(exportHelp).toContain("default output is <bot-id>.nbot");
    expect(nestedExportHelp).toBe(exportHelp);
    expect(addHelp).toContain("Usage: niubot bot add [--home <path>]");
  });

  it("rejects unknown help topics instead of showing unrelated help", () => {
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const tsxCliPath = path.join(srcDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const topLevel = spawnSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "help", "statsu"],
      { encoding: "utf8" },
    );
    const bot = spawnSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "bot", "help", "remove"],
      { encoding: "utf8" },
    );

    expect(topLevel.status).toBe(1);
    expect(`${topLevel.stdout}${topLevel.stderr}`).toContain("Unknown command: statsu");
    expect(bot.status).toBe(1);
    expect(`${bot.stdout}${bot.stderr}`).toContain("Unknown Bot command: remove");
  });

  it("lists Bot IDs without the verbose service status output", () => {
    const tempDir = makeTempDir("niubot-bot-list-");
    fs.writeFileSync(path.join(tempDir, "config.yaml"), [
      "bots:",
      "  - id: FirstBot",
      "    backend: codex",
      "    appId: app-a",
      "    appSecret: secret-a",
      "  - id: SecondBot",
      "    backend: codex",
      "    appId: app-b",
      "    appSecret: secret-b",
      "",
    ].join("\n"));
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const tsxCliPath = path.join(srcDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const output = execFileSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "--home", tempDir, "bot", "list"],
      { encoding: "utf8" },
    );

    expect(output).toContain(`Home: ${tempDir}`);
    expect(output).toContain("Bot IDs:\n  FirstBot\n  SecondBot");
    expect(output).not.toContain("Engine:");
    expect(output).not.toContain("API:");
  });

  it("rejects unknown commands instead of silently succeeding", () => {
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const tsxCliPath = path.join(srcDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const result = spawnSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "statsu"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("Unknown command: statsu");
  });

  it("rejects options that belong to another command", () => {
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const tsxCliPath = path.join(srcDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const result = spawnSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "status", "--apply"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("Option --apply is not valid for 'status'");
    expect(`${result.stdout}${result.stderr}`).toContain("Usage: niubot status");
  });

  it("rejects extra positional arguments for top-level commands", () => {
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const tsxCliPath = path.join(srcDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const result = spawnSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "version", "unexpected"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("Unexpected argument for 'version': unexpected");
  });

  it("validates options before showing help and handles version aliases", () => {
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const tsxCliPath = path.join(srcDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const invalid = spawnSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "status", "--help", "--apply"],
      { encoding: "utf8" },
    );
    const invalidWithoutCommand = spawnSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "--apply", "--help"],
      { encoding: "utf8" },
    );
    const versionHelp = execFileSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "--version", "--help"],
      { encoding: "utf8" },
    );
    const helpAlias = execFileSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "help", "--version"],
      { encoding: "utf8" },
    );

    expect(invalid.status).toBe(1);
    expect(`${invalid.stdout}${invalid.stderr}`).toContain("Option --apply is not valid for 'status'");
    expect(invalidWithoutCommand.status).toBe(1);
    expect(`${invalidWithoutCommand.stdout}${invalidWithoutCommand.stderr}`).toContain("Option --apply is not valid without a command");
    expect(versionHelp).toContain("Usage: niubot version [--verbose]");
    expect(helpAlias).toBe(versionHelp);
  });

  it("fails Bot listing for an explicitly invalid home", () => {
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const tsxCliPath = path.join(srcDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const missingHome = path.join(makeTempDir("niubot-missing-home-parent-"), "missing");
    const result = spawnSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "--home", missingHome, "bot", "list"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(`Cannot list Bots in ${missingHome}`);
  });

  it("rejects the global --home option for bot move", () => {
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const tsxCliPath = path.join(srcDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const result = spawnSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "--home", "/ignored", "bot", "move", "--help"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("Option --home is not valid for 'bot move'");
  });

  it("rejects Bot transfer commands from a non-admin agent session", () => {
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const tsxCliPath = path.join(srcDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const result = spawnSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "bot", "export", "TestBot", "--output", "ignored.nbot"],
      {
        encoding: "utf8",
        env: { ...process.env, NIUBOT_AGENT_SESSION: "1", NIUBOT_IS_ADMIN: "false" },
      },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("require an admin session");
  });

  it("applies the same admin check to the legacy add-bot alias", () => {
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const tsxCliPath = path.join(srcDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const result = spawnSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "add-bot"],
      {
        encoding: "utf8",
        env: { ...process.env, NIUBOT_AGENT_SESSION: "1", NIUBOT_IS_ADMIN: "false" },
      },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("Bot commands require an admin session");
  });

  it("prints the packaged installation guide without relying on cat", () => {
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const tsxCliPath = path.join(srcDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
    const output = execFileSync(
      process.execPath,
      [tsxCliPath, path.join(srcDir, "user-cli.ts"), "install-guide"],
      { encoding: "utf8" },
    );

    expect(output).toContain("# NiuBot Installation Guide");
    expect(output).toContain("### Windows");
  });
});
