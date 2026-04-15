#!/usr/bin/env node

/**
 * NiuBot User CLI — 面向安装用户的服务管理命令。
 *
 * Commands:
 *   niubot init    — 环境检查 + 配置模板生成
 *   niubot start   — 校验 + 启动服务
 *   niubot stop    — 停止服务
 *   niubot status  — 查看运行状态
 *   niubot version — 显示版本号
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_REGISTRY, loadConfig, getConfiguredBackend, type NiuBotConfig } from "./config.js";

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

// ── Checks ─────────────────────────────────────────────────

interface CheckResult {
  passed: boolean;
  label: string;
  hint?: string;
}

function checkBotCredentials(config: NiuBotConfig, issues: string[]): void {
  for (const bot of config.bots) {
    if (!bot.appId || !bot.appSecret) {
      fail(`Bot '${bot.name}' credentials empty`);
      hint("Edit ~/.niubot/config.yaml, fill in appId and appSecret");
      issues.push("credentials");
    } else {
      ok(`Bot '${bot.name}' credentials present`);
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

// ── Init ───────────────────────────────────────────────────

function cmdInit(niubotHome: string, flags: CliFlags): void {
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

  // Backend scan
  console.log("  Scanning agent backends...");
  const { results: backendResults, firstAvailable } = scanAllBackends();
  for (const r of backendResults) {
    if (r.available) {
      ok(`${r.name} v${r.version}`);
    } else {
      fail(`${r.name} \u2014 ${r.error}`);
    }
  }

  if (firstAvailable) {
    info(`\u2192 Using '${firstAvailable}' as default backend`);
  } else {
    info("\u2192 No agent backend found. Config template will default to 'claude'.");
    info("  Install one before running 'niubot start'.");
    issues.push("No agent backend CLI found");
  }

  const defaultBackend = firstAvailable ?? "claude";

  // Check-only mode
  if (flags.check) {
    console.log();

    // Validate config via loadConfig
    const configPath = path.join(niubotHome, "config.yaml");
    if (fs.existsSync(configPath)) {
      try {
        const config = loadConfig(configPath);
        ok(`${configPath} valid`);
        checkBotCredentials(config, issues);
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

  // Generate files
  console.log();
  console.log(`Initializing ${niubotHome} ...`);

  // Create home dir
  fs.mkdirSync(niubotHome, { recursive: true });
  ok(`Created ${niubotHome}/`);

  // config.yaml
  const configPath = path.join(niubotHome, "config.yaml");
  if (fs.existsSync(configPath) && !flags.force) {
    info(`config.yaml already exists (use --force to overwrite)`);
  } else {
    fs.writeFileSync(configPath, generateConfigTemplate(defaultBackend));
    ok(`Created config.yaml (backend: ${defaultBackend})`);
  }

  // .env
  const envPath = path.join(niubotHome, ".env");
  if (fs.existsSync(envPath) && !flags.force) {
    info(`.env already exists (use --force to overwrite)`);
  } else {
    fs.writeFileSync(envPath, generateEnvTemplate());
    ok(`Created .env`);
  }

  // Default bot directory + persona
  const botDir = path.join(niubotHome, "NiuBot");
  fs.mkdirSync(botDir, { recursive: true });
  const personaPath = path.join(botDir, "persona.md");
  if (fs.existsSync(personaPath) && !flags.force) {
    info(`NiuBot/persona.md already exists (use --force to overwrite)`);
  } else {
    fs.writeFileSync(personaPath, generatePersonaTemplate());
    ok(`Created NiuBot/persona.md`);
  }

  // Plugin symlink（使 import("niubot/plugin") 在插件目录下可用）
  ensurePluginSymlink(niubotHome);
  ok("Created node_modules/niubot symlink (for plugin imports)");

  console.log();
  console.log("Status: ready for configuration");
  console.log("\u2500".repeat(40));
  console.log();
  console.log("Next steps:");
  console.log("  1. Fill in Feishu credentials in ~/.niubot/config.yaml");
  console.log("     (appId and appSecret from https://open.feishu.cn/app)");
  console.log("  2. Run 'niubot start' to launch the service");
  console.log();
}

// ── Templates ──────────────────────────────────────────────

function generateConfigTemplate(backend: string): string {
  return `# NiuBot 配置文件

default_config:
  backend: ${backend}          # agent 后端：claude | codex

bots:
  - name: NiuBot            # 内部标识，决定数据目录路径，初始化后不可修改
    appId: ""              # <- 飞书应用 App ID
    appSecret: ""          # <- 飞书应用 App Secret
    # model: ""            # 主模型（不设则由 CLI 自行决定）
    # liteModel: ""        # 轻量模型（归档摘要等低成本任务，不设则同主模型）
    # workingDirectory: ~/niubot-workspace/NiuBot  # agent 工作目录（默认 ~/niubot-workspace/<name>）

# queue:
#   bufferMs: 1500         # 消息缓冲合并窗口（ms）

# 自定义 backend 插件（可选）
# backends:
#   my-agent:
#     plugin: "./backends/my-agent.js"
`;
}

function generateEnvTemplate(): string {
  return `# NiuBot 环境变量
# NIUBOT_LOG_LEVEL=info
# NIUBOT_BACKEND=claude
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
  const backendsToCheck = new Set(config.bots.map((b) => getConfiguredBackend(config, b)));
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
    const workDir = path.join(niubotHome, bot.name, "workspace");
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

  // Health check — all bots must respond
  const failedBots: string[] = [];
  for (const bot of config.bots) {
    const socketPath = path.join(niubotHome, bot.name, "api.sock");
    if (waitForHealth(socketPath, 15)) {
      ok(`${bot.name} health check passed`);
    } else {
      fail(`${bot.name} health check failed`);
      failedBots.push(bot.name);
    }
  }

  console.log();
  if (failedBots.length === 0) {
    console.log("NiuBot is running.");
    console.log(`  Log: ${logFile}`);
    for (const bot of config.bots) {
      console.log(`  API: ${path.join(niubotHome, bot.name, "api.sock")}`);
    }
  } else {
    hint(`Check log: ${logFile}`);
    console.log("Some bots failed health check. The service may still be initializing.");
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
  if (uptime) console.log(`  Uptime: ${uptime}`);
  console.log(`  Log: ${logFile}`);
  console.log(`  Config: ${configPath}`);
}

// ── Version ────────────────────────────────────────────────

function cmdVersion(): void {
  console.log(`niubot v${getPkgVersion()}`);
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
  version    Show version

Init options:
  --check    Only run preflight checks, don't create files
  --force    Overwrite existing config files
  --home <path>  Custom NIUBOT_HOME (default: ~/.niubot)

Start options:
  --restart  Stop existing process first if running`);
}

// ── Main ───────────────────────────────────────────────────

function main(): void {
  const { command, flags } = parseCliArgs(process.argv.slice(2));
  const niubotHome = flags.home ?? process.env["NIUBOT_HOME"] ?? path.join(os.homedir(), ".niubot");

  switch (command) {
    case "init":
      cmdInit(niubotHome, flags);
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

main();
