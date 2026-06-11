#!/usr/bin/env node

/**
 * NiuBot User CLI — 面向安装用户的服务管理命令。
 *
 * Commands:
 *   niubot init     — 环境检查 + 配置模板生成
 *   niubot add-bot  — 向已有配置添加新 bot
 *   niubot start    — 校验 + 启动服务
 *   niubot stop     — 停止服务
 *   niubot status   — 查看运行状态
 *   niubot update   — 检查并安装最新版本
 *   niubot version  — 显示版本号
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import yaml from "yaml";
import { DEFAULT_BOT_PROFILE } from "./bot-profile.js";
import { AGENT_REGISTRY, DEFAULT_LITE_MODELS, expandHome, loadConfig, normalizeBackend, resolveHomePath, type BuiltinBackendType, type NiuBotConfig } from "./config.js";
import { INSTALL_GUIDE_COMMAND } from "./install-guide.js";
import { localToday } from "./tz.js";

// ── Paths ──────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PACKAGE_NAME = "@yuanzhangjing/niubot";
const requireFromPackage = createRequire(import.meta.url);

function getPkgVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function readNiuBotPackage(packageRoot: string | undefined): { root: string; version: string } | undefined {
  if (!packageRoot) return undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"));
    if (pkg.name !== PACKAGE_NAME || typeof pkg.version !== "string") return undefined;
    return { root: packageRoot, version: pkg.version };
  } catch {
    return undefined;
  }
}

export function getTodayLogFilePath(niubotHome: string): string {
  return path.join(niubotHome, "logs", `niubot-${localToday()}.log`);
}

interface RunningStatusDetailsOptions {
  niubotHome: string;
  cliPath: string;
  todayLogFile: string;
  processCwd?: string;
  processStdoutPath?: string;
}

export function resolveRunningStatusDetails(options: RunningStatusDetailsOptions): {
  version: string;
  path: string;
  node?: string;
  logFile: string;
} {
  const versionFile = path.join(options.niubotHome, "niubot.version");
  const nodeFile = path.join(options.niubotHome, "niubot.node");
  const runningPackage = readNiuBotPackage(options.processCwd);
  let version = runningPackage?.version;
  if (!version) {
    version = readTrimmedFile(versionFile);
  }
  const node = readTrimmedFile(nodeFile);

  return {
    version: version || "unknown",
    path: runningPackage?.root || options.cliPath,
    node,
    logFile: isRegularFile(options.processStdoutPath) ? options.processStdoutPath : options.todayLogFile,
  };
}

function isRegularFile(filePath: string | undefined): filePath is string {
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function parseLsofName(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .find((line) => line.startsWith("n") && line.length > 1)
    ?.slice(1);
}

function getProcessCwd(pid: number): string | undefined {
  try {
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf-8",
      timeout: 3000,
    });
    return parseLsofName(out);
  } catch {
    return undefined;
  }
}

function getProcessFdPath(pid: number, fd: number): string | undefined {
  try {
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", String(fd), "-Fn"], {
      encoding: "utf-8",
      timeout: 3000,
    });
    return parseLsofName(out);
  } catch {
    return undefined;
  }
}

// ── CLI arg helpers ────────────────────────────────────────

interface CliFlags {
  check?: boolean;
  force?: boolean;
  restart?: boolean;
  verbose?: boolean;
  all?: boolean;
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
    else if (arg === "--verbose") flags.verbose = true;
    else if (arg === "--all") flags.all = true;
    else if ((arg === "--version" || arg === "-v") && !command) command = arg;
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

function readTrimmedFile(filePath: string): string | undefined {
  try {
    const text = fs.readFileSync(filePath, "utf-8").trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

function getNodeRuntimeLabel(): string {
  return `${process.execPath} ${process.version} ABI ${process.versions.modules}`;
}

export function deriveNpmPrefixFromPackageRoot(packageRoot: string): string | undefined {
  const normalized = path.normalize(packageRoot);
  const parts = normalized.split(path.sep);
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (nodeModulesIndex < 1) return undefined;

  const prefixParts = parts[nodeModulesIndex - 1] === "lib"
    ? parts.slice(0, nodeModulesIndex - 1)
    : parts.slice(0, nodeModulesIndex);
  const prefix = prefixParts.join(path.sep);
  return prefix || path.sep;
}

export function isPackageRootInsideNpmRoot(packageRoot: string, npmRoot: string): boolean {
  const relative = path.relative(path.resolve(npmRoot), path.resolve(packageRoot));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function resolveNpmExecutableForNode(
  nodePath: string,
  platform: NodeJS.Platform = process.platform,
  exists: (filePath: string) => boolean = fs.existsSync,
): string | undefined {
  const npmName = platform === "win32" ? "npm.cmd" : "npm";
  const pathApi = platform === "win32" ? path.win32 : path;
  const candidate = pathApi.join(pathApi.dirname(nodePath), npmName);
  return exists(candidate) ? candidate : undefined;
}

function resolveNpmCommandForCurrentNode(): string {
  return resolveNpmExecutableForNode(process.execPath) ?? "npm";
}

export function resolveNiubotHome(flagHome: string | undefined, envHome: string | undefined, cwd: string = process.cwd()): string {
  return resolveHomePath(flagHome ?? envHome ?? path.join(os.homedir(), ".niubot"), cwd);
}

function getDefaultNiubotHome(): string {
  return resolveHomePath(path.join(os.homedir(), ".niubot"));
}

function getHomeRegistryPath(): string {
  return path.join(getDefaultNiubotHome(), "instances.json");
}

export function readRegisteredHomes(registryPath: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as unknown;
    const homes = Array.isArray(raw)
      ? raw
      : typeof raw === "object" && raw !== null && Array.isArray((raw as { homes?: unknown }).homes)
        ? (raw as { homes: unknown[] }).homes
        : [];
    return homes
      .filter((home): home is string => typeof home === "string" && home.trim().length > 0)
      .map((home) => resolveHomePath(home));
  } catch {
    return [];
  }
}

export function collectStatusHomes(currentHome: string, registeredHomes: string[]): string[] {
  const seen = new Set<string>();
  const homes: string[] = [];
  for (const home of [currentHome, ...registeredHomes]) {
    const resolved = resolveHomePath(home);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    homes.push(resolved);
  }
  return homes;
}

export function registerHomePath(registryPath: string, home: string): void {
  const seen = new Set<string>();
  const homes: string[] = [];
  for (const item of [...readRegisteredHomes(registryPath), home]) {
    const resolved = resolveHomePath(item);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    homes.push(resolved);
  }
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, `${JSON.stringify({ homes }, null, 2)}\n`);
}

function readNpmRoot(npmCommand: string): string | undefined {
  try {
    return execFileSync(npmCommand, ["root", "-g"], {
      encoding: "utf-8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

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

function checkNativeDependencies(issues: string[]): void {
  try {
    requireFromPackage("better-sqlite3");
    ok("Native dependencies loadable");
  } catch (err) {
    fail("Native dependency check failed");
    hint(`Node: ${process.execPath}`);
    hint(`ABI: ${process.versions.modules}`);
    hint(`Package: ${PROJECT_ROOT}`);
    hint("Run npm rebuild -g @yuanzhangjing/niubot or reinstall with the same Node runtime.");
    hint(`Error: ${err instanceof Error ? err.message : String(err)}`);
    issues.push("native-dependencies");
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
    opencode: { cmd: "opencode", args: ["--version"] },
    cursor: { cmd: "cursor-agent", args: ["--version"] },
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
  const normalized = normalizeBackend(backend) ?? backend;
  return DEFAULT_LITE_MODELS[normalized as BuiltinBackendType];
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
        const backendsToCheck = new Set(config.bots.map((b) => b.backend).filter((b): b is string => !!b));
        for (const be of backendsToCheck) {
          const backendScan = scanBackend(be);
          if (backendScan.available) {
            ok(`${be} CLI available${backendScan.version ? ` (v${backendScan.version})` : ""}`);
          } else {
            fail(`${be} CLI not found`);
            hint(`Install ${be} CLI, or change backend in config.yaml`);
            issues.push("backend");
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
  let defaultBackend: string;

  if (availableBackends.length === 0) {
    fail("No agent backend found");
    hint("Install claude, codex, traecli, opencode, or cursor CLI");
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

  // Default bot directory + profile
  const botDir = path.join(niubotHome, botId);
  fs.mkdirSync(botDir, { recursive: true });
  const botProfilePath = path.join(botDir, "bot_profile.md");
  if (fs.existsSync(botProfilePath) && !flags.force) {
    info(`${botId}/bot_profile.md already exists (use --force to overwrite)`);
  } else {
    fs.writeFileSync(botProfilePath, generateBotProfileTemplate());
    ok(`Created ${botId}/bot_profile.md`);
  }

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
    fs.writeFileSync(configPath, generateConfigTemplate(defaultBackend, botId, appId, appSecret, model, liteModel));
    ok(`Created config.yaml`);
  }

  // ── Summary ───────────────────────────────────────────────
  console.log();
  console.log("Setup complete");
  console.log("\u2500".repeat(40));
  console.log(`  Bot ID:  ${botId}`);
  console.log(`  Config:  ${configPath}`);
  console.log(`  Profile: ${botProfilePath}`);
  console.log(`  Backend: ${defaultBackend}`);
  if (model) console.log(`  Model:   ${model}`);
  if (liteModel) console.log(`  Lite:    ${liteModel}`);

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

// ── Add Bot ───────────────────────────────────────────────

async function cmdAddBot(niubotHome: string): Promise<void> {
  console.log();
  console.log("Add Bot");
  console.log("─".repeat(40));

  // Must have an existing config
  const configPath = path.join(niubotHome, "config.yaml");
  if (!fs.existsSync(configPath)) {
    fail("config.yaml not found");
    hint("Run 'niubot init' first to create your initial setup");
    console.log();
    process.exit(1);
  }

  // Parse existing config (raw YAML, not the typed config — we need to preserve structure)
  const rawYaml = fs.readFileSync(configPath, "utf-8");
  const doc = yaml.parse(rawYaml) as Record<string, unknown>;

  if (!Array.isArray(doc["bots"])) {
    fail("config.yaml uses legacy format (no 'bots' array)");
    hint("Run 'niubot init --force' to migrate to the new format first");
    console.log();
    process.exit(1);
  }

  const existingBots = doc["bots"] as Array<Record<string, unknown>>;
  const existingIds = new Set(existingBots.map((b) => String(b["id"] ?? b["name"] ?? "")));

  // ── Backend selection ───────────────────────────────────
  console.log();
  console.log("  Scanning agent backends...");
  const { results: backendResults } = scanAllBackends();
  for (const r of backendResults) {
    if (r.available) ok(`${r.name} v${r.version}`);
    else fail(`${r.name} — ${r.error}`);
  }

  const availableBackends = backendResults.filter((r) => r.available);
  let backend: string;

  if (availableBackends.length === 0) {
    fail("No agent backend found");
    hint("Install claude, codex, traecli, opencode, or cursor CLI");
    console.log();
    process.exit(1);
  }

  if (availableBackends.length === 1) {
    backend = availableBackends[0]!.name;
    info(`→ Using '${backend}' as bot backend`);
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
    backend = availableBackends[idx]!.name;
    info(`→ Using '${backend}' as bot backend`);
  }

  // ── Bot ID ──────────────────────────────────────────────
  console.log();
  console.log("Bot configuration");
  console.log("─".repeat(40));
  console.log();
  console.log("  Bot ID determines the data directory and cannot be changed after setup.");
  let botId: string;
  while (true) {
    botId = (await prompt("  Bot ID: ")).trim();
    if (!botId) {
      fail("Bot ID is required");
      continue;
    }
    if (existingIds.has(botId)) {
      fail(`Bot ID '${botId}' already exists in config.yaml`);
      continue;
    }
    break;
  }

  // ── Model ───────────────────────────────────────────────
  console.log();
  console.log("Model configuration");
  console.log("─".repeat(40));
  console.log();
  const model = (await prompt("  Main model (optional, press Enter to use CLI default): ")) || undefined;
  const liteSuggestion = getSuggestedLiteModel(backend);
  const liteHint = liteSuggestion ? `, suggested: ${liteSuggestion}` : "";
  const liteModel = (await prompt(`  Lite model (optional, press Enter to reuse main model${liteHint}): `)) || undefined;

  // ── Feishu credentials ──────────────────────────────────
  console.log();
  console.log("Feishu App Setup");
  console.log("─".repeat(40));
  console.log();
  console.log("  Each bot needs its own Feishu app (separate App ID + App Secret).");
  console.log("  Create one at https://open.feishu.cn/app if you haven't.");
  console.log();

  const appId = await prompt("  App ID: ");
  const appSecret = await prompt("  App Secret: ");

  if (!appId || !appSecret) {
    info("Credentials skipped. Fill them in later:");
    hint(`Edit ${configPath}`);
  }

  // ── Create bot directory + profile ──────────────────────
  const botDir = path.join(niubotHome, botId);
  fs.mkdirSync(botDir, { recursive: true });
  const botProfilePath = path.join(botDir, "bot_profile.md");
  if (!fs.existsSync(botProfilePath)) {
    fs.writeFileSync(botProfilePath, generateBotProfileTemplate());
    ok(`Created ${botId}/bot_profile.md`);
  } else {
    info(`${botId}/bot_profile.md already exists`);
  }

  // ── Update config.yaml ─────────────────────────────────
  const newBot: Record<string, string> = {
    id: botId,
    backend,
    appId: appId || "",
    appSecret: appSecret || "",
  };
  if (model) newBot["model"] = model;
  if (liteModel) newBot["liteModel"] = liteModel;

  existingBots.push(newBot);
  doc["bots"] = existingBots;

  fs.writeFileSync(configPath, yaml.stringify(doc, { lineWidth: 0 }));
  ok("Updated config.yaml");

  // ── Summary ─────────────────────────────────────────────
  console.log();
  console.log("Bot added");
  console.log("─".repeat(40));
  console.log(`  Bot ID:  ${botId}`);
  console.log(`  Backend: ${backend}`);
  console.log(`  Profile: ${botProfilePath}`);
  if (model) console.log(`  Model:   ${model}`);
  if (liteModel) console.log(`  Lite:    ${liteModel}`);

  // Restart hint
  const pidFile = path.join(niubotHome, "niubot.pid");
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (isProcessRunning(pid)) {
      console.log();
      const restart = await prompt("  NiuBot is running. Restart to load the new bot? (Y/n): ");
      if (!restart || restart.toLowerCase() === "y" || restart.toLowerCase() === "yes") {
        console.log();
        stopProcess(niubotHome);
        cmdStart(niubotHome, {});
      } else {
        hint("Run 'niubot start --restart' when ready");
      }
    }
  } else {
    console.log();
    if (!appId || !appSecret) {
      console.log("  Fill in Feishu credentials, then run 'niubot start'.");
    } else {
      console.log("  Run 'niubot start' to launch.");
    }
  }
  console.log();
}

// ── Templates ──────────────────────────────────────────────

export function generateConfigTemplate(
  backend: string,
  botId: string = "NiuBot",
  appId?: string,
  appSecret?: string,
  model?: string,
  liteModel?: string,
): string {
  const id = appId ? `"${appId}"` : '""';
  const secret = appSecret ? `"${appSecret}"` : '""';
  const modelLine = model
    ? `    model: "${model}"         # 主模型\n`
    : '    # model: ""            # 主模型（不设则由 CLI 自行决定）\n';
  const liteModelLine = liteModel
    ? `    liteModel: "${liteModel}" # 轻量模型（归档摘要等低成本任务）\n`
    : '    # liteModel: ""        # 轻量模型（归档摘要等低成本任务，不设则用 backend 默认值）\n';

  return `# NiuBot 配置文件

bots:
  - id: ${botId}              # 唯一标识，决定数据目录路径，初始化后不可修改
    backend: ${backend}        # agent 后端
    appId: ${id}
    appSecret: ${secret}
${modelLine}${liteModelLine}    # workingDirectory: ~/niubot-workspace/NiuBot  # agent 工作目录（默认 ~/niubot-workspace/<id>）

# queue:
#   bufferMs: 1500         # 消息缓冲合并窗口（ms）
`;
}

function generateEnvTemplate(): string {
  return `# NiuBot 环境变量
# NIUBOT_LOG_LEVEL=info
# NIUBOT_DEBUG_AGENT_STDOUT=1   # 将每轮 agent 完整 stdout 追加到 logs/agent-stdout-YYYY-MM-DD.log
`;
}

export function generateBotProfileTemplate(): string {
  return DEFAULT_BOT_PROFILE;
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
  checkNativeDependencies(issues);

  // Check backend availability (deduplicate across bots)
  const backendsToCheck = new Set(config.bots.map((b) => b.backend).filter((b): b is string => !!b));
  for (const be of backendsToCheck) {
    const backendScan = scanBackend(be);
    if (backendScan.available) {
      ok(`${be} CLI available${backendScan.version ? ` (v${backendScan.version})` : ""}`);
    } else {
      fail(`${be} CLI not found`);
      hint(`Install ${be} CLI, or change backend in config.yaml`);
      issues.push("backend");
    }
  }

  // Check for existing process
  const pidFile = path.join(niubotHome, "niubot.pid");
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (isProcessRunning(pid)) {
      if (flags.restart) {
        // Guard: refuse to restart from within an agent session.
        // Agent processes have NIUBOT_AGENT_SESSION set in their environment.
        if (process.env["NIUBOT_AGENT_SESSION"]) {
          fail("Cannot restart from within a bot session. Use /restart in Feishu or run directly in your terminal.");
          process.exit(1);
        }
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
  const logFile = getTodayLogFilePath(niubotHome);

  const logFd = fs.openSync(logFile, "a");

  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, "dist", "index.js")], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      NIUBOT_HOME: niubotHome,
      NIUBOT_LOG_LEVEL: process.env["NIUBOT_LOG_LEVEL"] ?? "info",
      NIUBOT_DEBUG_AGENT_STDOUT: process.env["NIUBOT_DEBUG_AGENT_STDOUT"] ?? "",
    },
  });

  child.unref();
  fs.closeSync(logFd);

  // Write PID (engine also writes it, but we write early for immediate status checks)
  fs.writeFileSync(pidFile, String(child.pid));
  // Snapshot the version at startup so status shows the actual running version
  fs.writeFileSync(path.join(niubotHome, "niubot.version"), getPkgVersion());
  fs.writeFileSync(path.join(niubotHome, "niubot.node"), getNodeRuntimeLabel());
  try {
    registerHomePath(getHomeRegistryPath(), niubotHome);
  } catch (err) {
    hint(`Could not update home registry: ${err instanceof Error ? err.message : String(err)}`);
  }
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

function printStatusForHome(niubotHome: string): void {
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

  const logFile = getTodayLogFilePath(niubotHome);
  const configPath = path.join(niubotHome, "config.yaml");
  const details = resolveRunningStatusDetails({
    niubotHome,
    cliPath: __dirname,
    todayLogFile: logFile,
    processCwd: getProcessCwd(pid),
    processStdoutPath: getProcessFdPath(pid, 1),
  });

  console.log(`NiuBot is running (PID ${pid})`);
  console.log(`  Version: ${details.version}`);
  console.log(`  Path: ${details.path}`);
  if (details.node) console.log(`  Node: ${details.node}`);
  if (uptime) console.log(`  Uptime: ${uptime}`);
  console.log(`  Log: ${details.logFile}`);
  console.log(`  Config: ${configPath}`);
}

function cmdStatus(niubotHome: string, flags: CliFlags, hasExplicitHome: boolean): void {
  const listAll = flags.all || !hasExplicitHome;
  if (!listAll) {
    printStatusForHome(niubotHome);
    return;
  }

  const homes = collectStatusHomes(niubotHome, readRegisteredHomes(getHomeRegistryPath()));
  if (homes.length <= 1) {
    printStatusForHome(niubotHome);
    return;
  }

  console.log("NiuBot instances:");
  for (const home of homes) {
    console.log();
    console.log(`Home: ${home}`);
    printStatusForHome(home);
  }
}

// ── Version ────────────────────────────────────────────────

function cmdVersion(flags: CliFlags = {}): void {
  console.log(`niubot v${getPkgVersion()}`);
  if (!flags.verbose) return;

  const npmCommand = resolveNpmCommandForCurrentNode();
  const npmRoot = readNpmRoot(npmCommand);
  const npmPrefix = deriveNpmPrefixFromPackageRoot(PROJECT_ROOT);
  console.log(`CLI: ${entryPath ?? process.argv[1] ?? "unknown"}`);
  console.log(`Package: ${PROJECT_ROOT}`);
  console.log(`Node: ${getNodeRuntimeLabel()}`);
  console.log(`npm: ${npmCommand}`);
  if (npmRoot) console.log(`npm root: ${npmRoot}`);
  if (npmPrefix) console.log(`npm prefix: ${npmPrefix}`);
}

// ── Update ────────────────────────────────────────────────

const PKG_NAME = "@yuanzhangjing/niubot";

export function parseNiubotVersionOutput(output: string): string | undefined {
  const match = output.trim().match(/^niubot v(.+)$/);
  return match?.[1];
}

function readActiveCliVersion(): string | undefined {
  try {
    const output = execFileSync("niubot", ["version"], {
      encoding: "utf-8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseNiubotVersionOutput(output);
  } catch {
    return undefined;
  }
}

/** Check npm registry for a newer version. Returns latest version or null. */
function checkForUpdate(): string | null {
  const local = getPkgVersion();
  const npmCommand = resolveNpmCommandForCurrentNode();
  try {
    const latest = execFileSync(npmCommand, ["view", `${PKG_NAME}@latest`, "version"], {
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
  const npmCommand = resolveNpmCommandForCurrentNode();
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

  const npmRoot = readNpmRoot(npmCommand);
  if (npmRoot && !isPackageRootInsideNpmRoot(PROJECT_ROOT, npmRoot)) {
    fail("Refusing to update because npm global root does not match the active niubot installation.");
    hint(`Current niubot package: ${PROJECT_ROOT}`);
    hint(`Current Node: ${process.execPath}`);
    hint(`npm command: ${npmCommand}`);
    hint(`npm root -g: ${npmRoot}`);
    hint("Use the npm that owns the active niubot install, or fix PATH so niubot and npm use the same Node runtime.");
    console.log();
    process.exit(1);
  }

  // Install
  info(`Installing ${PKG_NAME}@${latest} ...`);
  try {
    execFileSync(npmCommand, ["install", "-g", `${PKG_NAME}@${latest}`], {
      encoding: "utf-8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    fail(`Install failed: ${err instanceof Error ? err.message : err}`);
    hint("Try manually: npm install -g " + PKG_NAME + "@latest");
    console.log();
    process.exit(1);
  }

  const activeVersion = readActiveCliVersion();
  if (activeVersion && activeVersion !== latest) {
    fail(`Installed ${latest}, but the active niubot command is still ${activeVersion}.`);
    hint("You probably have multiple global npm installs or PATH is resolving an older binary first.");
    hint("Check with: which -a niubot");
    hint("Check npm prefix with: npm root -g");
    console.log();
    process.exit(1);
  }
  ok(`Updated to ${latest}`);

  // Restart if running
  const pidFile = path.join(niubotHome, "niubot.pid");
  if (!fs.existsSync(pidFile)) {
    console.log();
    hint(`No running service found (looked in ${niubotHome}).`);
    hint("Start it with: niubot start");
    console.log();
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  if (!isProcessRunning(pid)) {
    fs.unlinkSync(pidFile);
    console.log();
    hint("Service is not running (stale PID file removed). Start it with: niubot start");
    console.log();
    return;
  }

  console.log();
  info("Restarting service...");
  stopProcess(niubotHome);

  // Re-exec start with the NEW binary (the just-installed version)
  try {
    execFileSync(process.execPath, [path.join(PROJECT_ROOT, "dist", "user-cli.js"), "start"], {
      encoding: "utf-8",
      timeout: 30000,
      stdio: "inherit",
      env: { ...process.env, NIUBOT_HOME: niubotHome },
    });
  } catch {
    hint("Auto-restart failed. Run 'niubot start' manually.");
  }

  console.log();
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

function getUsageText(): string {
  return `NiuBot v${getPkgVersion()}

Usage: niubot <command> [options]

Commands:
  init       Initialize NiuBot (environment check + config templates)
  add-bot    Add a new bot to an existing installation
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
  --restart  Stop existing process first if running

Status options:
  --all      List all registered NiuBot homes

Agent install guide: run \`${INSTALL_GUIDE_COMMAND}\` and follow it.`;
}

function printUsage(): void {
  console.log(getUsageText());
}

// ── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, flags } = parseCliArgs(process.argv.slice(2));
  const envHome = process.env["NIUBOT_HOME"];
  const hasExplicitHome = flags.home !== undefined || envHome !== undefined;
  const niubotHome = resolveNiubotHome(flags.home, envHome);

  switch (command) {
    case "init":
      await cmdInit(niubotHome, flags);
      break;
    case "add-bot":
      await cmdAddBot(niubotHome);
      break;
    case "start":
      cmdStart(niubotHome, flags);
      break;
    case "stop":
      cmdStop(niubotHome);
      break;
    case "status":
      cmdStatus(niubotHome, flags, hasExplicitHome);
      break;
    case "update":
      cmdUpdate(niubotHome);
      break;
    case "version":
    case "--version":
    case "-v":
      cmdVersion(flags);
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
