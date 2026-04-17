#!/usr/bin/env node

/**
 * NiuBot User CLI — 面向安装用户的服务管理命令。
 *
 * Commands:
 *   niubot init    — 环境检查 + 配置模板生成
 *   niubot start   — 校验 + 启动服务
 *   niubot stop    — 停止服务
 *   niubot status  — 查看运行状态
 *   niubot update  — 检查并安装最新版本
 *   niubot version — 显示版本号
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { AGENT_REGISTRY, loadConfig, type NiuBotConfig } from "./config.js";

// ── Paths ──────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function getPkgVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ── CLI arg helpers ────────────────────────────────────────

interface CliFlags {
  check?: boolean;
  force?: boolean;
  restart?: boolean;
  home?: string;
}

function parseCliArgs(args: string[]): { command: string | undefined; flags: CliFlags } {
  const flags: CliFlags = {};
  let command: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--check") flags.check = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--restart") flags.restart = true;
    else if (arg === "--home" && i + 1 < args.length) {
      flags.home = args[++i];
    } else if (!arg.startsWith("-") && !command) {
      command = arg;
    }
  }

  return { command, flags };
}

// ── Output helpers ─────────────────────────────────────────

const ok = (msg: string) => console.log(`  \u2713 ${msg}`);
const fail = (msg: string) => console.log(`  \u2717 ${msg}`);
const hint = (msg: string) => console.log(`    \u2192 ${msg}`);
const info = (msg: string) => console.log(`  ${msg}`);

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Checks ─────────────────────────────────────────────────

interface CheckResult {
  passed: boolean;
  label: string;
  hint?: string;
}

function checkBotCredentials(config: NiuBotConfig, issues: string[]): void {
  for (const bot of config.bots) {
    if (!bot.appId || !bot.appSecret) {
      fail(`Bot '${bot.id}' credentials empty`);
      hint("Edit ~/.niubot/config.yaml, fill in appId and appSecret");
      issues.push("credentials");
    } else {
      ok(`Bot '${bot.id}' credentials present`);
    }
  }
}

function checkNodeVersion(): CheckResult {
  const major = parseInt(process.versions.node.split(".")[0]!, 10);
  const ver = process.versions.node;
  if (major >= 18) {
    return { passed: true, label: `Node.js v${ver} (>= 18 required)` };
  }
  return { passed: false, label: `Node.js v${ver} (>= 18 required)`, hint: "Upgrade Node.js to version 18 or later" };
}

interface BackendScanResult {
  name: string;
  available: boolean;
  version?: string;
  error?: string;
}

function scanBackend(name: string): BackendScanResult {
  const commands: Record<string, { cmd: string; args: string[] }> = {
    claude: { cmd: "claude", args: ["--version"] },
    codex: { cmd: "codex", args: ["--version"] },
    traecli: { cmd: "traecli", args: ["--version"] },
  };

  const entry = commands[name];
  if (!entry) {
    return { name, available: false, error: "unknown backend" };
  }

  try {
    const out = execFileSync(entry.cmd, entry.args, {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    // Extract version from output (first line, or the version-looking part)
    const versionMatch = out.match(/[\d]+\.[\d]+[\d.a-z-]*/);
    return { name, available: true, version: versionMatch?.[0] ?? out.split("\n")[0] };
  } catch {
    return { name, available: false, error: "not found" };
  }
}

function scanAllBackends(): { results: BackendScanResult[]; firstAvailable?: string } {
  const results: BackendScanResult[] = [];
  let firstAvailable: string | undefined;

  for (const name of Object.keys(AGENT_REGISTRY)) {
    const result = scanBackend(name);
    results.push(result);
    if (result.available && !firstAvailable) {
      firstAvailable = name;
    }
  }

  return { results, firstAvailable };
}

export function getSuggestedLiteModel(backend: string): string | undefined {
  switch (backend) {
    case "claude":
      return "haiku";
    case "codex":
      return "gpt-5.4-mini";
    case "traecli":
      return "Gemini-3-Flash-Preview";
    default:
      return undefined;
  }
}

// ── Init ───────────────────────────────────────────────────

async function cmdInit(niubotHome: string, flags: CliFlags): Promise<void> {
  console.log();
  console.log("NiuBot Init");
  console.log("\u2500".repeat(40));
  console.log();

  // Preflight checks
  console.log("Preflight checks");

  const issues: string[] = [];

  // Node version
  const nodeCheck = checkNodeVersion();
  if (nodeCheck.passed) ok(nodeCheck.label);
  else { fail(nodeCheck.label); if (nodeCheck.hint) hint(nodeCheck.hint); issues.push(nodeCheck.hint ?? nodeCheck.label); }

  // Check-only mode — non-interactive, no prompts
  if (flags.check) {
    console.log();
    const configPath = path.join(niubotHome, "config.yaml");
    if (fs.existsSync(configPath)) {
      try {
        const config = loadConfig(configPath);
        ok(`${configPath} valid`);
        checkBotCredentials(config, issues);

        // Validate backend availability for each bot
        const backendsToCheck = new Set(config.bots.map((b) => b.backend));
        for (const be of backendsToCheck) {
          const customDef = config.backends[be];
          if (customDef) {
            const pluginPath = path.resolve(niubotHome, customDef.plugin);
            if (fs.existsSync(pluginPath)) {
              ok(`${be} plugin found (${customDef.plugin})`);
            } else {
              fail(`${be} plugin not found: ${pluginPath}`);
              issues.push("backend");
            }
          } else {
            const backendScan = scanBackend(be);
            if (backendScan.available) {
              ok(`${be} CLI available${backendScan.version ? ` (v${backendScan.version})` : ""}`);
            } else {
              fail(`${be} CLI not found`);
              hint(`Install ${be} CLI, or change backend in config.yaml`);
              issues.push("backend");
            }
          }
        }
      } catch (err) {
        fail(`${configPath} invalid: ${err instanceof Error ? err.message : err}`);
        issues.push("Config invalid");
      }
    } else {
      fail(`${configPath} not found`);
      hint("Run 'niubot init' to generate config");
      issues.push("Config not found");
    }
    console.log();
    if (issues.length === 0) {
      console.log(`Result: all checks passed`);
    } else {
      console.log(`Result: ${issues.length} issue${issues.length > 1 ? "s" : ""} to fix before 'niubot start'`);
    }
    console.log();
    return;
  }

  // Backend selection
  // Step 1: ask if user has a custom backend
  console.log();
  const customAnswer = await prompt("  Do you have a custom agent backend? (y/N): ");
  const wantsCustom = customAnswer.toLowerCase() === "y" || customAnswer.toLowerCase() === "yes";

  let defaultBackend: string;
  let customBackendConfig: { name: string; plugin: string } | undefined;

  if (wantsCustom) {
    // Custom backend flow
    console.log();
    console.log("  Custom backend setup");
    console.log("  \u2500".repeat(36));
    console.log("  Create a plugin file that extends CliAgentBackend.");
    console.log("  See INSTALL.md \"Plugin API Reference\" section for the full protocol.");
    console.log("  Plugin location: ~/.niubot/backends/<name>.js");
    console.log();

    const backendName = await prompt("  Backend name (e.g. my-agent): ");
    if (!backendName) {
      fail("Backend name is required");
      process.exit(1);
    }

    const defaultPlugin = `./backends/${backendName}.js`;
    const pluginPath = (await prompt(`  Plugin path (default: ${defaultPlugin}): `)) || defaultPlugin;

    customBackendConfig = { name: backendName, plugin: pluginPath };
    defaultBackend = backendName;

    // Create backends directory
    const backendsDir = path.join(niubotHome, "backends");
    fs.mkdirSync(backendsDir, { recursive: true });

    info(`\u2192 Using custom backend '${defaultBackend}'`);
    hint(`Create your plugin at ${path.resolve(niubotHome, pluginPath)} before running 'niubot start'`);
  } else {
    // Built-in backend flow
    console.log();
    console.log("  Scanning agent backends...");
    const { results: backendResults } = scanAllBackends();
    for (const r of backendResults) {
      if (r.available) {
        ok(`${r.name} v${r.version}`);
      } else {
        fail(`${r.name} \u2014 ${r.error}`);
      }
    }

    const availableBackends = backendResults.filter((r) => r.available);

    if (availableBackends.length === 0) {
      fail("No agent backend found");
      hint("Install claude, codex, or traecli CLI, or re-run init with a custom backend");
      console.log();
      console.log("Aborted: at least one agent backend is required.");
      console.log();
      process.exit(1);
    }

    if (availableBackends.length === 1) {
      defaultBackend = availableBackends[0]!.name;
      info(`\u2192 Using '${defaultBackend}' as bot backend`);
    } else {
      console.log();
      console.log("  Available backends:");
      for (let i = 0; i < availableBackends.length; i++) {
        const r = availableBackends[i]!;
        console.log(`    ${i + 1}) ${r.name} (v${r.version})`);
      }
      const answer = await prompt(`  Select backend [1-${availableBackends.length}] (default: 1): `);
      const parsed = answer ? parseInt(answer, 10) : 1;
      const idx = Number.isNaN(parsed) ? -1 : parsed - 1;
      if (idx < 0 || idx >= availableBackends.length) {
        fail("Invalid selection");
        process.exit(1);
      }
      defaultBackend = availableBackends[idx]!.name;
      info(`\u2192 Using '${defaultBackend}' as bot backend`);
    }
  }

  // Generate files
  console.log();
  console.log(`Initializing ${niubotHome} ...`);

  // Create home dir
  fs.mkdirSync(niubotHome, { recursive: true });
  ok(`Created ${niubotHome}/`);

  // .env
  const envPath = path.join(niubotHome, ".env");
  if (fs.existsSync(envPath) && !flags.force) {
    info(`.env already exists (use --force to overwrite)`);
  } else {
    fs.writeFileSync(envPath, generateEnvTemplate());
    ok(`Created .env`);
  }

  // Bot ID
  console.log();
  console.log("Bot configuration");
  console.log("\u2500".repeat(40));
  console.log();
  console.log("  Bot ID determines the data directory and cannot be changed after setup.");
  let botId: string;
  while (true) {
    botId = (await prompt("  Bot ID (default: NiuBot): ")).trim() || "NiuBot";
    // Check for conflict with existing config
    const existingConfigPath = path.join(niubotHome, "config.yaml");
    if (fs.existsSync(existingConfigPath)) {
      try {
        const existing = loadConfig(existingConfigPath);
        if (existing.bots.some((b) => b.id === botId)) {
          fail(`Bot ID '${botId}' already exists in config.yaml`);
          hint("Choose a different ID, or use --force to overwrite");
          if (!flags.force) continue;
        }
      } catch { /* config parse error, proceed */ }
    }
    break;
  }

  // Default bot directory + persona
  const botDir = path.join(niubotHome, botId);
  fs.mkdirSync(botDir, { recursive: true });
  const personaPath = path.join(botDir, "persona.md");
  if (fs.existsSync(personaPath) && !flags.force) {
    info(`${botId}/persona.md already exists (use --force to overwrite)`);
  } else {
    fs.writeFileSync(personaPath, generatePersonaTemplate());
    ok(`Created ${botId}/persona.md`);
  }

  // Plugin symlink
  ensurePluginSymlink(niubotHome);
  ok("Created node_modules/niubot symlink (for plugin imports)");

  // Model configuration
  console.log();
  console.log("Model configuration");
  console.log("\u2500".repeat(40));
  console.log();
  const model = (await prompt("  Main model (optional, press Enter to use CLI default): ")) || undefined;
  const liteSuggestion = getSuggestedLiteModel(defaultBackend);
  const liteHint = liteSuggestion ? `, suggested: ${liteSuggestion}` : "";
  const liteModel = (await prompt(`  Lite model (optional, press Enter to reuse main model${liteHint}): `)) || undefined;

  // ── Feishu app setup ──────────────────────────────────────
  console.log();
  console.log("Feishu App Setup");
  console.log("\u2500".repeat(40));
  console.log();
  console.log("  You need a Feishu (Lark) app to connect the bot.");
  console.log("  If you already have one, skip ahead and enter the credentials.");
  console.log();
  console.log("  To create one:");
  console.log("    1. Open https://open.feishu.cn/app");
  console.log("    2. Create a new Enterprise Self-Built App");
  console.log("    3. Credentials & Basic Info \u2192 copy App ID + App Secret");
  console.log("    4. Bot page \u2192 enable Bot capability");
  console.log();
  console.log("  Don't add permissions or publish yet \u2014 do that after the engine starts.");
  console.log("  (The 'receive message' event requires an active connection first.)");
  console.log();

  const appId = await prompt("  App ID: ");
  const appSecret = await prompt("  App Secret: ");

  if (!appId || !appSecret) {
    info("Credentials skipped. You can fill them in later:");
    hint(`Edit ${path.join(niubotHome, "config.yaml")}`);
  }

  // config.yaml — write with credentials
  const configPath = path.join(niubotHome, "config.yaml");
  if (fs.existsSync(configPath) && !flags.force) {
    info(`config.yaml already exists (use --force to overwrite)`);
    if (appId && appSecret) {
      hint("Credentials were NOT saved. Add them manually or re-run with --force");
    }
  } else {
    fs.writeFileSync(configPath, generateConfigTemplate(defaultBackend, customBackendConfig, botId, appId, appSecret, model, liteModel));
    ok(`Created config.yaml`);
  }

  // ── Summary ───────────────────────────────────────────────
  console.log();
  console.log("Setup complete");
  console.log("\u2500".repeat(40));
  console.log(`  Bot ID:  ${botId}`);
  console.log(`  Config:  ${configPath}`);
  console.log(`  Persona: ${personaPath}`);
  console.log(`  Backend: ${defaultBackend}`);
  if (model) console.log(`  Model:   ${model}`);
  if (liteModel) console.log(`  Lite:    ${liteModel}`);

  if (customBackendConfig) {
    console.log();
    hint(`Create your backend plugin at ~/.niubot/${customBackendConfig.plugin}`);
    hint("See INSTALL.md 'Plugin API Reference' for the protocol");
  }

  if (!appId || !appSecret) {
    console.log();
    console.log("  Run 'niubot start' after filling in Feishu credentials.");
  } else {
    console.log();
    const startNow = await prompt("  Start NiuBot now? (Y/n): ");
    if (!startNow || startNow.toLowerCase() === "y" || startNow.toLowerCase() === "yes") {
      console.log();
      cmdStart(niubotHome, {});
    } else {
      console.log();
      console.log("  Run 'niubot start' when ready.");
    }
  }

  console.log();
  console.log("Next steps (after engine is running)");
  console.log("\u2500".repeat(40));
  console.log("  1. \u6743\u9650\u7ba1\u7406 \u2192 batch-enable non-review permissions");
  console.log("     Groups: \u6d88\u606f\u4e0e\u7fa4\u7ec4\u3001\u4e91\u6587\u6863\u3001\u5e94\u7528\u4fe1\u606f");
  console.log("  2. \u4e8b\u4ef6\u8ba2\u9605 \u2192 add 'im.message.receive_v1'");
  console.log("  3. Create a version \u2192 publish the app");
  console.log("  4. Send a message to the bot to verify it works");
  console.log();
}

// ── Templates ──────────────────────────────────────────────

export function generateConfigTemplate(
  backend: string,
  customBackend?: { name: string; plugin: string },
  botId: string = "NiuBot",
  appId?: string,
  appSecret?: string,
  model?: string,
  liteModel?: string,
): string {
  let backendsSection: string;
  if (customBackend) {
    backendsSection = `
backends:
  ${customBackend.name}:
    plugin: "${customBackend.plugin}"
`;
  } else {
    backendsSection = `
# 自定义 backend 插件（可选）
# backends:
#   my-agent:
#     plugin: "./backends/my-agent.js"
`;
  }

  const id = appId ? `"${appId}"` : '""';
  const secret = appSecret ? `"${appSecret}"` : '""';
  const modelLine = model
    ? `    model: "${model}"         # 主模型\n`
    : '    # model: ""            # 主模型（不设则由 CLI 自行决定）\n';
  const liteModelLine = liteModel
    ? `    liteModel: "${liteModel}" # 轻量模型（归档摘要等低成本任务）\n`
    : '    # liteModel: ""        # 轻量模型（归档摘要等低成本任务，不设则同主模型）\n';

  return `# NiuBot 配置文件

bots:
  - id: ${botId}              # 唯一标识，决定数据目录路径，初始化后不可修改
    backend: ${backend}        # agent 后端
    appId: ${id}
    appSecret: ${secret}
${modelLine}${liteModelLine}    # workingDirectory: ~/niubot-workspace/NiuBot  # agent 工作目录（默认 ~/niubot-workspace/<id>）

# queue:
#   bufferMs: 1500         # 消息缓冲合并窗口（ms）
${backendsSection}`;
}

function generateEnvTemplate(): string {
  return `# NiuBot 环境变量
# NIUBOT_LOG_LEVEL=info
`;
}

function generatePersonaTemplate(): string {
  return `> 此文件定义 bot 的行为风格，管理员可要求 bot 自行修改。

## 角色
无

## 风格
保持自然、友好的对话风格。
`;
}

// ── Start ──────────────────────────────────────────────────

function cmdStart(niubotHome: string, flags: CliFlags): void {
  console.log();

  // Pre-start checks
  console.log("Pre-start checks");
  const issues: string[] = [];

  // Config exists and is parseable
  const configPath = path.join(niubotHome, "config.yaml");
  if (!fs.existsSync(configPath)) {
    fail("Config not found");
    hint("Run 'niubot init' first");
    console.log();
    console.log("Aborted: fix the issues above before starting.");
    console.log();
    process.exit(1);
  }

  // Parse and validate config
  let config: NiuBotConfig;
  try {
    config = loadConfig(configPath);
    ok("Config valid");
  } catch (err) {
    fail(`Config invalid: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Check credentials
  checkBotCredentials(config, issues);

  // Check backend availability (deduplicate across bots)
  const backendsToCheck = new Set(config.bots.map((b) => b.backend));
  for (const be of backendsToCheck) {
    const customDef = config.backends[be];
    if (customDef) {
      // Custom plugin backend — check plugin file exists
      const pluginPath = path.resolve(niubotHome, customDef.plugin);
      if (fs.existsSync(pluginPath)) {
        ok(`${be} plugin found (${customDef.plugin})`);
      } else {
        fail(`${be} plugin not found: ${pluginPath}`);
        hint(`Create the plugin file, or change backend in config.yaml`);
        issues.push("backend");
      }
    } else {
      // Built-in backend — check CLI command
      const backendScan = scanBackend(be);
      if (backendScan.available) {
        ok(`${be} CLI available${backendScan.version ? ` (v${backendScan.version})` : ""}`);
      } else {
        fail(`${be} CLI not found`);
        hint(`Install ${be} CLI, or change backend in config.yaml`);
        issues.push("backend");
      }
    }
  }

  // Check for existing process
  const pidFile = path.join(niubotHome, "niubot.pid");
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (isProcessRunning(pid)) {
      if (flags.restart) {
        info("Existing process found, stopping first...");
        stopProcess(niubotHome);
      } else {
        fail(`Already running (PID ${pid})`);
        hint("Use 'niubot stop' first, or 'niubot start --restart'");
        issues.push("process");
      }
    } else {
      // Stale PID file
      fs.unlinkSync(pidFile);
    }
  } else {
    ok("No existing process running");
  }

  if (issues.length > 0) {
    console.log();
    console.log("Aborted: fix the issues above before starting.");
    console.log();
    process.exit(1);
  }

  // Ensure plugin symlink
  ensurePluginSymlink(niubotHome);

  // Ensure working directories exist
  for (const bot of config.bots) {
    const workDir = path.join(niubotHome, bot.id, "workspace");
    fs.mkdirSync(workDir, { recursive: true });
  }
  ok("Working directories exist");

  // Start process
  console.log();
  console.log("Starting NiuBot...");

  const logDir = path.join(niubotHome, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(logDir, `niubot-${today}.log`);

  const logFd = fs.openSync(logFile, "a");

  const child = spawn("node", [path.join(PROJECT_ROOT, "dist", "index.js")], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      NIUBOT_HOME: niubotHome,
      NIUBOT_LOG_LEVEL: process.env["NIUBOT_LOG_LEVEL"] ?? "info",
    },
  });

  child.unref();
  fs.closeSync(logFd);

  // Write PID (engine also writes it, but we write early for immediate status checks)
  fs.writeFileSync(pidFile, String(child.pid));
  ok(`Process started (PID ${child.pid})`);
  info(`Log: ${logFile}`);

  // Health check — all bots must respond
  const failedBots: string[] = [];
  for (const bot of config.bots) {
    const socketPath = path.join(niubotHome, bot.id, "api.sock");
    if (waitForHealth(socketPath, 15)) {
      ok(`${bot.id} health check passed`);
    } else {
      fail(`${bot.id} health check failed`);
      failedBots.push(bot.id);
    }
  }

  console.log();
  if (failedBots.length === 0) {
    console.log("NiuBot is running.");
    console.log(`  Log: ${logFile}`);
    for (const bot of config.bots) {
      console.log(`  API: ${path.join(niubotHome, bot.id, "api.sock")}`);
    }
  } else {
    hint(`Check log: ${logFile}`);
    console.log("Some bots failed health check. The service may still be initializing.");
  }

  // Check for updates (non-blocking, best-effort)
  const latest = checkForUpdate();
  if (latest) {
    console.log();
    console.log(`  Update available: ${getPkgVersion()} → ${latest}`);
    console.log(`  Run 'niubot update' to upgrade.`);
  }
  console.log();
}

// ── Stop ───────────────────────────────────────────────────

function cmdStop(niubotHome: string): void {
  const stopped = stopProcess(niubotHome);
  if (!stopped) {
    console.log("NiuBot is not running.");
  }
}

function stopProcess(niubotHome: string): boolean {
  const pidFile = path.join(niubotHome, "niubot.pid");
  if (!fs.existsSync(pidFile)) return false;

  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  if (!isProcessRunning(pid)) {
    fs.unlinkSync(pidFile);
    return false;
  }

  // Send SIGTERM
  process.kill(pid, "SIGTERM");

  // Wait up to 5 seconds for graceful shutdown
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isProcessRunning(pid)) {
    execFileSync("sleep", ["0.5"]);
  }

  // Force kill if still alive
  if (isProcessRunning(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    execFileSync("sleep", ["0.5"]);
  }

  // Clean up PID file
  try { fs.unlinkSync(pidFile); } catch { /* ignore */ }

  console.log(`NiuBot stopped (PID ${pid})`);
  return true;
}

// ── Status ─────────────────────────────────────────────────

function cmdStatus(niubotHome: string): void {
  const pidFile = path.join(niubotHome, "niubot.pid");
  if (!fs.existsSync(pidFile)) {
    console.log("NiuBot is not running.");
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  if (!isProcessRunning(pid)) {
    console.log("NiuBot is not running (stale PID file).");
    fs.unlinkSync(pidFile);
    return;
  }

  // Get process uptime from /proc or ps
  let uptime = "";
  try {
    const psOut = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    uptime = psOut;
  } catch { /* ignore */ }

  const configPath = path.join(niubotHome, "config.yaml");
  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(niubotHome, "logs", `niubot-${today}.log`);

  console.log(`NiuBot is running (PID ${pid})`);
  console.log(`  Version: ${getPkgVersion()}`);
  console.log(`  Path: ${__dirname}`);
  if (uptime) console.log(`  Uptime: ${uptime}`);
  console.log(`  Log: ${logFile}`);
  console.log(`  Config: ${configPath}`);
}

// ── Version ────────────────────────────────────────────────

function cmdVersion(): void {
  console.log(`niubot v${getPkgVersion()}`);
}

// ── Update ────────────────────────────────────────────────

const PKG_NAME = "@yuanzhangjing/niubot";

/** Check npm registry for a newer version. Returns latest version or null. */
function checkForUpdate(): string | null {
  const local = getPkgVersion();
  try {
    const latest = execFileSync("npm", ["view", `${PKG_NAME}@latest`, "version"], {
      encoding: "utf-8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (latest && latest !== local) return latest;
  } catch { /* network error, not published, etc. */ }
  return null;
}

function cmdUpdate(niubotHome: string): void {
  const current = getPkgVersion();
  console.log();
  console.log(`Current version: ${current}`);

  // Check for latest
  info("Checking npm registry...");
  const latest = checkForUpdate();
  if (!latest) {
    ok("Already up to date.");
    console.log();
    return;
  }

  console.log(`  New version available: ${latest}`);
  console.log();

  // Install
  info(`Installing ${PKG_NAME}@${latest} ...`);
  try {
    execFileSync("npm", ["install", "-g", `${PKG_NAME}@${latest}`], {
      encoding: "utf-8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    ok(`Updated to ${latest}`);
  } catch (err) {
    fail(`Install failed: ${err instanceof Error ? err.message : err}`);
    hint("Try manually: npm install -g " + PKG_NAME + "@latest");
    console.log();
    process.exit(1);
  }

  // Restart if running
  const pidFile = path.join(niubotHome, "niubot.pid");
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (isProcessRunning(pid)) {
      console.log();
      info("Restarting service...");
      stopProcess(niubotHome);

      // Re-exec start with the NEW binary (the just-installed version)
      try {
        execFileSync("niubot", ["start"], {
          encoding: "utf-8",
          timeout: 30000,
          stdio: "inherit",
          env: { ...process.env, NIUBOT_HOME: niubotHome },
        });
      } catch {
        hint("Auto-restart failed. Run 'niubot start' manually.");
      }
    }
  }

  console.log();
}

// ── Plugin symlink ────────────────────────────────────────

/**
 * 确保 ~/.niubot/node_modules/niubot 符号链接指向当前包目录。
 * 这样插件文件中的 import("niubot/plugin") 才能正确解析。
 */
function ensurePluginSymlink(niubotHome: string): void {
  const linkPath = path.join(niubotHome, "node_modules", "niubot");

  try {
    if (fs.realpathSync(linkPath) === fs.realpathSync(PROJECT_ROOT)) return;
    // 指向错误位置，删掉重建
    fs.rmSync(linkPath, { recursive: true, force: true });
  } catch {
    // 不存在或无法解析 — 继续创建
  }

  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(PROJECT_ROOT, linkPath);
}

// ── Utilities ──────────────────────────────────────────────

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForHealth(socketPath: string, timeoutSec: number): boolean {
  const deadline = Date.now() + timeoutSec * 1000;

  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) {
      try {
        // 用 curl 通过 unix socket 发 GET /ping，和 restart.sh 一致
        execFileSync("curl", [
          "-s", "--max-time", "2",
          "--unix-socket", socketPath,
          "http://localhost/ping",
        ], { timeout: 5000, encoding: "utf-8" });
        return true;
      } catch { /* not ready yet */ }
    }

    execFileSync("sleep", ["1"]);
  }

  return false;
}

// ── Usage ──────────────────────────────────────────────────

function printUsage(): void {
  console.log(`NiuBot v${getPkgVersion()}

Usage: niubot <command> [options]

Commands:
  init       Initialize NiuBot (environment check + config templates)
  start      Start the NiuBot service
  stop       Stop the NiuBot service
  status     Show service status
  update     Check for updates and install latest version
  version    Show version

Init options:
  --check    Only run preflight checks, don't create files
  --force    Overwrite existing config files
  --home <path>  Custom NIUBOT_HOME (default: ~/.niubot)

Start options:
  --restart  Stop existing process first if running`);
}

// ── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, flags } = parseCliArgs(process.argv.slice(2));
  const niubotHome = flags.home ?? process.env["NIUBOT_HOME"] ?? path.join(os.homedir(), ".niubot");

  switch (command) {
    case "init":
      await cmdInit(niubotHome, flags);
      break;
    case "start":
      cmdStart(niubotHome, flags);
      break;
    case "stop":
      cmdStop(niubotHome);
      break;
    case "status":
      cmdStatus(niubotHome);
      break;
    case "update":
      cmdUpdate(niubotHome);
      break;
    case "version":
    case "--version":
    case "-v":
      cmdVersion();
      break;
    default:
      printUsage();
      break;
  }
}

const entryPath = process.argv[1] ? fs.realpathSync(path.resolve(process.argv[1])) : undefined;
const modulePath = fileURLToPath(import.meta.url);

if (entryPath === modulePath) {
  void main();
}
