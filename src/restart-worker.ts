#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { x as extractTar } from "tar";
import yaml from "yaml";
import { loadConfig, resolveHomePath } from "./config.js";
import { localApiRequest, waitForLocalApiHealth } from "./local-api/client.js";
import { waitForEngineIdentity } from "./local-api/engine-client.js";
import { endpointFromAddress, resolveBotEndpoint } from "./platform/ipc.js";
import { runCommand } from "./platform/command.js";
import { resolveNpmExecutableForNode, withNodeRuntimeOnPath } from "./platform/executable.js";
import { inspectRunningEngine, launchDetachedEngine, stopEngine } from "./process-manager.js";
import { readProcessState } from "./process-state.js";
import { acquireProcessLock } from "./process-lock.js";
import { ReleaseStore, type ReleaseState } from "./release-store.js";
import { RestartStateWriter } from "./restart-state.js";
import { dateInTimeZone } from "./tz.js";
import { readPositiveSecondsAsMs, resolveEngineStartTimeoutMs } from "./lifecycle-timeouts.js";
import {
  cleanupRestartDatabaseSnapshot,
  createRestartDatabaseSnapshot,
  PREFLIGHT_DATABASE_MANIFEST_ENV,
  PREFLIGHT_FULL_VALIDATION_ENV,
  restoreRestartDatabaseSnapshot,
  type RestartDatabaseSnapshot,
} from "./database/restart-snapshot.js";

const PACKAGE_NAME = "@yuanzhangjing/niubot";
const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;
const UPDATE_INSTALL_TIMEOUT_MS = 600_000;
export const DEFAULT_PREFLIGHT_TIMEOUT_MS = 120_000;

type RestartMode = "source" | "npm-update" | "production";

interface RestartContext {
  id: string;
  startedAt: string;
  niubotHome: string;
  botName: string;
  botDirectory: string;
  sourceDirectory: string;
  workerRuntimePath: string;
  previousRuntimeMode: string;
  updateVersion?: string;
  notifyChatId?: string;
  legacyNotifyEndpoint?: string;
  logFile: string;
  debugLog: string;
  store: ReleaseStore;
  state: RestartStateWriter;
}

interface RuntimeTarget {
  runtimePath: string;
  version: string;
  runtimeMode: string;
}

export async function runRestartWorker(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env["NIUBOT_AGENT_SESSION"]) {
    throw new Error("restart worker cannot run inside an agent session");
  }
  const niubotHome = env["NIUBOT_HOME"] ? path.resolve(env["NIUBOT_HOME"]) : undefined;
  if (!niubotHome) throw new Error("NIUBOT_HOME is not set");

  const workerRuntimePath = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const botName = env["NIUBOT_BOT_NAME"] || "NiuBot";
  const startedAt = new Date().toISOString();
  const id = `${compactTimestamp(new Date())}-${process.pid}`;
  const botDirectory = path.join(niubotHome, botName);
  const sourceDirectory = resolveRestartSourceDirectory({
    niubotHome,
    workerRuntimePath,
    env,
  });
  const logDirectory = path.join(niubotHome, "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  const context: RestartContext = {
    id,
    startedAt,
    niubotHome,
    botName,
    botDirectory,
    sourceDirectory,
    workerRuntimePath,
    previousRuntimeMode: env["NIUBOT_RUNTIME_MODE"] || "",
    updateVersion: env["NIUBOT_UPDATE_VERSION"],
    notifyChatId: env["NIUBOT_RESTART_NOTIFY_CHAT_ID"] || env["NIUBOT_CHAT_ID"],
    legacyNotifyEndpoint: env["NIUBOT_API_SOCKET"],
    logFile: path.join(logDirectory, `niubot-${localDate()}.log`),
    debugLog: path.join(logDirectory, "restart-debug.log"),
    store: new ReleaseStore(botDirectory),
    state: new RestartStateWriter(botDirectory, id, startedAt),
  };
  const releaseLock = acquireProcessLock(
    path.join(context.niubotHome, "run", "restart.lock"),
    "Restart",
  );
  try {
    fs.writeFileSync(context.debugLog, "");
    log(context, `restart worker started pid=${process.pid} bot=${botName} source=${sourceDirectory}`);
    context.state.write("started", { oldPid: readProcessState(niubotHome)?.processes.engine.pid });
    await delay(2_000);

    context.store.ensureDirectories();
    context.store.migrateLegacyLinks();
    const mode = resolveRestartMode(context, env);
    try {
      if (mode === "source") {
        await runSourceRestart(context);
      } else if (mode === "npm-update") {
        await runNpmUpdate(context);
      } else {
        await runProductionRestart(context);
      }
    } catch (err) {
      const message = errorMessage(err);
      log(context, `restart failed: ${message}`);
      const phase = context.state.read()?.phase;
      if (phase !== "rollback_failed" && phase !== "rollback_unavailable") {
        context.state.write("failed", { error: message });
      }
      await notify(context, `${mode === "npm-update" ? "更新" : "重启"}失败：${message}`);
      throw err;
    }
  } finally {
    releaseLock();
  }
}

async function runSourceRestart(context: RestartContext): Promise<void> {
  await ensureBootstrapRelease(context);
  context.state.write("build_candidate");
  const npmCommand = resolveNpmCommandForCurrentNode();
  const npmEnv = npmEnvironmentForCurrentNode();
  await runLogged(context, npmCommand, ["run", "build"], context.sourceDirectory, 180_000, npmEnv);
  await runLogged(context, npmCommand, ["run", "pack:check"], context.sourceDirectory, 180_000, npmEnv);
  const pkg = readPackage(path.join(context.sourceDirectory, "package.json"));
  const sha = await readGitSha(context);
  const releaseId = `${compactTimestamp(new Date())}-${pkg.version}-${sha}`;
  const candidate = await packRelease(context, {
    releaseId,
    cwd: context.sourceDirectory,
    installTimeoutMs: installTimeout(context, false),
  });
  await switchToCandidate(context, candidate, "", "重启成功。");
}

async function runNpmUpdate(context: RestartContext): Promise<void> {
  const version = context.updateVersion;
  if (!version || !/^[0-9A-Za-z._-]+$/.test(version)) throw new Error(`invalid npm update version: ${version ?? ""}`);
  await ensureBootstrapRelease(context);
  context.state.write("build_npm_candidate");
  const releaseId = `${compactTimestamp(new Date())}-${version}-npm`;
  const candidate = await packRelease(context, {
    releaseId,
    cwd: context.sourceDirectory,
    packageSpec: `${PACKAGE_NAME}@${version}`,
    expectedVersion: version,
    installTimeoutMs: installTimeout(context, true),
  });
  await switchToCandidate(context, candidate, "npm-release", "更新并重启成功。");
}

async function runProductionRestart(context: RestartContext): Promise<void> {
  const runtimePath = context.sourceDirectory;
  context.state.write("production_preflight_snapshot");
  const preflightSnapshot = await createDatabaseSnapshot(context, "preflight");
  try {
    context.state.write("production_preflight");
    await runPreflight(context, runtimePath, preflightSnapshot.manifestPath);
  } catch (err) {
    cleanupSnapshot(context, preflightSnapshot);
    throw err;
  }
  cleanupSnapshot(context, preflightSnapshot);
  context.state.write("production_stop_service");
  const old = await inspectRunningEngine(context.niubotHome);
  const recoveryTarget = old ? runtimeTargetFromRunning(old) : undefined;
  await stopEngine(context.niubotHome);
  let snapshot: RestartDatabaseSnapshot;
  try {
    context.state.write("production_rollback_snapshot");
    snapshot = await createDatabaseSnapshot(context, "rollback");
  } catch (err) {
    if (recoveryTarget) {
      const reason = errorMessage(err);
      await resumeRuntimeAfterSnapshotFailure(context, recoveryTarget, reason);
      throw new Error(`${reason}; old runtime resumed`, { cause: err });
    }
    throw err;
  }
  try {
    context.state.write("production_start_service", { oldPid: old?.state.pid });
    sanitizeOneShotEnvironment();
    const launched = launchRuntime(context, {
      runtimePath,
      version: readPackage(path.join(runtimePath, "package.json")).version,
      runtimeMode: context.previousRuntimeMode,
    });
    context.state.write("production_health_check", { candidatePid: launched.state.pid });
    if (!await checkRuntimeHealth(context, launched)) throw new Error("health check failed");
    context.state.write("production_success");
  } catch (err) {
    const reason = `production restart failed: ${errorMessage(err)}`;
    if (!recoveryTarget) {
      await restoreDatabaseWithoutRuntime(context, snapshot, reason);
      throw new Error(`${reason}; database restored but previous runtime is unavailable`, { cause: err });
    }
    await recoverRuntime(context, recoveryTarget, snapshot, reason, "重启失败，已恢复原版本。");
    return;
  }
  cleanupSnapshot(context, snapshot);
  await notify(context, "重启成功。");
}

async function switchToCandidate(
  context: RestartContext,
  releaseId: string,
  runtimeMode: string,
  successMessage: string,
): Promise<void> {
  const packageDirectory = context.store.packageDirectory(releaseId);
  context.state.write("preflight_snapshot", { candidateRelease: releaseId });
  const preflightSnapshot = await createDatabaseSnapshot(context, "preflight");
  try {
    context.state.write("preflight_candidate", { candidateRelease: releaseId });
    await runPreflight(context, packageDirectory, preflightSnapshot.manifestPath);
  } catch (err) {
    cleanupSnapshot(context, preflightSnapshot);
    throw err;
  }
  cleanupSnapshot(context, preflightSnapshot);

  const old = await inspectRunningEngine(context.niubotHome);
  const previousReleaseState = context.store.readState();
  const previous = previousReleaseState.lastKnownGood;
  const rollbackTarget = resolveRollbackTarget(context, old, previous);
  context.state.write("stop_old_service", {
    oldPid: old?.state.pid,
    candidateRelease: releaseId,
    previousRelease: previous,
  });
  await stopEngine(context.niubotHome);
  let snapshot: RestartDatabaseSnapshot;
  try {
    context.state.write("rollback_snapshot", { candidateRelease: releaseId });
    snapshot = await createDatabaseSnapshot(context, "rollback");
  } catch (err) {
    if (rollbackTarget) {
      const reason = errorMessage(err);
      await resumeRuntimeAfterSnapshotFailure(context, rollbackTarget, reason);
      throw new Error(`${reason}; old runtime resumed`, { cause: err });
    }
    throw err;
  }
  try {
    context.store.activate(releaseId);
    sanitizeOneShotEnvironment();
    context.state.write("start_candidate");
    const launched = launchRuntime(context, {
      runtimePath: packageDirectory,
      version: readPackage(path.join(packageDirectory, "package.json")).version,
      runtimeMode,
    });
    context.state.write("health_check_candidate", { candidatePid: launched.state.pid });
    if (!await checkRuntimeHealth(context, launched)) throw new Error("candidate health check failed");

    context.store.markLastKnownGood(releaseId);
    context.state.write("success");
  } catch (err) {
    const reason = errorMessage(err);
    if (!rollbackTarget) {
      await restoreDatabaseWithoutRuntime(context, snapshot, reason);
      throw new Error(`${reason}; database restored but no recoverable previous runtime`, { cause: err });
    }
    await recoverRuntime(
      context,
      rollbackTarget,
      snapshot,
      reason,
      "新版本启动失败，已回滚到上一版本。",
      previousReleaseState,
    );
    return;
  }
  try {
    const active = readProcessState(context.niubotHome)?.processes.engine.runtimePath;
    context.store.cleanup({ protectedRuntimePaths: active ? [active] : [] });
  } catch (err) {
    log(context, `release cleanup failed: ${errorMessage(err)}`);
  }
  cleanupSnapshot(context, snapshot);
  await notify(context, successMessage);
}

function launchRuntime(context: RestartContext, target: RuntimeTarget) {
  return launchDetachedEngine({
    niubotHome: context.niubotHome,
    engineEntry: path.join(target.runtimePath, "dist", "index.js"),
    runtimePath: target.runtimePath,
    logFile: context.logFile,
    version: target.version,
    runtimeMode: target.runtimeMode,
    env: runtimeEnvironment(context, target.runtimeMode),
  });
}

function runtimeTargetFromRunning(running: NonNullable<Awaited<ReturnType<typeof inspectRunningEngine>>>): RuntimeTarget {
  return {
    runtimePath: running.state.runtimePath,
    version: running.identity.version,
    runtimeMode: running.state.runtimeMode ?? "",
  };
}

function resolveRollbackTarget(
  context: RestartContext,
  old: Awaited<ReturnType<typeof inspectRunningEngine>>,
  rollbackId?: string,
): RuntimeTarget | undefined {
  try {
    if (rollbackId) {
      const runtimePath = context.store.packageDirectory(rollbackId);
      return {
        runtimePath,
        version: readPackage(path.join(runtimePath, "package.json")).version,
        runtimeMode: old?.state.runtimeMode ?? context.previousRuntimeMode,
      };
    }
  } catch (err) {
    log(context, `last-known-good runtime is unusable: ${errorMessage(err)}`);
  }
  return old ? runtimeTargetFromRunning(old) : undefined;
}

async function recoverRuntime(
  context: RestartContext,
  target: RuntimeTarget,
  snapshot: RestartDatabaseSnapshot,
  reason: string,
  notification: string,
  restoreReleaseState?: ReleaseState,
): Promise<void> {
  try {
    context.state.write("rollback_stop_candidate", { error: reason });
    await stopEngine(context.niubotHome);
    context.state.write("rollback_restore_database", { error: reason });
    restoreRestartDatabaseSnapshot(snapshot);
    context.state.write("rollback_start_lkg", { error: reason });
    const rollback = launchRuntime(context, target);
    context.state.write("health_check_rollback", { candidatePid: rollback.state.pid, error: reason });
    if (!await checkRuntimeHealth(context, rollback)) throw new Error("rollback health check failed");
    if (restoreReleaseState) context.store.writeState(restoreReleaseState);
    context.state.write("rollback_success", { error: reason });
    cleanupSnapshot(context, snapshot);
    await notify(context, notification);
  } catch (recoveryError) {
    const message = `${reason}; recovery failed: ${errorMessage(recoveryError)}`;
    context.state.write("rollback_failed", { error: message });
    throw new Error(message, { cause: recoveryError });
  }
}

async function restoreDatabaseWithoutRuntime(
  context: RestartContext,
  snapshot: RestartDatabaseSnapshot,
  reason: string,
): Promise<void> {
  try {
    context.state.write("rollback_stop_candidate", { error: reason });
    await stopEngine(context.niubotHome);
    context.state.write("rollback_restore_database", { error: reason });
    restoreRestartDatabaseSnapshot(snapshot);
    context.state.write("rollback_unavailable", { error: reason });
    cleanupSnapshot(context, snapshot);
  } catch (restoreError) {
    const message = `${reason}; database recovery failed: ${errorMessage(restoreError)}`;
    context.state.write("rollback_failed", { error: message });
    throw new Error(message, { cause: restoreError });
  }
}

async function resumeRuntimeAfterSnapshotFailure(
  context: RestartContext,
  target: RuntimeTarget,
  reason: string,
): Promise<void> {
  try {
    context.state.write("snapshot_failed_restart_old", { error: reason });
    sanitizeOneShotEnvironment();
    const resumed = launchRuntime(context, target);
    context.state.write("health_check_snapshot_recovery", { candidatePid: resumed.state.pid, error: reason });
    if (!await checkRuntimeHealth(context, resumed)) throw new Error("old runtime health check failed");
  } catch (recoveryError) {
    const message = `${reason}; old runtime recovery failed: ${errorMessage(recoveryError)}`;
    context.state.write("rollback_failed", { error: message });
    throw new Error(message, { cause: recoveryError });
  }
}

async function ensureBootstrapRelease(context: RestartContext): Promise<void> {
  context.state.write("bootstrap_last_known_good");
  const state = context.store.readState();
  if (state.lastKnownGood) return;

  const running = await inspectRunningEngine(context.niubotHome);
  const existingId = running ? context.store.releaseIdForRuntimePath(running.state.runtimePath) : undefined;
  if (existingId) {
    const next: ReleaseState = { schemaVersion: 1, current: existingId, lastKnownGood: existingId };
    context.store.writeState(next);
    return;
  }

  const packageJson = path.join(context.sourceDirectory, "package.json");
  const dist = path.join(context.sourceDirectory, "dist");
  if (!fs.existsSync(packageJson) || !fs.existsSync(dist)) {
    log(context, "bootstrap skipped: current dist is unavailable");
    return;
  }
  const pkg = readPackage(packageJson);
  const releaseId = `bootstrap-${compactTimestamp(new Date())}-${pkg.version}`;
  await packRelease(context, {
    releaseId,
    cwd: context.sourceDirectory,
    installTimeoutMs: installTimeout(context, false),
  });
  context.store.writeState({ schemaVersion: 1, current: releaseId, lastKnownGood: releaseId });
}

interface PackReleaseOptions {
  releaseId: string;
  cwd: string;
  packageSpec?: string;
  expectedVersion?: string;
  installTimeoutMs: number;
}

async function packRelease(context: RestartContext, options: PackReleaseOptions): Promise<string> {
  await assertLocalProxyEnvironment();
  const releaseDirectory = context.store.releaseDirectory(options.releaseId);
  const packageDirectory = context.store.packageDirectory(options.releaseId);
  if (fs.existsSync(releaseDirectory)) throw new Error(`release already exists: ${options.releaseId}`);
  fs.mkdirSync(packageDirectory, { recursive: true });
  try {
    const npmCommand = resolveNpmCommandForCurrentNode();
    const npmEnv = npmEnvironmentForCurrentNode();
    const args = ["pack"];
    if (options.packageSpec) args.push(options.packageSpec);
    args.push("--json", "--pack-destination", context.store.packagesDirectory);
    const packed = await runLogged(
      context,
      npmCommand,
      args,
      options.cwd,
      readPositiveMs("NIUBOT_RESTART_PACK_TIMEOUT", 120_000),
      npmEnv,
    );
    const filename = parseNpmPackFilename(packed.stdout);
    const archive = path.join(context.store.packagesDirectory, filename);
    if (!fs.existsSync(archive)) throw new Error(`npm pack output not found: ${archive}`);
    await extractTar({ file: archive, cwd: packageDirectory, strip: 1 });

    const pkg = readPackage(path.join(packageDirectory, "package.json"));
    if (pkg.name !== PACKAGE_NAME || (options.expectedVersion && pkg.version !== options.expectedVersion)) {
      throw new Error(`candidate metadata mismatch: ${pkg.name}@${pkg.version}`);
    }
    await assertLocalProxyEnvironment();
    await runLogged(
      context,
      npmCommand,
      ["install", "--omit=dev", "--no-audit", "--no-fund"],
      packageDirectory,
      options.installTimeoutMs,
      npmEnv,
    );
    return options.releaseId;
  } catch (err) {
    try { fs.rmSync(releaseDirectory, { recursive: true, force: true }); } catch { /* next cleanup can retry */ }
    throw err;
  }
}

async function runPreflight(
  context: RestartContext,
  runtimePath: string,
  databaseManifestPath: string,
): Promise<void> {
  const timeoutMs = resolvePreflightTimeoutMs();
  const startedAt = Date.now();
  log(context, `preflight command started timeoutMs=${timeoutMs}`);
  try {
    await runLogged(
      context,
      process.execPath,
      [path.join(runtimePath, "dist", "index.js"), "--preflight"],
      runtimePath,
      timeoutMs,
      {
        ...runtimeEnvironment(context, context.previousRuntimeMode),
        [PREFLIGHT_DATABASE_MANIFEST_ENV]: databaseManifestPath,
        [PREFLIGHT_FULL_VALIDATION_ENV]: "1",
      },
    );
    log(context, `preflight command completed durationMs=${Date.now() - startedAt}`);
  } catch (err) {
    log(context, `preflight command failed durationMs=${Date.now() - startedAt} error=${errorMessage(err)}`);
    throw err;
  }
}

async function createDatabaseSnapshot(
  context: RestartContext,
  purpose: "preflight" | "rollback",
): Promise<RestartDatabaseSnapshot> {
  const startedAt = Date.now();
  const config = loadConfig(path.join(context.niubotHome, "config.yaml"));
  const rootDirectory = path.join(
    context.botDirectory,
    "restart",
    "database-snapshots",
    `${context.id}-${purpose}`,
  );
  const snapshot = await createRestartDatabaseSnapshot({
    rootDirectory,
    databasePaths: config.bots.map((bot) => bot.dbPath),
    backupTimeoutMs: readPositiveMs("NIUBOT_RESTART_DATABASE_BACKUP_TIMEOUT", 120_000),
  });
  log(context, `database snapshot ready purpose=${purpose} count=${snapshot.records.length} durationMs=${Date.now() - startedAt}`);
  return snapshot;
}

function cleanupSnapshot(context: RestartContext, snapshot: RestartDatabaseSnapshot): void {
  try {
    cleanupRestartDatabaseSnapshot(snapshot);
  } catch (err) {
    log(context, `database snapshot cleanup failed: ${errorMessage(err)}`);
  }
}

async function checkRuntimeHealth(
  context: RestartContext,
  launched: ReturnType<typeof launchDetachedEngine>,
): Promise<boolean> {
  const healthTimeout = resolveEngineStartTimeoutMs();
  log(context, `candidate health check started timeoutMs=${healthTimeout}`);
  const identity = await waitForEngineIdentity(launched.endpoint, {
    instanceId: launched.state.instanceId,
    pid: launched.state.pid,
    home: context.niubotHome,
    runtimePath: launched.state.runtimePath,
  }, healthTimeout, 250);
  if (!identity) return false;
  let config;
  try {
    config = loadConfig(path.join(context.niubotHome, "config.yaml"));
  } catch {
    return false;
  }
  const results = await Promise.all(config.bots.map((bot) => waitForLocalApiHealth(
    resolveBotEndpoint(context.niubotHome, bot.id, { unixSocketDirectory: path.dirname(bot.dbPath) }),
    healthTimeout,
    500,
  )));
  return results.every(Boolean);
}

async function notify(context: RestartContext, text: string): Promise<void> {
  if (!context.notifyChatId) return;
  try {
    const config = loadConfig(path.join(context.niubotHome, "config.yaml"));
    const bot = config.bots.find((candidate) => candidate.id === context.botName) ?? config.bots[0];
    if (!bot) return;
    // Old restart callers supplied the exact API socket but not a bot name.
    // Prefer that address when present so multi-bot upgrades notify through
    // the same Bot that accepted the command.
    const endpoint = context.legacyNotifyEndpoint
      ? endpointFromAddress(context.legacyNotifyEndpoint)
      : resolveBotEndpoint(context.niubotHome, bot.id, { unixSocketDirectory: path.dirname(bot.dbPath) });
    const response = await localApiRequest(endpoint, "/send", {
      method: "POST",
      body: { chat_id: context.notifyChatId, text },
      timeoutMs: 3_000,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`local notification API returned ${response.statusCode}`);
    }
  } catch (err) {
    log(context, `notify failed: ${errorMessage(err)}`);
  }
}

async function runLogged(
  context: RestartContext,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
) {
  log(context, `run: ${command} ${args.join(" ")} cwd=${cwd}`);
  return runCommand(command, args, {
    cwd,
    env,
    timeoutMs,
    onOutput: (_stream, text) => fs.appendFileSync(context.debugLog, text),
  });
}

export function parseNpmPackFilename(output: string): string {
  const trimmed = output.trim();
  try {
    const value = JSON.parse(trimmed) as Array<{ filename?: string }>;
    const filename = value.at(-1)?.filename;
    if (filename && path.basename(filename) === filename) return filename;
  } catch {
    // Some npm versions may print notices before the JSON result.
  }
  const match = trimmed.match(/\[\s*\{[\s\S]*\}\s*\]\s*$/);
  if (match) {
    const value = JSON.parse(match[0]) as Array<{ filename?: string }>;
    const filename = value.at(-1)?.filename;
    if (filename && path.basename(filename) === filename) return filename;
  }
  throw new Error("npm pack did not return a package filename");
}

export function resolvePreflightTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveMs("NIUBOT_RESTART_PREFLIGHT_TIMEOUT", DEFAULT_PREFLIGHT_TIMEOUT_MS, env);
}

export function resolveRestartSourceDirectory(options: {
  niubotHome: string;
  workerRuntimePath: string;
  env: NodeJS.ProcessEnv;
}): string {
  const mode = options.env["NIUBOT_RESTART_MODE"];
  const runtimeMode = options.env["NIUBOT_RUNTIME_MODE"];
  if (mode === "npm-update" || runtimeMode === "npm-release") {
    return path.resolve(options.env["NIUBOT_SOURCE_DIR"] || options.workerRuntimePath);
  }
  try {
    const configPath = path.join(options.niubotHome, "config.yaml");
    const raw = yaml.parse(fs.readFileSync(configPath, "utf-8")) as {
      restart?: { sourceDirectory?: unknown };
    } | undefined;
    const configured = raw?.restart?.sourceDirectory;
    if (typeof configured === "string" && configured.trim()) {
      const sourceDirectory = resolveHomePath(configured);
      if (fs.existsSync(sourceDirectory)) return sourceDirectory;
    }
  } catch {
    // Use the explicit source or current runtime below.
  }
  return path.resolve(options.env["NIUBOT_SOURCE_DIR"] || options.workerRuntimePath);
}

function resolveRestartMode(context: RestartContext, env: NodeJS.ProcessEnv): RestartMode {
  if (env["NIUBOT_RESTART_MODE"] === "npm-update") return "npm-update";
  if (fs.existsSync(path.join(context.sourceDirectory, "src"))) return "source";
  return "production";
}

function runtimeEnvironment(context: RestartContext, runtimeMode: string): NodeJS.ProcessEnv {
  return {
    NIUBOT_SOURCE_DIR: context.sourceDirectory,
    NIUBOT_RUNTIME_MODE: runtimeMode,
    NIUBOT_LOG_LEVEL: process.env["NIUBOT_LOG_LEVEL"] || "info",
  };
}

function sanitizeOneShotEnvironment(): void {
  for (const name of [
    "NIUBOT_RESTART_MODE",
    "NIUBOT_UPDATE_VERSION",
    "NIUBOT_RESTART_NOTIFY_CHAT_ID",
    "NIUBOT_CHAT_ID",
    "NIUBOT_API_SOCKET",
    PREFLIGHT_DATABASE_MANIFEST_ENV,
  ]) delete process.env[name];
}

async function readGitSha(context: RestartContext): Promise<string> {
  try {
    return (await runLogged(context, "git", ["rev-parse", "--short", "HEAD"], context.sourceDirectory, 10_000)).stdout.trim() || "nogit";
  } catch {
    return "nogit";
  }
}

function readPackage(file: string): { name: string; version: string } {
  const pkg = JSON.parse(fs.readFileSync(file, "utf-8")) as { name?: string; version?: string };
  if (!pkg.name || !pkg.version) throw new Error(`invalid package metadata: ${file}`);
  return { name: pkg.name, version: pkg.version };
}

function resolveNpmCommandForCurrentNode(): string {
  return resolveNpmExecutableForNode(process.execPath) ?? "npm";
}

function npmEnvironmentForCurrentNode(): NodeJS.ProcessEnv {
  return withNodeRuntimeOnPath(process.execPath);
}

function installTimeout(context: RestartContext, update: boolean): number {
  void context;
  return readPositiveMs(
    "NIUBOT_RESTART_INSTALL_TIMEOUT",
    update ? UPDATE_INSTALL_TIMEOUT_MS : DEFAULT_INSTALL_TIMEOUT_MS,
  );
}

function readPositiveMs(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return readPositiveSecondsAsMs(name, fallback, env);
}

async function assertLocalProxyEnvironment(): Promise<void> {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] as const) {
    const value = process.env[name] || process.env[name.toLowerCase()];
    if (!value) continue;
    let url: URL;
    try { url = new URL(value.includes("://") ? value : `http://${value}`); } catch { continue; }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host !== "localhost" && host !== "::1" && !host.startsWith("127.")) continue;
    const port = Number(url.port);
    if (!port || !await canConnect(host, port, readPositiveMs("NIUBOT_RESTART_PROXY_CHECK_TIMEOUT", 3_000))) {
      throw new Error(`${name} points to an unreachable local proxy at ${host}:${url.port}`);
    }
  }
}

function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function compactTimestamp(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}-${pad(date.getUTCMilliseconds(), 3)}Z`;
}

function localDate(): string {
  return dateInTimeZone();
}

function log(context: RestartContext, message: string): void {
  fs.appendFileSync(context.debugLog, `[${new Date().toISOString()}] ${message}\n`);
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 2_000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const entryPath = process.argv[1] ? fs.realpathSync(path.resolve(process.argv[1])) : undefined;
if (entryPath === fileURLToPath(import.meta.url)) {
  runRestartWorker().catch((err) => {
    process.stderr.write(`${errorMessage(err)}\n`);
    process.exitCode = 1;
  });
}
