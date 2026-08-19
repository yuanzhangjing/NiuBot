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
import { AGENT_REGISTRY, expandHome, loadConfig, normalizeBackend, resolveHomePath, updateConfigFileAtomically, type NiuBotConfig } from "./config.js";
import { INSTALL_GUIDE_COMMAND } from "./install-guide.js";
import { localToday } from "./tz.js";
import { localApiRequest, waitForLocalApiHealth } from "./local-api/client.js";
import { resolveBotEndpoint, type LocalIpcEndpoint } from "./platform/ipc.js";
import { recoverFileReplacementSync, replaceFileSync } from "./platform/files.js";
import { probeAllBackendCapabilities, probeBackendCapability } from "./agent/backend-capability.js";
import { waitForEngineIdentity } from "./local-api/engine-client.js";
import { resolveEngineStartTimeoutMs } from "./lifecycle-timeouts.js";
import { inspectRunningEngine, launchDetachedEngine, stopEngine } from "./process-manager.js";
import { launchRestartWorker } from "./restart-launcher.js";
import {
  restartCompletion,
  restartPhaseLabel,
  waitForRestartCompletion,
} from "./restart-progress.js";
import { runCommand, runCommandSync } from "./platform/command.js";
import {
  deriveNpmPrefixFromPackageRoot,
  resolveNpmExecutableForNode,
  withNodeRuntimeOnPath,
} from "./platform/executable.js";
import { clearProcessState, readProcessState } from "./process-state.js";
import {
  isProcessAlive,
  queryProcessFileDescriptorPath,
  queryProcessWorkingDirectory,
} from "./platform/process.js";
import { isNewerPackageVersion, isProductionVersion, runtimeEnvironmentForVersion } from "./version.js";
import {
  isSupportedNodeMajor,
  MINIMUM_NODE_MAJOR,
  WINDOWS_TESTED_NODE_MAJORS,
} from "./node-support.js";
import { HomeReleaseStore } from "./home-release-store.js";
import { sameReleaseRef } from "./release-ref.js";
import { RecommendedReleaseStore, shouldAdoptRecommendedRelease } from "./recommended-release.js";
import { cleanupLegacyReleases, cleanupSharedReleases } from "./release-cleanup.js";
import { resolveSharedRuntimeRoot } from "./platform/shared-runtime.js";
import { SharedReleaseStore } from "./shared-release-store.js";
import { parseArgs } from "./cli/args.js";
import { assertNoPendingBotTransfer, exportBotBundle, moveBot } from "./bot-transfer.js";
import { launchBotTransferWorker } from "./bot-transfer-launcher.js";
import { recoverStaleBotTransferLifecycles } from "./bot-transfer-worker.js";

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
  detach?: boolean;
  force?: boolean;
  help?: boolean;
  restart?: boolean;
  verbose?: boolean;
  all?: boolean;
  apply?: boolean;
  home?: string;
  unknown?: string[];
}

function parseCliArgs(args: string[]): {
  command: string | undefined;
  commandIndex: number;
  flags: CliFlags;
  extraPositionals: string[];
} {
  const flags: CliFlags = {};
  const extraPositionals: string[] = [];
  let command: string | undefined;
  let commandIndex = -1;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (command && i > commandIndex && (command === "bot" || command === "help")) continue;
    if (arg === "--check") flags.check = true;
    else if (arg === "--detach") flags.detach = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--restart") flags.restart = true;
    else if (arg === "--verbose") flags.verbose = true;
    else if (arg === "--all") flags.all = true;
    else if (arg === "--apply") flags.apply = true;
    else if ((arg === "--version" || arg === "-v") && !command) {
      command = arg;
      commandIndex = i;
    }
    else if (arg.startsWith("--home=")) {
      const value = arg.slice("--home=".length);
      if (!value) throw new Error("--home requires a path");
      flags.home = value;
    }
    else if (arg === "--home") {
      if (i + 1 >= args.length || args[i + 1]!.startsWith("-")) {
        throw new Error("--home requires a path");
      }
      flags.home = args[++i];
    } else if (!arg.startsWith("-") && !command) {
      command = arg;
      commandIndex = i;
    } else if (!arg.startsWith("-") && command !== "bot" && command !== "help") {
      extraPositionals.push(arg);
    } else if (arg.startsWith("-") && command !== "bot") {
      (flags.unknown ??= []).push(arg);
    }
  }

  return { command, commandIndex, flags, extraPositionals };
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
    recoverFileReplacementSync(registryPath);
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
  const temporary = path.join(path.dirname(registryPath), `.instances.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify({ homes }, null, 2)}\n`, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    replaceFileSync(temporary, registryPath);
  } catch (err) {
    try { fs.unlinkSync(temporary); } catch { /* ignore */ }
    throw err;
  }
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
    const support = WINDOWS_TESTED_NODE_MAJORS.includes(
      major as (typeof WINDOWS_TESTED_NODE_MAJORS)[number],
    )
      ? `tested LTS: ${WINDOWS_TESTED_NODE_MAJORS.join(", ")}`
      : `Node.js ${MINIMUM_NODE_MAJOR}+; native dependencies verified separately`;
    return { passed: true, label: `Node.js v${ver} (${support})` };
  }
  const windows = process.platform === "win32";
  return {
    passed: false,
    label: windows
      ? `Node.js v${ver} (tested Windows LTS: ${WINDOWS_TESTED_NODE_MAJORS.join(", ")})`
      : `Node.js v${ver} (minimum: ${MINIMUM_NODE_MAJOR})`,
    hint: windows
      ? `Use Node.js ${WINDOWS_TESTED_NODE_MAJORS.join(", ")} and install NiuBot with that Node installation's npm.`
      : `Use Node.js ${MINIMUM_NODE_MAJOR} or newer and install NiuBot with that Node installation's npm.`,
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

  appendBotToConfig(configPath, newBot);
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

/** 重读并合并最新配置，避免 add-bot 交互期间覆盖其他设置。 */
export function appendBotToConfig(configPath: string, newBot: Record<string, string>): void {
  updateConfigFileAtomically(configPath, (raw, format) => {
    if (format !== "yaml") throw new Error("add-bot only supports config.yaml");
    const latest = yaml.parse(raw) as Record<string, unknown>;
    if (!Array.isArray(latest["bots"])) throw new Error("config.yaml uses legacy format (no 'bots' array)");
    const bots = latest["bots"] as Array<Record<string, unknown>>;
    const botId = newBot["id"] ?? "";
    if (bots.some((bot) => String(bot["id"] ?? bot["name"] ?? "") === botId)) {
      throw new Error(`Bot ID '${botId}' already exists in config.yaml`);
    }
    latest["bots"] = [...bots, newBot];
    return yaml.stringify(latest, { lineWidth: 0 });
  });
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
# timezone: Asia/Shanghai   # 展示时区（默认北京时间）

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
# NIUBOT_TZ=Asia/Shanghai       # 展示时区（config.yaml timezone 优先，没有再读这个，再默认北京时间）
# NIUBOT_DEBUG_AGENT_STDOUT=1   # 将每轮 agent 完整 stdout 追加到 logs/agent-stdout-YYYY-MM-DD.log
`;
}

export function generateBotProfileTemplate(): string {
  return DEFAULT_BOT_PROFILE;
}

// ── Start ──────────────────────────────────────────────────

async function cmdStart(niubotHome: string, flags: CliFlags): Promise<void> {
  console.log();
  await recoverStaleBotTransferLifecycles(niubotHome);
  assertNoPendingBotTransfer(niubotHome);

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

  if (await activateSourceFirstStartIfNeeded(niubotHome, config)) return;
  if (await activateLauncherCandidateIfNeeded(niubotHome, config)) return;
  if (await activateRecommendedReleaseIfNeeded(niubotHome, config)) return;

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
    beforeLaunch: () => {
      assertNoPendingBotTransfer(niubotHome);
      config = loadConfig(configPath);
    },
    env: {
      NIUBOT_LOG_LEVEL: process.env["NIUBOT_LOG_LEVEL"] ?? "info",
      NIUBOT_DEBUG_AGENT_STDOUT: process.env["NIUBOT_DEBUG_AGENT_STDOUT"] ?? "",
    },
  });
  // launchDetachedEngine keeps the legacy version snapshot synchronized for
  // every launch path, including update, restart, and rollback.
  fs.writeFileSync(path.join(niubotHome, "niubot.node"), getNodeRuntimeLabel());
  try {
    const registryStore = new SharedReleaseStore(resolveSharedRuntimeRoot());
    const releaseRegistryLock = registryStore.acquireLock();
    try { registerHomePath(getHomeRegistryPath(), niubotHome); } finally { releaseRegistryLock(); }
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
  const latest = isProductionVersion(getPkgVersion()) ? checkForUpdate() : null;
  if (latest) {
    console.log();
    console.log(`  Update available: ${getPkgVersion()} → ${latest}`);
    console.log(`  Run 'niubot update' to upgrade.`);
  }
  console.log();
}

async function activateRecommendedReleaseIfNeeded(
  niubotHome: string,
  config: NiuBotConfig,
  options: { stopAfterCompletion?: boolean; expectedVersion?: string } = {},
): Promise<boolean> {
  if (!isProductionVersion(getPkgVersion())) return false;
  const sharedStore = new SharedReleaseStore(resolveSharedRuntimeRoot());
  const homeStore = new HomeReleaseStore(niubotHome, sharedStore);
  if (!homeStore.stateExistsRecovering()) return false;
  const state = homeStore.readStateStrict();
  const recommendationStore = new RecommendedReleaseStore(sharedStore);
  let recommended: ReturnType<RecommendedReleaseStore["read"]>;
  try {
    recommended = recommendationStore.stateExistsRecovering() ? recommendationStore.readStrict() : undefined;
  } catch (err) {
    hint(`Recommended version is unavailable; starting the last healthy version: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (!recommended || sameReleaseRef(state.current, recommended.release)) return false;
  if (state.rejectedRecommendation?.generation === recommended.generation
    && state.rejectedRecommendation.artifactId === recommended.release.artifactId) {
    hint(`Recommended version was previously rejected by this home; starting the last healthy version.`);
    return false;
  }

  const manifest = sharedStore.assertUsableArtifact(recommended.release.artifactId, undefined, true);
  if (options.expectedVersion && manifest.version !== options.expectedVersion) return false;
  let currentVersion: string | undefined;
  if (state.current) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(homeStore.resolveRuntime(state.current), "package.json"), "utf-8")) as { version?: unknown };
      currentVersion = typeof pkg.version === "string" ? pkg.version : undefined;
    } catch {
      // A valid recommendation may recover an unusable current.
    }
  }
  if (!shouldAdoptRecommendedRelease(state.current, currentVersion, recommended.release, manifest.version)) return false;
  info(`Safely activating recommended version ${manifest.version}...`);
  const worker = launchRestartWorker({
    niubotHome,
    botName: config.bots[0]?.id ?? "NiuBot",
    runtimeRoot: PROJECT_ROOT,
    sourceDirectory: PROJECT_ROOT,
    environment: "production",
    recommendedArtifactId: recommended.release.artifactId,
    recommendedGeneration: recommended.generation,
    stopAfterCompletion: options.stopAfterCompletion,
  });
  try {
    const result = await waitForRestartCompletion({
      stateFile: worker.stateFile,
      restartId: worker.restartId,
      workerPid: worker.pid,
      onPhase: (restartState) => {
        if (!restartCompletion(restartState)) info(restartPhaseLabel(restartState.phase, manifest.version));
      },
    });
    if (result.completion === "success") {
      ok(options.stopAfterCompletion
        ? `NiuBot updated to recommended version ${manifest.version}; Engine remains stopped.`
        : `NiuBot is running on recommended version ${manifest.version}.`);
      return true;
    }
    if (result.completion === "rolled-back") {
      fail(`Recommended version ${manifest.version} failed; the last healthy version is running.`);
      if (result.state.error) hint(result.state.error);
      process.exitCode = 1;
      return true;
    }
    fail(`Could not start recommended version ${manifest.version}${result.state.error ? `: ${result.state.error}` : "."}`);
    process.exitCode = 1;
    return true;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    hint(`Check ${worker.logFile}`);
    process.exitCode = 1;
    return true;
  }
}

async function activateLauncherCandidateIfNeeded(
  niubotHome: string,
  config: NiuBotConfig,
  options: { stopAfterCompletion?: boolean } = {},
): Promise<boolean> {
  const artifactId = process.env["NIUBOT_LAUNCH_CANDIDATE_ARTIFACT_ID"];
  if (!artifactId) return false;
  const sharedStore = new SharedReleaseStore(resolveSharedRuntimeRoot());
  const manifest = sharedStore.assertUsableArtifact(artifactId, undefined, true);
  const environment = runtimeEnvironmentForVersion(manifest.version);
  if (!environment) throw new Error(`Unsupported launcher candidate version: ${manifest.version}`);
  info(`Safely activating version ${manifest.version}...`);
  const worker = launchRestartWorker({
    niubotHome,
    botName: config.bots[0]?.id ?? "NiuBot",
    runtimeRoot: PROJECT_ROOT,
    sourceDirectory: PROJECT_ROOT,
    environment,
    candidateArtifactId: artifactId,
    stopAfterCompletion: options.stopAfterCompletion,
  });
  try {
    const result = await waitForRestartCompletion({
      stateFile: worker.stateFile,
      restartId: worker.restartId,
      workerPid: worker.pid,
      onPhase: (restartState) => {
        if (!restartCompletion(restartState)) info(restartPhaseLabel(restartState.phase, manifest.version));
      },
    });
    if (result.completion === "success") {
      ok(options.stopAfterCompletion
        ? `NiuBot updated to version ${manifest.version}; Engine remains stopped.`
        : `NiuBot is running on version ${manifest.version}.`);
      return true;
    }
    if (result.completion === "rolled-back") {
      fail(`Version ${manifest.version} failed; the last healthy version is running.`);
      if (result.state.error) hint(result.state.error);
    } else {
      fail(`Could not start version ${manifest.version}${result.state.error ? `: ${result.state.error}` : "."}`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    hint(`Check ${worker.logFile}`);
  }
  process.exitCode = 1;
  return true;
}

async function activateSourceFirstStartIfNeeded(niubotHome: string, config: NiuBotConfig): Promise<boolean> {
  if (process.env["NIUBOT_SOURCE_FIRST_START"] !== "1") return false;
  const sourceDirectory = process.env["NIUBOT_SOURCE_DIR"] ?? PROJECT_ROOT;
  info("Building and safely activating the first DEV artifact...");
  const worker = launchRestartWorker({
    niubotHome,
    botName: config.bots[0]?.id ?? "NiuBot",
    runtimeRoot: PROJECT_ROOT,
    sourceDirectory,
    environment: "dev",
    restartMode: "source",
  });
  try {
    const result = await waitForRestartCompletion({
      stateFile: worker.stateFile,
      restartId: worker.restartId,
      workerPid: worker.pid,
      onPhase: (restartState) => {
        if (!restartCompletion(restartState)) info(restartPhaseLabel(restartState.phase, "DEV"));
      },
    });
    if (result.completion === "success") {
      ok("NiuBot is running on the new DEV artifact.");
      return true;
    }
    fail(result.completion === "rolled-back"
      ? "DEV startup failed; the previous version was restored."
      : `DEV startup failed${result.state.error ? `: ${result.state.error}` : "."}`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    hint(`Check ${worker.logFile}`);
  }
  process.exitCode = 1;
  return true;
}

// ── Stop ───────────────────────────────────────────────────

async function cmdStop(niubotHome: string): Promise<void> {
  const stopped = await stopProcess(niubotHome);
  if (!stopped) {
    console.log("NiuBot is not running.");
  }
}

async function cmdRestart(niubotHome: string): Promise<void> {
  const running = await inspectRunningEngine(niubotHome);
  if (!running) {
    fail("NiuBot is not running or its process identity cannot be verified.");
    hint("Use 'niubot status --home <path>' to confirm the instance.");
    process.exitCode = 1;
    return;
  }
  const config = loadConfig(path.join(niubotHome, "config.yaml"));
  if (await activateLauncherCandidateIfNeeded(niubotHome, config)) return;
  if (await activateRecommendedReleaseIfNeeded(niubotHome, config)) return;
  const worker = launchRestartWorker({
    niubotHome,
    botName: config.bots[0]?.id ?? "NiuBot",
    runtimeRoot: PROJECT_ROOT,
    sourceDirectory: running.identity.runtimePath,
    environment: running.state.runtimeMode ?? process.env["NIUBOT_ENV"] ?? "",
    restartMode: process.env["NIUBOT_LEGACY_SOURCE_MIGRATION"] === "1" ? "source" : undefined,
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

export type EngineAvailability = "running" | "uncertain" | "stopped";

export interface BotRuntimeStatus {
  id: string;
  status: "healthy" | "unhealthy" | "unavailable";
  endpoint: LocalIpcEndpoint;
}

type BotHealthProbe = (endpoint: LocalIpcEndpoint) => Promise<boolean>;

async function probeBotHealth(endpoint: LocalIpcEndpoint): Promise<boolean> {
  try {
    const response = await localApiRequest(endpoint, "/ping", { timeoutMs: 1_000 });
    return response.statusCode === 200;
  } catch {
    return false;
  }
}

export async function inspectBotStatuses(
  niubotHome: string,
  engineAvailability: EngineAvailability,
  probe: BotHealthProbe = probeBotHealth,
): Promise<BotRuntimeStatus[]> {
  const config = loadConfig(path.join(niubotHome, "config.yaml"));
  return Promise.all(config.bots.map(async (bot): Promise<BotRuntimeStatus> => {
    const endpoint = resolveBotEndpoint(niubotHome, bot.id, {
      unixSocketDirectory: path.dirname(bot.dbPath),
    });
    if (engineAvailability === "stopped") {
      return { id: bot.id, endpoint, status: "unavailable" };
    }
    const healthy = await probe(endpoint);
    return {
      id: bot.id,
      endpoint,
      status: healthy
        ? "healthy"
        : engineAvailability === "running" ? "unhealthy" : "unavailable",
    };
  }));
}

async function printBotStatuses(
  niubotHome: string,
  engineAvailability: EngineAvailability,
): Promise<void> {
  console.log("Bots:");
  let statuses: BotRuntimeStatus[];
  try {
    statuses = await inspectBotStatuses(niubotHome, engineAvailability);
  } catch (err) {
    console.log(`  unavailable (config error: ${err instanceof Error ? err.message : String(err)})`);
    return;
  }

  for (const { id, endpoint, status } of statuses) {
    console.log(`  ${id}: ${status}`);
    console.log(`    API: ${endpoint.address}`);
  }
}

async function printStatusForHome(niubotHome: string): Promise<void> {
  console.log(`Home: ${niubotHome}`);
  const running = await inspectRunningEngine(niubotHome);
  if (running) {
    const logFile = running.state.logFile ?? getTodayLogFilePath(niubotHome);
    const uptime = formatDuration(Date.now() - Date.parse(running.state.startedAt));
    console.log(`Engine: running (PID ${running.state.pid})`);
    console.log(`  Version: ${running.identity.version}`);
    console.log(`  Path: ${running.identity.runtimePath}`);
    const sharedStore = new SharedReleaseStore(resolveSharedRuntimeRoot());
    const artifactId = sharedStore.artifactIdForRuntimePath(running.identity.runtimePath);
    console.log(`  Storage: ${artifactId ? `shared (${artifactId})` : "legacy/external"}`);
    console.log(`  Node: ${running.state.nodePath}`);
    if (uptime) console.log(`  Uptime: ${uptime}`);
    console.log(`  Log: ${logFile}`);
    console.log(`  Config: ${path.join(niubotHome, "config.yaml")}`);
    console.log(`  API: ${running.state.endpoint}`);
    await printBotStatuses(niubotHome, "running");
    return;
  }

  const recordedState = readProcessState(niubotHome);
  if (recordedState) {
    const state = recordedState.processes.engine;
    if (isProcessAlive(state.pid)) {
      console.log(`Engine: process exists (PID ${state.pid}), but identity cannot be verified.`);
      console.log(`  State: ${path.join(niubotHome, "run", "process-state.json")}`);
      console.log(`  Log: ${state.logFile ?? getTodayLogFilePath(niubotHome)}`);
      await printBotStatuses(niubotHome, "uncertain");
      return;
    }
    clearProcessState(niubotHome, state.instanceId);
    try { fs.unlinkSync(path.join(niubotHome, "niubot.pid")); } catch { /* already absent */ }
    console.log("Engine: stopped (stale process state removed).");
    await printBotStatuses(niubotHome, "stopped");
    return;
  }

  const pidFile = path.join(niubotHome, "niubot.pid");
  if (!fs.existsSync(pidFile)) {
    console.log("Engine: stopped");
    await printBotStatuses(niubotHome, "stopped");
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  if (!isProcessRunning(pid)) {
    console.log("Engine: stopped (stale PID file removed).");
    fs.unlinkSync(pidFile);
    await printBotStatuses(niubotHome, "stopped");
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

  console.log(`Engine: running (PID ${pid})`);
  console.log(`  Version: ${details.version}`);
  console.log(`  Path: ${details.path}`);
  if (details.node) console.log(`  Node: ${details.node}`);
  console.log(`  Log: ${details.logFile}`);
  console.log(`  Config: ${configPath}`);
  await printBotStatuses(niubotHome, "running");
}

async function cmdStatus(niubotHome: string, flags: CliFlags, hasExplicitHome: boolean): Promise<void> {
  const listAll = flags.all || !hasExplicitHome;
  if (!listAll) {
    await printStatusForHome(niubotHome);
    return;
  }

  const homes = collectStatusHomes(niubotHome, readRegisteredHomes(getHomeRegistryPath()));
  console.log("NiuBot instances:");
  for (const home of homes) {
    console.log();
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

function fetchLatestVersion(): string {
  const npmCommand = resolveNpmCommandForCurrentNode();
  const latest = runCommandSync(npmCommand, ["view", `${PKG_NAME}@latest`, "version"], {
    timeoutMs: 8_000,
    cwd: safeCurrentWorkingDirectory(),
    env: npmEnvironmentForCurrentNode(),
  }).stdout.trim();
  if (!latest || !isProductionVersion(latest)) {
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

async function cmdUpdate(niubotHome: string, flags: CliFlags): Promise<void> {
  const singleHome = flags.home !== undefined;
  if (!singleHome && flags.detach) {
    fail("--detach requires --home for a single Home update.");
    hint("Run 'niubot update' without --detach to update all registered production Homes.");
    process.exitCode = 1;
    return;
  }
  if (singleHome && flags.detach) {
    const running = await inspectRunningEngine(niubotHome);
    if (!running) {
      fail("--detach requires a running Engine.");
      hint("Run 'niubot update' without --detach while the Engine is stopped.");
      process.exitCode = 1;
      return;
    }
  }

  const launcherCandidate = process.env["NIUBOT_LAUNCH_CANDIDATE_ARTIFACT_ID"];
  let targetVersion: string;
  if (launcherCandidate) {
    try {
      const manifest = new SharedReleaseStore(resolveSharedRuntimeRoot())
        .assertUsableArtifact(launcherCandidate, undefined, true);
      if (!isProductionVersion(manifest.version) || manifest.sourceKind === "source") {
        throw new Error(`candidate ${manifest.version} is not a packaged production release`);
      }
      targetVersion = manifest.version;
    } catch (err) {
      fail(`Installed update candidate is unavailable: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
  } else {
    info("Checking npm registry...");
    try {
      targetVersion = fetchLatestVersion();
    } catch (err) {
      fail(`Update check failed: ${err instanceof Error ? err.message : String(err)}`);
      console.log();
      process.exitCode = 1;
      return;
    }
  }

  const homes = singleHome
    ? [niubotHome]
    : collectStatusHomes(niubotHome, readRegisteredHomes(getHomeRegistryPath()));
  if (!singleHome) {
    console.log();
    console.log(`Updating registered production Homes to ${targetVersion}:`);
  }
  await runSequentialHomeUpdates(homes, async (home) => {
    if (!singleHome) {
      console.log();
      console.log(`Home: ${home}`);
    }
    await updateHomeToTarget(home, flags, {
      version: targetVersion,
      launcherCandidate,
      batch: !singleHome,
    });
  }, (home, err) => {
    fail(`${home}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}

export async function runSequentialHomeUpdates(
  homes: string[],
  updateHome: (home: string) => Promise<void>,
  onError: (home: string, error: unknown) => void,
): Promise<void> {
  for (const home of homes) {
    try {
      await updateHome(home);
    } catch (err) {
      onError(home, err);
    }
  }
}

export type ProductionUpdateDecision = "update" | "up-to-date" | "dev" | "unsupported";

export function decideProductionUpdate(
  currentVersion: string | undefined,
  targetVersion: string,
  currentEnvironment?: "dev" | "production",
): ProductionUpdateDecision {
  if (currentEnvironment === "dev" || (currentVersion && runtimeEnvironmentForVersion(currentVersion) === "dev")) return "dev";
  if (currentVersion && !isProductionVersion(currentVersion)) return "unsupported";
  if (currentVersion && !isNewerPackageVersion(targetVersion, currentVersion)) return "up-to-date";
  return "update";
}

function readStoppedHomeRuntime(niubotHome: string): {
  version?: string;
  environment?: "dev" | "production";
} {
  const sharedStore = new SharedReleaseStore(resolveSharedRuntimeRoot());
  const homeStore = new HomeReleaseStore(niubotHome, sharedStore);
  const state = homeStore.stateExistsRecovering()
    ? homeStore.readStateStrict()
    : homeStore.readState();
  const current = state.current;
  if (!current) return {};
  if (current.storage === "shared") {
    const manifest = sharedStore.assertUsableArtifact(current.artifactId, undefined, true);
    return {
      version: manifest.version,
      environment: manifest.sourceKind === "source"
        ? "dev"
        : runtimeEnvironmentForVersion(manifest.version),
    };
  }
  const version = readNiuBotPackage(homeStore.resolveRuntime(current))?.version;
  if (!version) throw new Error("Current Home runtime version is unavailable");
  return { version, environment: runtimeEnvironmentForVersion(version) };
}

function matchingRecommendation(version: string): ReturnType<RecommendedReleaseStore["read"]> {
  try {
    const sharedStore = new SharedReleaseStore(resolveSharedRuntimeRoot());
    const recommendation = new RecommendedReleaseStore(sharedStore).readStrict();
    const manifest = sharedStore.assertUsableArtifact(recommendation.release.artifactId, undefined, true);
    return manifest.version === version ? recommendation : undefined;
  } catch {
    return undefined;
  }
}

async function updateHomeToTarget(
  niubotHome: string,
  flags: CliFlags,
  target: { version: string; launcherCandidate?: string; batch: boolean },
): Promise<void> {
  const configPath = path.join(niubotHome, "config.yaml");
  if (!isRegularFile(configPath)) {
    if (target.batch) {
      info("Skipped: Home is not initialized or its config is missing.");
      return;
    }
    fail(`Config not found: ${configPath}`);
    process.exitCode = 1;
    return;
  }

  const running = await inspectRunningEngine(niubotHome);
  const recordedState = readProcessState(niubotHome);
  if (!running && recordedState && isProcessAlive(recordedState.processes.engine.pid)) {
    fail(`Process ${recordedState.processes.engine.pid} exists, but Engine identity cannot be verified.`);
    hint("Refusing to modify the installation while a possibly running Engine is unverified.");
    process.exitCode = 1;
    return;
  }
  if (!running && flags.detach) {
    fail("--detach requires a running Engine.");
    hint("Run 'niubot update' without --detach while the Engine is stopped.");
    process.exitCode = 1;
    return;
  }

  const stoppedRuntime = running ? undefined : readStoppedHomeRuntime(niubotHome);
  const current = running?.identity.version ?? stoppedRuntime?.version;
  const currentEnvironment = running?.state.runtimeMode === "dev"
    ? "dev"
    : stoppedRuntime?.environment;
  const decision = decideProductionUpdate(current, target.version, currentEnvironment);
  if (decision === "dev") {
    if (target.batch) {
      info(`Skipped: DEV Home is isolated at ${current}.`);
      return;
    }
    fail(`DEV 版本 ${current} 不支持正式版更新。`);
    hint("请在源码目录完成构建，然后执行 restart 使用最新 DEV 产物。");
    process.exitCode = 1;
    return;
  }
  if (decision === "unsupported") {
    fail(`Unsupported current Home version: ${current ?? "unknown"}.`);
    process.exitCode = 1;
    return;
  }
  if (decision === "up-to-date") {
    ok(`Already up to date (${current}).`);
    return;
  }

  const config = loadConfig(configPath);
  if (target.launcherCandidate) {
    await activateLauncherCandidateIfNeeded(niubotHome, config, { stopAfterCompletion: !running });
    return;
  }

  if (matchingRecommendation(target.version)) {
    const handled = await activateRecommendedReleaseIfNeeded(niubotHome, config, {
      stopAfterCompletion: !running,
      expectedVersion: target.version,
    });
    if (handled) return;
  }

  {
    const worker = launchRestartWorker({
      niubotHome,
      botName: config.bots[0]?.id ?? "NiuBot",
      runtimeRoot: PROJECT_ROOT,
      sourceDirectory: running?.identity.runtimePath ?? PROJECT_ROOT,
      environment: running?.state.runtimeMode ?? process.env["NIUBOT_ENV"] ?? "production",
      updateVersion: target.version,
      stopAfterCompletion: !running,
    });
    info(`Update started (worker PID ${worker.pid})`);
    info(`Log: ${worker.logFile}`);
    if (flags.detach) {
      console.log();
      return;
    }

    info("Waiting for completion. Press Ctrl-C to stop waiting; the update will continue.");
    try {
      const result = await waitForRestartCompletion({
        stateFile: worker.stateFile,
        restartId: worker.restartId,
        workerPid: worker.pid,
        onPhase: (state) => {
          if (!restartCompletion(state)) info(restartPhaseLabel(state.phase, target.version));
        },
      });
      if (result.completion === "success") {
        ok(`Updated to ${target.version}.`);
      } else if (result.completion === "rolled-back") {
        fail("Update failed; the previous version was restored.");
        if (result.state.error) hint(result.state.error);
        process.exitCode = 1;
      } else {
        fail(`Update failed${result.state.error ? `: ${result.state.error}` : "."}`);
        process.exitCode = 1;
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      hint(`Check ${worker.logFile}`);
      process.exitCode = 1;
    }
    console.log();
    return;
  }
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

function cmdCleanup(niubotHome: string, flags: CliFlags): void {
  const sharedStore = new SharedReleaseStore(resolveSharedRuntimeRoot());
  const homeStore = new HomeReleaseStore(niubotHome, sharedStore);
  const runtimePath = readProcessState(niubotHome)?.processes.engine.runtimePath;
  const knownHomes = collectStatusHomes(niubotHome, readRegisteredHomes(getHomeRegistryPath()));
  const shared = cleanupSharedReleases(sharedStore, { apply: flags.apply, knownHomes });
  const legacy = cleanupLegacyReleases(niubotHome, homeStore.readState(), {
    apply: flags.apply,
    runningRuntimePath: runtimePath,
  });
  const candidates = [...shared, ...legacy];
  if (candidates.length === 0) {
    ok("No releases are eligible for cleanup.");
    return;
  }
  console.log(flags.apply ? "Moved/deleted eligible releases:" : "Cleanup dry run (no files changed):");
  for (const candidate of candidates) console.log(`  ${candidate.kind}: ${candidate.sourcePath}`);
  if (!flags.apply) hint("Run 'niubot cleanup --apply' to apply this exact policy after reviewing the list.");
}

// ── Usage ──────────────────────────────────────────────────

function getUsageText(): string {
  return `NiuBot v${getPkgVersion()}

Usage: niubot <command> [options]

Service:
  start          Start an Engine
  restart        Safely rebuild or restart an Engine
  stop           Stop an Engine
  status         Show Engine and Bot health details

Bots:
  bot list       List Bot IDs
  bot add        Add a Bot to an existing home
  bot export     Back up one Bot to a .nbot file
  bot import     Restore one Bot from a .nbot file
  bot move       Move one Bot between homes

Setup and maintenance:
  init           Check the environment and create config templates
  update         Check for and install a production update
  cleanup        Show safely removable releases (dry-run by default)
  version        Show the installed version

Help:
  -h, --help     Show help without running the command

Home selection:
  --home <path>  Use one NIUBOT_HOME where the command usage lists this option

Run \`niubot <command> --help\` or \`niubot bot --help\` for command details.

Agent install guide: run \`${INSTALL_GUIDE_COMMAND}\` and follow it.`;
}

function getCommandUsageText(command: string | undefined): string {
  switch (command) {
    case "init":
      return `Usage: niubot init [--check] [--force] [--home <path>]

Check the environment and create NiuBot configuration files.
  --check  Run checks only; do not create files
  --force  Overwrite existing generated config files`;
    case "start":
      return `Usage: niubot start [--restart] [--home <path>]

Start one Engine. Use --restart to replace an existing process.`;
    case "restart":
      return `Usage: niubot restart [--home <path>]

Safely restart one Engine with health checks and automatic rollback.`;
    case "stop":
      return `Usage: niubot stop [--home <path>]

Stop one Engine.`;
    case "status":
      return `Usage: niubot status [--home <path>] [--all]

Show detailed Engine and Bot health.
Without --home, all registered homes are shown.
For a short list of Bot IDs, use \`niubot bot list\`.`;
    case "update":
      return `Usage: niubot update [--home <path>] [--detach]

Without --home, update every registered production Home sequentially; DEV Homes are skipped.
Use --home to update one Home.
  --detach  Start one Home worker and return immediately (requires --home and a running Engine)`;
    case "cleanup":
      return `Usage: niubot cleanup [--home <path>] [--apply]

Show safely removable releases. Nothing is removed without --apply.`;
    case "add-bot":
      return `Usage: niubot add-bot [--home <path>]

Legacy alias for \`niubot bot add\`.`;
    case "version":
    case "--version":
    case "-v":
      return `Usage: niubot version [--verbose]

Show the installed NiuBot version and optional runtime details.`;
    case "install-guide":
      return `Usage: niubot install-guide

Print the packaged installation guide.`;
    case "bot":
      return getBotUsageText();
    default:
      return getUsageText();
  }
}

function getBotUsageText(subcommand?: string): string {
  switch (subcommand) {
    case "list":
      return `Usage: niubot bot list [--home <path>] [--all]

List Bot IDs. Without --home, Bots from all registered homes are shown.`;
    case "add":
      return `Usage: niubot bot add [--home <path>]

Interactively add a Bot to an existing home.`;
    case "export":
      return `Usage: niubot bot export <bot-id> [--output <file>] [--home <path>] [--include-secrets]

Create an online backup without stopping the Engine.
The default output is <bot-id>.nbot in the current directory.
Credentials are omitted unless --include-secrets is specified.`;
    case "import":
      return `Usage: niubot bot import <file> [--home <path>] [--app-id <id> --app-secret-file <path>] [--working-directory <path>]

Restore a Bot. The target Engine is stopped and restarted automatically.`;
    case "move":
      return `Usage: niubot bot move <bot-id> --from-home <path> --to-home <path> [--apply]

Validate a same-device move. Nothing changes without --apply.
With --apply, affected Engines are stopped and restored automatically.`;
    default:
      return `Usage: niubot bot <command> [options]

Commands:
  list    List Bot IDs
  add     Add a Bot to an existing home
  export  Back up one Bot to a .nbot file
  import  Restore one Bot from a .nbot file
  move    Move one Bot between homes

Run \`niubot bot <command> --help\` for details.`;
  }
}

const TOP_LEVEL_COMMAND_FLAGS: Record<string, ReadonlySet<keyof CliFlags>> = {
  init: new Set(["check", "force", "help", "home"]),
  "add-bot": new Set(["help", "home"]),
  start: new Set(["help", "home", "restart"]),
  restart: new Set(["help", "home"]),
  stop: new Set(["help", "home"]),
  status: new Set(["all", "help", "home"]),
  update: new Set(["detach", "help", "home"]),
  cleanup: new Set(["apply", "help", "home"]),
  bot: new Set(["help", "home"]),
  version: new Set(["help", "verbose"]),
  "--version": new Set(["help", "verbose"]),
  "-v": new Set(["help", "verbose"]),
  "install-guide": new Set(["help"]),
  help: new Set(),
};

const TOP_LEVEL_COMMANDS = new Set(Object.keys(TOP_LEVEL_COMMAND_FLAGS));

const BOT_COMMAND_FLAGS: Record<string, readonly string[]> = {
  list: ["home", "all", "help", "h"],
  add: ["home", "help", "h"],
  export: ["home", "output", "include-secrets", "help", "h"],
  import: ["home", "app-id", "app-secret-file", "working-directory", "help", "h"],
  move: ["from-home", "to-home", "apply", "help", "h"],
};

const BOT_COMMANDS = new Set(Object.keys(BOT_COMMAND_FLAGS));

function assertKnownHelpTopic(command: string, subcommand?: string): void {
  if (!TOP_LEVEL_COMMANDS.has(command)) {
    throw new Error(`Unknown command: ${command}\n\n${getUsageText()}`);
  }
  if (command === "bot" && subcommand && !BOT_COMMANDS.has(subcommand)) {
    throw new Error(`Unknown Bot command: ${subcommand}\n\n${getBotUsageText()}`);
  }
}

function printUsage(command?: string): void {
  console.log(getCommandUsageText(command));
}

function assertTopLevelCommandFlags(command: string | undefined, flags: CliFlags): void {
  const unknown = flags.unknown?.[0];
  const context = command ? `for '${command}'` : "without a command";
  if (unknown) throw new Error(`Unknown option ${context}: ${unknown}`);
  const allowed = command ? TOP_LEVEL_COMMAND_FLAGS[command] : new Set<keyof CliFlags>(["help"]);
  if (!allowed) return;
  for (const [name, value] of Object.entries(flags) as Array<[keyof CliFlags, CliFlags[keyof CliFlags]]>) {
    if (name === "unknown" || value === undefined || value === false || allowed.has(name)) continue;
    throw new Error(`Option --${name} is not valid ${context}\n\n${getCommandUsageText(command)}`);
  }
}

function assertBotCommandAdmin(): void {
  if (process.env["NIUBOT_AGENT_SESSION"] === "1" && process.env["NIUBOT_IS_ADMIN"] !== "true") {
    throw new Error("Bot commands require an admin session");
  }
}

function assertBotInvocationFlags(
  subcommand: string,
  flags: Record<string, string>,
  globalHome: string | undefined,
): void {
  assertBotCommandFlags(flags, BOT_COMMAND_FLAGS[subcommand] ?? []);
  if (subcommand === "move" && globalHome !== undefined) {
    throw new Error("Option --home is not valid for 'bot move'; use --from-home and --to-home");
  }
}

async function cmdBot(
  rawArgs: string[],
  envHome: string | undefined,
  globalHome: string | undefined,
): Promise<void> {
  const parsed = parseArgs(rawArgs);
  const [subcommand, ...positional] = parsed.positional;
  if (subcommand === "help") {
    const topic = positional[0];
    if (positional.length > 1) {
      throw new Error(`Unexpected help topic: ${positional[1]}\n\n${getBotUsageText(topic)}`);
    }
    if (topic && !BOT_COMMANDS.has(topic)) {
      throw new Error(`Unknown Bot command: ${topic}\n\n${getBotUsageText()}`);
    }
    if (topic) assertBotInvocationFlags(topic, parsed.flags, globalHome);
    else assertBotCommandFlags(parsed.flags, ["help", "h"]);
    console.log(getBotUsageText(topic));
    return;
  }
  if (!subcommand) {
    assertBotCommandFlags(parsed.flags, ["help", "h"]);
    console.log(getBotUsageText());
    return;
  }
  if (!BOT_COMMANDS.has(subcommand)) {
    throw new Error(`Unknown Bot command: ${subcommand}\n\n${getBotUsageText()}`);
  }
  assertBotInvocationFlags(subcommand, parsed.flags, globalHome);
  if (parsed.flags["help"] === "true" || parsed.flags["h"] === "true") {
    console.log(getBotUsageText(subcommand));
    return;
  }
  assertBotCommandAdmin();
  switch (subcommand) {
    case "add": {
      if (positional.length !== 0) throw new Error(getBotUsageText("add"));
      const home = resolveNiubotHome(parsed.flags["home"] ?? globalHome, envHome);
      await cmdAddBot(home);
      break;
    }
    case "list": {
      if (positional.length !== 0) throw new Error(getBotUsageText("list"));
      const requestedHome = parsed.flags["home"] ?? globalHome;
      const hasExplicitHome = requestedHome !== undefined || envHome !== undefined;
      const home = resolveNiubotHome(requestedHome, envHome);
      const listAll = booleanBotFlag(parsed.flags, "all") || !hasExplicitHome;
      const homes = listAll
        ? collectStatusHomes(home, readRegisteredHomes(getHomeRegistryPath()))
        : [home];
      for (const [index, item] of homes.entries()) {
        if (index > 0) console.log();
        console.log(`Home: ${item}`);
        try {
          const bots = loadConfig(path.join(item, "config.yaml")).bots;
          console.log("Bot IDs:");
          if (bots.length === 0) console.log("  (none)");
          for (const bot of bots) console.log(`  ${bot.id}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!listAll) throw new Error(`Cannot list Bots in ${item}: ${message}`);
          console.log(`Bot IDs: unavailable (${message})`);
        }
      }
      break;
    }
    case "export": {
      if (positional.length !== 1) throw new Error(getBotUsageText("export"));
      const home = resolveNiubotHome(parsed.flags["home"] ?? globalHome, envHome);
      const output = parsed.flags["output"] ?? `${positional[0]!}.nbot`;
      await exportBotBundle({
        home,
        botId: positional[0]!,
        outputPath: output,
        includeSecrets: booleanBotFlag(parsed.flags, "include-secrets"),
        sourceVersion: getPkgVersion(),
      });
      ok(`Bot '${positional[0]}' exported to ${path.resolve(output)}`);
      if (!booleanBotFlag(parsed.flags, "include-secrets")) {
        hint("Credentials were omitted; import requires --app-id and --app-secret-file.");
      }
      break;
    }
    case "import": {
      if (positional.length !== 1) {
        throw new Error("Usage: niubot bot import <file> [--home <path>] [--app-id <id> --app-secret-file <path>] [--working-directory <path>]");
      }
      const home = resolveNiubotHome(parsed.flags["home"] ?? globalHome, envHome);
      const launch = launchBotTransferWorker({
        runtimeRoot: PROJECT_ROOT,
        request: {
          kind: "import",
          home,
          bundlePath: path.resolve(positional[0]!),
          appId: parsed.flags["app-id"],
          appSecret: parsed.flags["app-secret-file"] ? readSecretFile(parsed.flags["app-secret-file"]) : undefined,
          workingDirectory: parsed.flags["working-directory"],
          runtime: currentTransferRuntime(),
          notifyChatId: process.env["NIUBOT_CHAT_ID"],
          notifyBotId: process.env["NIUBOT_BOT_NAME"],
          notifyHome: process.env["NIUBOT_HOME"],
        },
      });
      ok(`Bot import worker started (PID ${launch.pid})`);
      info(`  State: ${launch.stateFile}`);
      hint("The target Engine will stop automatically, then restart after import and health checks.");
      break;
    }
    case "move": {
      if (positional.length !== 1 || !parsed.flags["from-home"] || !parsed.flags["to-home"]) {
        throw new Error("Usage: niubot bot move <bot-id> --from-home <path> --to-home <path> [--apply]");
      }
      const sourceHome = resolveHomePath(parsed.flags["from-home"]);
      const targetHome = resolveHomePath(parsed.flags["to-home"]);
      const apply = booleanBotFlag(parsed.flags, "apply");
      if (apply) {
        const launch = launchBotTransferWorker({
          runtimeRoot: PROJECT_ROOT,
          request: {
            kind: "move",
            botId: positional[0]!,
            sourceHome,
            targetHome,
            sourceVersion: getPkgVersion(),
            runtime: currentTransferRuntime(),
            notifyChatId: process.env["NIUBOT_CHAT_ID"],
            notifyBotId: process.env["NIUBOT_BOT_NAME"],
            notifyHome: process.env["NIUBOT_HOME"],
          },
        });
        ok(`Bot move worker started (PID ${launch.pid})`);
        info(`  State: ${launch.stateFile}`);
        hint("Affected Engines will stop automatically and return to the required running state after health checks.");
        break;
      }
      const result = await moveBot({
        botId: positional[0]!,
        sourceHome,
        targetHome,
        apply: false,
        sourceVersion: getPkgVersion(),
      });
      if (!result.applied) {
        info(`Dry-run: move Bot '${result.botId}'`);
        info(`  from ${result.sourceHome}`);
        info(`  to   ${result.targetHome}`);
        hint("The source is valid and the target has no conflict. Add --apply to execute with automatic Engine stop/start.");
      }
      break;
    }
    default:
      throw new Error(`Unknown Bot command: ${subcommand}\n\n${getBotUsageText()}`);
  }
}

function currentTransferRuntime() {
  const version = getPkgVersion();
  return {
    runtimePath: PROJECT_ROOT,
    nodePath: process.execPath,
    version,
    runtimeMode: runtimeEnvironmentForVersion(version),
    sourceDirectory: process.env["NIUBOT_SOURCE_DIR"] ?? PROJECT_ROOT,
    logLevel: process.env["NIUBOT_LOG_LEVEL"],
    debugAgentStdout: process.env["NIUBOT_DEBUG_AGENT_STDOUT"],
  };
}

function readSecretFile(filePath: string): string {
  const resolved = resolveHomePath(filePath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`app secret file is not a regular file: ${resolved}`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`app secret file must not be readable by group or others: ${resolved}`);
  }
  const value = fs.readFileSync(resolved, "utf-8").trim();
  if (!value) throw new Error(`app secret file is empty: ${resolved}`);
  return value;
}

function assertBotCommandFlags(flags: Record<string, string>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(flags).filter((flag) => !allowedSet.has(flag));
  if (unknown.length > 0) throw new Error(`Unknown option: --${unknown[0]}`);
}

function booleanBotFlag(flags: Record<string, string>, name: string): boolean {
  const value = flags[name];
  if (value === undefined) return false;
  if (value !== "true") throw new Error(`--${name} does not accept a value`);
  return true;
}

// ── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const { command, commandIndex, flags, extraPositionals } = parseCliArgs(rawArgs);
  const envHome = process.env["NIUBOT_HOME"];
  const hasExplicitHome = flags.home !== undefined || envHome !== undefined;
  const niubotHome = resolveNiubotHome(flags.home, envHome);

  assertTopLevelCommandFlags(command, flags);
  if (command && TOP_LEVEL_COMMANDS.has(command) && command !== "bot" && command !== "help" && extraPositionals.length > 0) {
    throw new Error(`Unexpected argument for '${command}': ${extraPositionals[0]}\n\n${getCommandUsageText(command)}`);
  }
  if (flags.help) {
    if (command) assertKnownHelpTopic(command);
    if (command === "bot") {
      const subcommand = rawArgs[commandIndex + 1];
      if (subcommand && !BOT_COMMANDS.has(subcommand)) {
        throw new Error(`Unknown Bot command: ${subcommand}\n\n${getBotUsageText()}`);
      }
      if (subcommand === "move" && flags.home !== undefined) {
        throw new Error("Option --home is not valid for 'bot move'; use --from-home and --to-home");
      }
      console.log(getBotUsageText(subcommand));
    } else {
      printUsage(command);
    }
    return;
  }

  switch (command) {
    case "init":
      await cmdInit(niubotHome, flags);
      break;
    case "add-bot":
      assertBotCommandAdmin();
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
      await cmdUpdate(niubotHome, flags);
      break;
    case "cleanup":
      cmdCleanup(niubotHome, flags);
      break;
    case "bot":
      await cmdBot(rawArgs.slice(commandIndex + 1), envHome, flags.home);
      break;
    case "help":
      {
        const topic = rawArgs[commandIndex + 1];
        const subtopic = rawArgs[commandIndex + 2];
        const extraTopic = rawArgs[commandIndex + 3];
        if (!topic) {
          printUsage();
          break;
        }
        assertKnownHelpTopic(topic, subtopic);
        if (extraTopic) {
          throw new Error(`Unexpected help topic: ${extraTopic}\n\n${topic === "bot" ? getBotUsageText(subtopic) : getCommandUsageText(topic)}`);
        }
        if (subtopic && topic !== "bot") {
          throw new Error(`Unexpected help topic: ${subtopic}\n\n${getCommandUsageText(topic)}`);
        }
        console.log(topic === "bot" ? getBotUsageText(subtopic) : getCommandUsageText(topic));
      }
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
      if (command) throw new Error(`Unknown command: ${command}\n\n${getUsageText()}`);
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
