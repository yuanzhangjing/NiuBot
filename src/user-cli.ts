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

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import yaml from "yaml";
import { DEFAULT_BOT_PROFILE } from "./bot-profile.js";
import { AGENT_REGISTRY, expandHome, loadConfig, normalizeBackend, resolveHomePath, type NiuBotConfig } from "./config.js";
import { INSTALL_GUIDE_COMMAND } from "./install-guide.js";
import { localToday } from "./tz.js";
import { waitForLocalApiHealth } from "./local-api/client.js";
import { resolveBotEndpoint } from "./platform/ipc.js";
import { probeAllBackendCapabilities, probeBackendCapability } from "./agent/backend-capability.js";
import { waitForEngineIdentity } from "./local-api/engine-client.js";
import { resolveEngineStartTimeoutMs } from "./lifecycle-timeouts.js";
import { inspectRunningEngine, launchDetachedEngine, stopEngine } from "./process-manager.js";
import { launchRestartWorker } from "./restart-launcher.js";
import { runCommand, runCommandSync } from "./platform/command.js";
import {
  commandLookupHint,
  deriveNpmPrefixFromPackageRoot,
  isPackageRootInsideNpmRoot,
  resolveNpmExecutableForNode,
  withNodeRuntimeOnPath,
} from "./platform/executable.js";
import { clearProcessState, readProcessState } from "./process-state.js";
import {
  isProcessAlive,
  queryProcessFileDescriptorPath,
  queryProcessWorkingDirectory,
} from "./platform/process.js";
import { isNewerPackageVersion } from "./version.js";
import { preflightGlobalNpmInstall, verifyInstalledPackage } from "./npm-install-preflight.js";
import { isSupportedNodeMajor, SUPPORTED_NODE_MAJORS } from "./node-support.js";
import {
  GlobalInstallError,
  resolvePrimaryGlobalCommand,
  runRecoverableGlobalInstall,
} from "./global-npm-install.js";

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

function resolveNpmCommandForCurrentNode(): string {
  return resolveNpmExecutableForNode(process.execPath) ?? "npm";
}

function npmEnvironmentForCurrentNode(): NodeJS.ProcessEnv {
  return withNodeRuntimeOnPath(process.execPath);
}

function safeCurrentWorkingDirectory(): string {
  try {
    return process.cwd();
  } catch {
    return os.homedir();
  }
}

export function resolveNiubotHome(flagHome: string | undefined, envHome: string | undefined, cwd?: string): string {
  return resolveHomePath(flagHome ?? envHome ?? path.join(os.homedir(), ".niubot"), cwd ?? safeCurrentWorkingDirectory());
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
    return runCommandSync(npmCommand, ["root", "-g"], {
      timeoutMs: 8_000,
      cwd: safeCurrentWorkingDirectory(),
      env: npmEnvironmentForCurrentNode(),
    }).stdout.trim();
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
    const Database = requireFromPackage("better-sqlite3") as new (filename: string) => { close(): void };
    const database = new Database(":memory:");
    database.close();
    ok("Native dependencies loadable");
  } catch (err) {
    fail("Native dependency check failed");
    hint(`Node: ${process.execPath}`);
    hint(`ABI: ${process.versions.modules}`);
    hint(`Package: ${PROJECT_ROOT}`);
    hint("Reinstall or update NiuBot with the npm that belongs to this Node installation.");
    hint(`Error: ${err instanceof Error ? err.message : String(err)}`);
    issues.push("native-dependencies");
  }
}

function checkNodeVersion(): CheckResult {
  const major = parseInt(process.versions.node.split(".")[0]!, 10);
  const ver = process.versions.node;
  if (isSupportedNodeMajor(major)) {
    return { passed: true, label: `Node.js v${ver} (supported LTS: ${SUPPORTED_NODE_MAJORS.join(", ")})` };
  }
  return {
    passed: false,
    label: `Node.js v${ver} (supported LTS: ${SUPPORTED_NODE_MAJORS.join(", ")})`,
    hint: `Use Node.js ${SUPPORTED_NODE_MAJORS.join(", ")} and install NiuBot with that Node installation's npm.`,
  };
}

interface BackendScanResult {
  name: string;
  available: boolean;
  version?: string;
  error?: string;
}

function scanBackend(name: string): BackendScanResult {
  const capability = probeBackendCapability(name);
  if (!capability) return { name, available: false, error: "unknown backend" };
  return {
    name: capability.backend,
    available: capability.selectable,
    version: capability.version,
    error: capability.reason,
  };
}

function scanAllBackends(): { results: BackendScanResult[]; firstAvailable?: string } {
  const results: BackendScanResult[] = [];
  let firstAvailable: string | undefined;

  for (const capability of probeAllBackendCapabilities()) {
    const result: BackendScanResult = {
      name: capability.backend,
      available: capability.selectable,
      version: capability.version,
      error: capability.reason,
    };
    results.push(result);
    if (result.available && !firstAvailable) {
      firstAvailable = result.name;
    }
  }

  return { results, firstAvailable };
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
      process.exitCode = 1;
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
    hint("Install claude, codex, traecli, opencode, cursor, pi, or grok CLI");
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
    fs.writeFileSync(configPath, generateConfigTemplate(defaultBackend, botId, appId, appSecret, model));
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

  if (!appId || !appSecret) {
    console.log();
    console.log("  Run 'niubot start' after filling in Feishu credentials.");
  } else {
    console.log();
    const startNow = await prompt("  Start NiuBot now? (Y/n): ");
    if (!startNow || startNow.toLowerCase() === "y" || startNow.toLowerCase() === "yes") {
      console.log();
      await cmdStart(niubotHome, {});
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
    hint("Install claude, codex, traecli, opencode, cursor, pi, or grok CLI");
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

  // Restart hint
  const pidFile = path.join(niubotHome, "niubot.pid");
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (isProcessRunning(pid)) {
      console.log();
      const restart = await prompt("  NiuBot is running. Restart to load the new bot? (Y/n): ");
      if (!restart || restart.toLowerCase() === "y" || restart.toLowerCase() === "yes") {
        console.log();
        await stopProcess(niubotHome);
        await cmdStart(niubotHome, {});
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
): string {
  const id = appId ? `"${appId}"` : '""';
  const secret = appSecret ? `"${appSecret}"` : '""';
  const modelLine = model
    ? `    model: "${model}"         # 主模型\n`
    : '    # model: ""            # 主模型（不设则由 CLI 自行决定）\n';

  return `# NiuBot 配置文件

bots:
  - id: ${botId}              # 唯一标识，决定数据目录路径，初始化后不可修改
    backend: ${backend}        # agent 后端
    appId: ${id}
    appSecret: ${secret}
${modelLine}    # workingDirectory: ~/niubot-workspace/NiuBot  # agent 工作目录（默认 ~/niubot-workspace/<id>）

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

async function cmdStart(niubotHome: string, flags: CliFlags): Promise<void> {
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
  const nodeCheck = checkNodeVersion();
  if (nodeCheck.passed) {
    ok(nodeCheck.label);
  } else {
    fail(nodeCheck.label);
    if (nodeCheck.hint) hint(nodeCheck.hint);
    issues.push("node-version");
  }
  checkNativeDependencies(issues);

  // Check backend availability (deduplicate across bots)
  const backendsToCheck = new Set(config.bots.map((b) => b.backend).filter((b): b is string => !!b));
  for (const be of backendsToCheck) {
    const backendScan = scanBackend(be);
    if (backendScan.available) {
      ok(`${be} CLI available${backendScan.version ? ` (v${backendScan.version})` : ""}`);
    } else {
      fail(`${be} backend unavailable`);
      hint(backendScan.error ?? `Install ${be} CLI, or change backend in config.yaml`);
      issues.push("backend");
    }
  }

  // Check for existing process
  const pidFile = path.join(niubotHome, "niubot.pid");
  const recordedState = readProcessState(niubotHome);
  const runningEngine = await inspectRunningEngine(niubotHome);
  if (runningEngine) {
    if (flags.restart) {
      if (process.env["NIUBOT_AGENT_SESSION"]) {
        fail("Cannot restart from within a bot session. Use /restart in Feishu or run directly in your terminal.");
        process.exit(1);
      }
      info("Existing process found, stopping first...");
      await stopProcess(niubotHome);
    } else {
      fail(`Already running (PID ${runningEngine.state.pid})`);
      hint("Use 'niubot stop' first, or 'niubot start --restart'");
      issues.push("process");
    }
  } else if (recordedState) {
    const state = recordedState.processes.engine;
    if (isProcessAlive(state.pid)) {
      if (flags.restart) {
        if (process.env["NIUBOT_AGENT_SESSION"]) {
          fail("Cannot restart from within a bot session. Use /restart in Feishu or run directly in your terminal.");
          process.exit(1);
        }
        info("Existing process is not responding; verifying its creation marker before stopping...");
        await stopProcess(niubotHome);
      } else {
        fail(`Process ${state.pid} exists, but Engine identity cannot be verified`);
        hint("Use 'niubot restart' to attempt a verified recovery, or inspect the service log.");
        issues.push("process");
      }
    } else {
      clearProcessState(niubotHome, state.instanceId);
      try { fs.unlinkSync(pidFile); } catch { /* already absent */ }
      ok("Removed stale process state");
    }
  } else if (fs.existsSync(pidFile)) {
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
        await stopProcess(niubotHome);
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

  const launched = launchDetachedEngine({
    niubotHome,
    engineEntry: path.join(PROJECT_ROOT, "dist", "index.js"),
    runtimePath: PROJECT_ROOT,
    logFile,
    version: getPkgVersion(),
    env: {
      NIUBOT_LOG_LEVEL: process.env["NIUBOT_LOG_LEVEL"] ?? "info",
      NIUBOT_DEBUG_AGENT_STDOUT: process.env["NIUBOT_DEBUG_AGENT_STDOUT"] ?? "",
    },
  });
  // Snapshot the version at startup so status shows the actual running version
  fs.writeFileSync(path.join(niubotHome, "niubot.version"), getPkgVersion());
  fs.writeFileSync(path.join(niubotHome, "niubot.node"), getNodeRuntimeLabel());
  try {
    registerHomePath(getHomeRegistryPath(), niubotHome);
  } catch (err) {
    hint(`Could not update home registry: ${err instanceof Error ? err.message : String(err)}`);
  }
  ok(`Process started (PID ${launched.state.pid})`);
  info(`Log: ${logFile}`);

  const engineStartTimeoutMs = resolveEngineStartTimeoutMs();
  const engineStartDeadline = Date.now() + engineStartTimeoutMs;
  const engineIdentity = await waitForEngineIdentity(
    launched.endpoint,
    {
      instanceId: launched.state.instanceId,
      pid: launched.state.pid,
      home: niubotHome,
      runtimePath: launched.state.runtimePath,
    },
    engineStartTimeoutMs,
    250,
  );
  if (engineIdentity) {
    ok("Engine identity check passed");
  } else {
    fail("Engine identity check failed");
  }

  // Health check — all bots must respond
  const botHealthTimeoutMs = Math.max(1, engineStartDeadline - Date.now());
  const botHealth = await Promise.all(config.bots.map(async (bot) => {
    const endpoint = resolveBotEndpoint(niubotHome, bot.id, { unixSocketDirectory: path.dirname(bot.dbPath) });
    const healthy = await waitForLocalApiHealth(endpoint, botHealthTimeoutMs, 1_000);
    return { bot, healthy };
  }));
  const failedBots: string[] = [];
  for (const { bot, healthy } of botHealth) {
    if (healthy) {
      ok(`${bot.id} health check passed`);
    } else {
      fail(`${bot.id} health check failed`);
      failedBots.push(bot.id);
    }
  }

  console.log();
  if (failedBots.length === 0 && engineIdentity) {
    console.log("NiuBot is running.");
    console.log(`  Log: ${logFile}`);
    for (const bot of config.bots) {
      console.log(`  API: ${resolveBotEndpoint(niubotHome, bot.id, { unixSocketDirectory: path.dirname(bot.dbPath) }).address}`);
    }
  } else {
    hint(`Check log: ${logFile}`);
    console.log("NiuBot started, but did not become healthy before the startup deadline.");
    process.exitCode = 1;
    console.log();
    return;
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

async function cmdStop(niubotHome: string): Promise<void> {
  const stopped = await stopProcess(niubotHome);
  if (!stopped) {
    console.log("NiuBot is not running.");
  }
}

async function cmdRestart(niubotHome: string): Promise<void> {
  if (process.env["NIUBOT_AGENT_SESSION"]) {
    fail("Cannot restart from within a bot session. Use /restart in Feishu or run directly in your terminal.");
    process.exitCode = 1;
    return;
  }
  const running = await inspectRunningEngine(niubotHome);
  if (!running) {
    fail("NiuBot is not running or its process identity cannot be verified.");
    hint("Use 'niubot status --home <path>' to confirm the instance.");
    process.exitCode = 1;
    return;
  }
  const config = loadConfig(path.join(niubotHome, "config.yaml"));
  const worker = launchRestartWorker({
    niubotHome,
    botName: config.bots[0]?.id ?? "NiuBot",
    runtimeRoot: PROJECT_ROOT,
    sourceDirectory: running.identity.runtimePath,
    runtimeMode: running.state.runtimeMode ?? "",
  });
  console.log(`Restart started (worker PID ${worker.pid})`);
  console.log(`  Log: ${worker.logFile}`);
}

async function stopProcess(niubotHome: string): Promise<boolean> {
  const result = await stopEngine(niubotHome);
  if (result.stopped) console.log(`NiuBot stopped (PID ${result.pid})`);
  return result.stopped;
}

// ── Status ─────────────────────────────────────────────────

async function printStatusForHome(niubotHome: string): Promise<void> {
  const running = await inspectRunningEngine(niubotHome);
  if (running) {
    const logFile = running.state.logFile ?? getTodayLogFilePath(niubotHome);
    const uptime = formatDuration(Date.now() - Date.parse(running.state.startedAt));
    console.log(`NiuBot is running (PID ${running.state.pid})`);
    console.log(`  Version: ${running.identity.version}`);
    console.log(`  Path: ${running.identity.runtimePath}`);
    console.log(`  Node: ${running.state.nodePath}`);
    if (uptime) console.log(`  Uptime: ${uptime}`);
    console.log(`  Log: ${logFile}`);
    console.log(`  Config: ${path.join(niubotHome, "config.yaml")}`);
    console.log(`  API: ${running.state.endpoint}`);
    return;
  }

  const recordedState = readProcessState(niubotHome);
  if (recordedState) {
    const state = recordedState.processes.engine;
    if (isProcessAlive(state.pid)) {
      console.log(`NiuBot process exists (PID ${state.pid}), but Engine identity cannot be verified.`);
      console.log(`  State: ${path.join(niubotHome, "run", "process-state.json")}`);
      console.log(`  Log: ${state.logFile ?? getTodayLogFilePath(niubotHome)}`);
      return;
    }
    clearProcessState(niubotHome, state.instanceId);
    try { fs.unlinkSync(path.join(niubotHome, "niubot.pid")); } catch { /* already absent */ }
    console.log("NiuBot is not running (stale process state removed).");
    return;
  }

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

  const logFile = getTodayLogFilePath(niubotHome);
  const configPath = path.join(niubotHome, "config.yaml");
  const details = resolveRunningStatusDetails({
    niubotHome,
    cliPath: __dirname,
    todayLogFile: logFile,
    processCwd: queryProcessWorkingDirectory(pid),
    processStdoutPath: queryProcessFileDescriptorPath(pid, 1),
  });

  console.log(`NiuBot is running (PID ${pid})`);
  console.log(`  Version: ${details.version}`);
  console.log(`  Path: ${details.path}`);
  if (details.node) console.log(`  Node: ${details.node}`);
  console.log(`  Log: ${details.logFile}`);
  console.log(`  Config: ${configPath}`);
}

async function cmdStatus(niubotHome: string, flags: CliFlags, hasExplicitHome: boolean): Promise<void> {
  const listAll = flags.all || !hasExplicitHome;
  if (!listAll) {
    await printStatusForHome(niubotHome);
    return;
  }

  const homes = collectStatusHomes(niubotHome, readRegisteredHomes(getHomeRegistryPath()));
  if (homes.length <= 1) {
    await printStatusForHome(niubotHome);
    return;
  }

  console.log("NiuBot instances:");
  for (const home of homes) {
    console.log();
    console.log(`Home: ${home}`);
    await printStatusForHome(home);
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
    const output = runCommandSync("niubot", ["version"], {
      timeoutMs: 8_000,
      cwd: safeCurrentWorkingDirectory(),
    }).stdout;
    return parseNiubotVersionOutput(output);
  } catch {
    return undefined;
  }
}

function fetchLatestVersion(): string {
  const npmCommand = resolveNpmCommandForCurrentNode();
  const latest = runCommandSync(npmCommand, ["view", `${PKG_NAME}@latest`, "version"], {
    timeoutMs: 8_000,
    cwd: safeCurrentWorkingDirectory(),
    env: npmEnvironmentForCurrentNode(),
  }).stdout.trim();
  if (!latest || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(latest)) {
    throw new Error(`npm returned an invalid latest version: ${latest || "(empty)"}`);
  }
  return latest;
}

/** Best-effort startup check. Registry errors are intentionally silent here. */
function checkForUpdate(): string | null {
  const local = getPkgVersion();
  try {
    const latest = fetchLatestVersion();
    if (latest && isNewerPackageVersion(latest, local)) return latest;
  } catch { /* network error, not published, etc. */ }
  return null;
}

async function cmdUpdate(niubotHome: string): Promise<void> {
  const running = await inspectRunningEngine(niubotHome);
  const recordedState = readProcessState(niubotHome);
  if (!running && recordedState && isProcessAlive(recordedState.processes.engine.pid)) {
    fail(`Process ${recordedState.processes.engine.pid} exists, but Engine identity cannot be verified.`);
    hint("Refusing to modify the installation while a possibly running Engine is unverified.");
    process.exitCode = 1;
    return;
  }

  const current = running?.identity.version ?? getPkgVersion();
  const npmCommand = resolveNpmCommandForCurrentNode();
  console.log();
  console.log(`Current version: ${current}`);

  // Check for latest
  info("Checking npm registry...");
  let latest: string;
  try {
    latest = fetchLatestVersion();
  } catch (err) {
    fail(`Update check failed: ${err instanceof Error ? err.message : String(err)}`);
    console.log();
    process.exitCode = 1;
    return;
  }
  if (!isNewerPackageVersion(latest, current)) {
    ok("Already up to date.");
    console.log();
    return;
  }

  console.log(`  New version available: ${latest}`);
  console.log();

  if (running) {
    if (process.env["NIUBOT_AGENT_SESSION"]) {
      fail("Cannot update from within a bot session. Use /update in Feishu or run directly in your terminal.");
      process.exitCode = 1;
      return;
    }
    const config = loadConfig(path.join(niubotHome, "config.yaml"));
    const worker = launchRestartWorker({
      niubotHome,
      botName: config.bots[0]?.id ?? "NiuBot",
      runtimeRoot: PROJECT_ROOT,
      sourceDirectory: running.identity.runtimePath,
      runtimeMode: running.state.runtimeMode ?? "",
      updateVersion: latest,
    });
    info(`Update started (worker PID ${worker.pid})`);
    info(`Log: ${worker.logFile}`);
    console.log();
    return;
  }

  const nodeCheck = checkNodeVersion();
  if (!nodeCheck.passed) {
    fail(nodeCheck.label);
    if (nodeCheck.hint) hint(nodeCheck.hint);
    console.log();
    process.exitCode = 1;
    return;
  }

  const npmRoot = readNpmRoot(npmCommand);
  if (!npmRoot) {
    fail("Refusing to update because the active npm global root could not be determined.");
    hint(`Current Node: ${process.execPath}`);
    hint(`npm command: ${npmCommand}`);
    hint("Fix this Node/npm installation before retrying; do not switch to an unrelated npm global prefix.");
    console.log();
    process.exitCode = 1;
    return;
  }
  if (!isPackageRootInsideNpmRoot(PROJECT_ROOT, npmRoot)) {
    fail("Refusing to update because npm global root does not match the active niubot installation.");
    hint(`Current niubot package: ${PROJECT_ROOT}`);
    hint(`Current Node: ${process.execPath}`);
    hint(`npm command: ${npmCommand}`);
    hint(`npm root -g: ${npmRoot}`);
    hint("Use the npm that owns the active niubot install, or fix PATH so niubot and npm use the same Node runtime.");
    console.log();
    process.exitCode = 1;
    return;
  }
  const npmPrefix = deriveNpmPrefixFromPackageRoot(PROJECT_ROOT);
  if (!npmPrefix) {
    fail("Refusing to update because the npm global prefix could not be derived from the active package.");
    hint(`Current niubot package: ${PROJECT_ROOT}`);
    console.log();
    process.exitCode = 1;
    return;
  }
  const npmUpdateCwd = resolveNpmUpdateWorkingDirectory(PROJECT_ROOT, npmPrefix);

  const npmEnv = npmEnvironmentForCurrentNode();
  info(`Validating ${PKG_NAME}@${latest} in an isolated installation...`);
  try {
    await preflightGlobalNpmInstall({
      npmCommand,
      nodePath: process.execPath,
      packageName: PKG_NAME,
      packageSpec: `${PKG_NAME}@${latest}`,
      expectedVersion: latest,
      cwd: npmUpdateCwd,
      env: npmEnv,
      timeoutMs: 600_000,
    });
    ok("Isolated installation and native dependency check passed");
  } catch (err) {
    fail(`Candidate validation failed: ${err instanceof Error ? err.message : String(err)}`);
    hint("The active global installation was not modified.");
    hint("Retry with the same Node/npm installation after fixing the reported problem.");
    console.log();
    process.exitCode = 1;
    return;
  }

  // Install with a recoverable snapshot of the active package and npm shims.
  info(`Installing ${PKG_NAME}@${latest} ...`);
  try {
    const transaction = await runRecoverableGlobalInstall({
      packageRoot: PROJECT_ROOT,
      npmPrefix,
      commandName: "niubot",
      install: async () => {
        await runCommand(npmCommand, ["install", "-g", `${PKG_NAME}@${latest}`], {
          timeoutMs: 600_000,
          cwd: npmUpdateCwd,
          env: npmEnv,
        });
      },
      verify: () => verifyGlobalNpmInstall(PROJECT_ROOT, npmPrefix, latest, npmUpdateCwd, npmEnv),
      verifyRollback: () => verifyGlobalNpmInstall(PROJECT_ROOT, npmPrefix, current, npmUpdateCwd, npmEnv),
    });
    if (transaction.cleanupWarning) hint(transaction.cleanupWarning);
  } catch (err) {
    fail(`Install failed: ${err instanceof Error ? err.message : err}`);
    if (err instanceof GlobalInstallError && err.restored) {
      hint("The previous NiuBot package and command files were restored.");
    } else if (err instanceof GlobalInstallError && err.recoveryDirectory) {
      hint(`Keep the recovery copy for repair: ${err.recoveryDirectory}`);
    }
    hint(`Check the active commands with: ${commandLookupHint("node")}, ${commandLookupHint("npm")}, and ${commandLookupHint("niubot")}`);
    console.log();
    process.exitCode = 1;
    return;
  }

  const activeVersion = readActiveCliVersion();
  if (activeVersion && activeVersion !== latest) {
    fail(`Installed ${latest}, but the active niubot command is still ${activeVersion}.`);
    hint("You probably have multiple global npm installs or PATH is resolving an older binary first.");
    hint(`Check with: ${commandLookupHint("niubot")}`);
    hint("Check npm prefix with: npm root -g");
    console.log();
    process.exitCode = 1;
    return;
  }
  ok(`Updated to ${latest}`);

  hint(`No running service found in ${niubotHome}. Start it with: niubot start`);
  console.log();
}

async function verifyGlobalNpmInstall(
  packageRoot: string,
  npmPrefix: string,
  expectedVersion: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await verifyInstalledPackage({
    packageRoot,
    nodePath: process.execPath,
    packageName: PKG_NAME,
    expectedVersion,
    cwd,
    env,
  });
  const command = resolvePrimaryGlobalCommand(npmPrefix, "niubot");
  const output = (await runCommand(command, ["version"], {
    timeoutMs: 30_000,
    cwd,
    env,
  })).stdout.trim();
  const expectedOutput = `niubot v${expectedVersion}`;
  if (output !== expectedOutput) {
    throw new Error(`installed command returned ${JSON.stringify(output)}; expected ${JSON.stringify(expectedOutput)}`);
  }
}

function resolveNpmUpdateWorkingDirectory(packageRoot: string, npmPrefix: string): string {
  const cwd = safeCurrentWorkingDirectory();
  const relative = path.relative(path.resolve(packageRoot), path.resolve(cwd));
  const cwdIsInsidePackage = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  return cwdIsInsidePackage ? npmPrefix : cwd;
}

// ── Utilities ──────────────────────────────────────────────

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "";
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [days ? `${days}d` : "", hours || days ? `${hours}h` : "", minutes || hours || days ? `${minutes}m` : "", `${seconds}s`]
    .filter(Boolean)
    .join(" ");
}

function isProcessRunning(pid: number): boolean {
  return isProcessAlive(pid);
}

function cmdInstallGuide(): void {
  process.stdout.write(fs.readFileSync(path.join(PROJECT_ROOT, "INSTALL.md"), "utf-8"));
}

// ── Usage ──────────────────────────────────────────────────

function getUsageText(): string {
  return `NiuBot v${getPkgVersion()}

Usage: niubot <command> [options]

Commands:
  init       Initialize NiuBot (environment check + config templates)
  add-bot    Add a new bot to an existing installation
  start      Start the NiuBot service
  restart    Safely rebuild or restart the running service
  stop       Stop the NiuBot service
  status     Show service status
  update     Check for updates and install latest version
  version    Show version
  install-guide  Print the agent installation guide

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
      await cmdStart(niubotHome, flags);
      break;
    case "restart":
      await cmdRestart(niubotHome);
      break;
    case "stop":
      await cmdStop(niubotHome);
      break;
    case "status":
      await cmdStatus(niubotHome, flags, hasExplicitHome);
      break;
    case "update":
      await cmdUpdate(niubotHome);
      break;
    case "version":
    case "--version":
    case "-v":
      cmdVersion(flags);
      break;
    case "install-guide":
      cmdInstallGuide();
      break;
    default:
      printUsage();
      break;
  }
}

const entryPath = process.argv[1] ? fs.realpathSync(path.resolve(process.argv[1])) : undefined;
const modulePath = fileURLToPath(import.meta.url);

if (entryPath === modulePath) {
  void main().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
