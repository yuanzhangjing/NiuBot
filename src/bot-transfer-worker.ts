#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "yaml";
import { loadConfig } from "./config.js";
import {
  importBotBundle,
  moveBot,
  preflightImportBotBundle,
  recoverInterruptedImports,
  recoverInterruptedMove,
  rollbackCompletedMove,
  rollbackImportedBot,
  type ImportBotResult,
  type MoveBotResult,
} from "./bot-transfer.js";
import type { BotTransferWorkerRequest, TransferRuntimeTarget } from "./bot-transfer-launcher.js";
import { localApiRequest, waitForLocalApiHealth } from "./local-api/client.js";
import { waitForEngineIdentity } from "./local-api/engine-client.js";
import { resolveEngineStartTimeoutMs } from "./lifecycle-timeouts.js";
import { HomeReleaseStore } from "./home-release-store.js";
import { resolveBotEndpoint } from "./platform/ipc.js";
import { replaceFileSync, samePlatformPath } from "./platform/files.js";
import {
  isProcessAlive,
  processStartMarkersMatch,
  queryProcessEnvironmentValue,
  queryProcessStartMarker,
} from "./platform/process.js";
import { resolveSharedRuntimeRoot } from "./platform/shared-runtime.js";
import { acquireProcessLock } from "./process-lock.js";
import { inspectRunningEngine, launchDetachedEngine, stopEngine, type LaunchedEngine } from "./process-manager.js";
import { readProcessState, type EngineProcessState } from "./process-state.js";
import { SharedReleaseStore } from "./shared-release-store.js";

interface HomeBeforeState {
  home: string;
  wasRunning: boolean;
  runtime?: TransferRuntimeTarget;
}

export interface BotTransferWorkerDependencies {
  delay?: (milliseconds: number) => Promise<void>;
  inspect?: typeof inspectRunningEngine;
  stop?: typeof stopEngine;
  launch?: typeof launchDetachedEngine;
  health?: (home: string, launched: LaunchedEngine) => Promise<boolean>;
}

interface LifecycleMarker {
  schemaVersion: 1;
  id: string;
  pid?: number;
  processStartMarker?: string;
  status?: "launching" | "running";
  primaryHome: string;
  stateFile: string;
}

interface PersistedLifecycleState {
  schemaVersion: 1;
  id: string;
  kind: "import" | "move";
  phase: string;
  before?: HomeBeforeState[];
  result?: ImportBotResult | MoveBotResult;
  homes?: string[];
}

export async function recoverStaleBotTransferLifecycles(
  homePath: string,
  dependencies: BotTransferWorkerDependencies = {},
): Promise<number> {
  const home = path.resolve(homePath);
  const activeRoot = path.join(home, "run", "bot-transfer-active");
  if (!fs.existsSync(activeRoot)) return 0;
  let recovered = 0;
  for (const entry of fs.readdirSync(activeRoot, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f-]+\.json$/i.test(entry.name)) {
      throw new Error(`invalid Bot transfer lifecycle marker: ${path.join(activeRoot, entry.name)}`);
    }
    const markerFile = path.join(activeRoot, entry.name);
    const marker = readLifecycleMarker(markerFile);
    if (marker.pid && isProcessAlive(marker.pid)) {
      const current = queryProcessStartMarker(marker.pid);
      if (!marker.processStartMarker || processStartMarkersMatch(marker.processStartMarker, current)) {
        throw new Error(`Bot transfer worker is still active (PID ${marker.pid})`);
      }
    }
    if (marker.status === "launching" && Date.now() - fs.statSync(markerFile).mtimeMs < 30_000) {
      throw new Error("Bot transfer worker launch is still being handed over; retry shortly");
    }
    await recoverStaleLifecycle(marker, dependencies);
    recovered += 1;
  }
  return recovered;
}

async function recoverStaleLifecycle(
  marker: LifecycleMarker,
  dependencies: BotTransferWorkerDependencies,
): Promise<void> {
  const jobDirectory = path.dirname(path.resolve(marker.stateFile));
  const expectedStateFile = path.join(path.resolve(marker.primaryHome), "run", "bot-transfer-jobs", marker.id, "state.json");
  if (path.resolve(marker.stateFile) !== expectedStateFile
    || path.basename(jobDirectory) !== marker.id
    || path.basename(path.dirname(jobDirectory)) !== "bot-transfer-jobs") {
    throw new Error(`unsafe Bot transfer state path: ${marker.stateFile}`);
  }
  const requestFile = path.join(jobDirectory, "request.json");
  if (!fs.existsSync(marker.stateFile)) {
    const request = readRequest(requestFile);
    if (request.id !== marker.id) throw new Error(`Bot transfer request differs from lifecycle marker: ${requestFile}`);
    const scope = requestLifecycleScope(request);
    if (!samePlatformPath(scope.primaryHome, marker.primaryHome)) {
      throw new Error(`Bot transfer marker primary home differs from request: ${marker.primaryHome}`);
    }
    fs.rmSync(requestFile, { force: true });
    fs.rmSync(path.join(jobDirectory, "target-config.original"), { force: true });
    removeActiveMarkers(scope.homes, request.id);
    return;
  }
  const state = JSON.parse(fs.readFileSync(marker.stateFile, "utf-8")) as PersistedLifecycleState;
  if (state.schemaVersion !== 1 || state.id !== marker.id || (state.kind !== "import" && state.kind !== "move")) {
    throw new Error(`invalid Bot transfer lifecycle state: ${marker.stateFile}`);
  }
  if (["success", "failed-rolled-back", "crash-recovered"].includes(state.phase)) {
    if (!Array.isArray(state.homes) || state.homes.length === 0) {
      throw new Error(`Bot transfer lifecycle state has no homes: ${marker.stateFile}`);
    }
    fs.rmSync(requestFile, { force: true });
    fs.rmSync(path.join(jobDirectory, "target-config.original"), { force: true });
    removeActiveMarkers(state.homes, state.id);
    return;
  }
  const request = readRequest(requestFile);
  if (request.id !== state.id || request.kind !== state.kind) {
    throw new Error(`Bot transfer request differs from lifecycle state: ${requestFile}`);
  }
  const { homes, primaryHome: expectedPrimaryHome } = requestLifecycleScope(request);
  if (!samePlatformPath(expectedPrimaryHome, path.resolve(marker.primaryHome))) {
    throw new Error(`Bot transfer marker primary home differs from request: ${marker.primaryHome}`);
  }
  assertSameLifecycleHomes(state.homes, homes, "state homes");
  const before = validateBeforeState(state.before, homes, state.phase);
  const lifecycleReleases: Array<() => void> = [];
  const stop = dependencies.stop ?? stopEngine;
  const inspect = dependencies.inspect ?? inspectRunningEngine;
  const launch = dependencies.launch ?? launchDetachedEngine;
  const health = dependencies.health ?? checkHomeHealth;
  try {
    for (const item of [...new Set(homes)].sort((a, b) => a.localeCompare(b))) {
      lifecycleReleases.push(acquireProcessLock(path.join(item, "run", "engine-lifecycle.lock"), "Engine lifecycle recovery"));
    }
    if (!before) {
      writeState(marker.stateFile, request, "crash-recovered", { homes });
      fs.rmSync(requestFile, { force: true });
      fs.rmSync(path.join(jobDirectory, "target-config.original"), { force: true });
      removeActiveMarkers(homes, state.id);
      return;
    }
    for (const item of homes) await stop(item);
    if (request.kind === "import") {
      await recoverInterruptedImports(request.home);
      const originalConfigFile = path.join(jobDirectory, "target-config.original");
      if (fs.existsSync(originalConfigFile)) {
        await rollbackCrashedImport(request.home, fs.readFileSync(originalConfigFile));
      }
    } else {
      const moved = await recoverInterruptedMove(
        request.sourceHome,
        request.targetHome,
        request.id,
        request.botId,
      );
      if (moved) await rollbackCompletedMove(moved);
    }
    for (const item of before) {
      if (!item.wasRunning || !item.runtime) continue;
      if (await inspect(item.home)) continue;
      const restored = startHome(item.home, item.runtime, launch);
      if (!await health(item.home, restored)) throw new Error(`recovered Engine health check failed: ${item.home}`);
    }
    writeState(marker.stateFile, request, "crash-recovered", { before });
    fs.rmSync(requestFile, { force: true });
    fs.rmSync(path.join(jobDirectory, "target-config.original"), { force: true });
    removeActiveMarkers(homes, state.id);
  } finally {
    for (const release of lifecycleReleases.reverse()) release();
  }
}

function requestLifecycleScope(request: BotTransferWorkerRequest): { homes: string[]; primaryHome: string } {
  const homes = request.kind === "import"
    ? [path.resolve(request.home)]
    : [path.resolve(request.sourceHome), path.resolve(request.targetHome)];
  return { homes, primaryHome: request.kind === "import" ? homes[0]! : homes[1]! };
}

async function rollbackCrashedImport(homePath: string, originalConfig: Buffer): Promise<void> {
  const home = path.resolve(homePath);
  const original = yaml.parse(originalConfig.toString("utf-8")) as Record<string, unknown>;
  const current = yaml.parse(fs.readFileSync(path.join(home, "config.yaml"), "utf-8")) as Record<string, unknown>;
  const originalIds = botIdsFromRawConfig(original, "original import config");
  const currentIds = botIdsFromRawConfig(current, "current import config");
  const added = [...currentIds].filter((id) => !originalIds.has(id));
  if (added.length > 1) throw new Error(`cannot recover crashed import: multiple new Bots found (${added.join(", ")})`);
  if (added.length === 1) {
    await rollbackImportedBot({ home, botId: added[0]!, originalConfig });
  }
}

function botIdsFromRawConfig(config: Record<string, unknown>, label: string): Set<string> {
  const bots = config["bots"];
  if (!Array.isArray(bots)) throw new Error(`${label} has no bots array`);
  const ids = new Set<string>();
  for (const bot of bots) {
    if (!bot || typeof bot !== "object") throw new Error(`${label} has an invalid Bot entry`);
    const raw = bot as Record<string, unknown>;
    const id = raw["id"] ?? raw["name"];
    if (typeof id !== "string" || !id) throw new Error(`${label} has a Bot without an ID`);
    ids.add(id);
  }
  return ids;
}

function readLifecycleMarker(markerFile: string): LifecycleMarker {
  const value = JSON.parse(fs.readFileSync(markerFile, "utf-8")) as Partial<LifecycleMarker>;
  if (value.schemaVersion !== 1 || typeof value.id !== "string"
    || typeof value.primaryHome !== "string" || typeof value.stateFile !== "string"
    || (value.pid !== undefined && (!Number.isInteger(value.pid) || value.pid <= 0))
    || (value.processStartMarker !== undefined && typeof value.processStartMarker !== "string")
    || (value.status !== undefined && value.status !== "launching" && value.status !== "running")) {
    throw new Error(`invalid Bot transfer lifecycle marker: ${markerFile}`);
  }
  if (path.basename(markerFile) !== `${value.id}.json`) {
    throw new Error(`Bot transfer marker ID differs from filename: ${markerFile}`);
  }
  return value as LifecycleMarker;
}

function assertSameLifecycleHomes(actual: string[] | undefined, expected: string[], label: string): void {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    throw new Error(`Bot transfer ${label} differ from request`);
  }
  const unmatched = [...actual];
  for (const home of expected) {
    const index = unmatched.findIndex((candidate) => typeof candidate === "string" && samePlatformPath(candidate, home));
    if (index < 0) throw new Error(`Bot transfer ${label} differ from request`);
    unmatched.splice(index, 1);
  }
}

function validateBeforeState(
  before: HomeBeforeState[] | undefined,
  homes: string[],
  phase: string,
): HomeBeforeState[] | undefined {
  if (before === undefined) {
    if (phase === "started" || phase === "preflight") return undefined;
    throw new Error(`Bot transfer lifecycle phase '${phase}' has no before state`);
  }
  if (!Array.isArray(before)) throw new Error("Bot transfer lifecycle before state is invalid");
  assertSameLifecycleHomes(before.map((item) => item?.home), homes, "before homes");
  for (const item of before) {
    if (typeof item.wasRunning !== "boolean"
      || (item.wasRunning && (!item.runtime
        || typeof item.runtime.runtimePath !== "string"
        || typeof item.runtime.nodePath !== "string"
        || typeof item.runtime.version !== "string"))) {
      throw new Error(`Bot transfer lifecycle before state is invalid for ${item.home}`);
    }
  }
  return before;
}

export async function runBotTransferWorker(
  requestFile: string,
  dependencies: BotTransferWorkerDependencies = {},
): Promise<void> {
  const request = readRequest(requestFile);
  const primaryHome = request.kind === "import" ? path.resolve(request.home) : path.resolve(request.targetHome);
  const jobDirectory = path.dirname(path.resolve(requestFile));
  const stateFile = path.join(jobDirectory, "state.json");
  const originalConfigFile = path.join(jobDirectory, "target-config.original");
  const homes = request.kind === "import"
    ? [path.resolve(request.home)]
    : [path.resolve(request.sourceHome), path.resolve(request.targetHome)];
  const inspect = dependencies.inspect ?? inspectRunningEngine;
  const stop = dependencies.stop ?? stopEngine;
  const launch = dependencies.launch ?? launchDetachedEngine;
  const health = dependencies.health ?? checkHomeHealth;
  const wait = dependencies.delay ?? delay;
  let imported: ImportBotResult | undefined;
  let moved: MoveBotResult | undefined;
  let targetOriginalConfig: Buffer | undefined;
  const before = new Map<string, HomeBeforeState>();
  const launchedHomes = new Set<string>();
  const lifecycleReleases: Array<() => void> = [];
  let recoveryComplete = false;
  let durableState: Record<string, unknown> = { homes };
  const recordState = (phase: string, details: Record<string, unknown> = {}) => {
    durableState = { ...durableState, ...details };
    writeState(stateFile, request, phase, durableState);
  };

  adoptActiveMarkers(homes, request.id, primaryHome, stateFile);
  recordState("started");
  try {
    await wait(2_000);
    for (const home of [...new Set(homes)].sort((a, b) => a.localeCompare(b))) {
      lifecycleReleases.push(acquireProcessLock(
        path.join(home, "run", "engine-lifecycle.lock"),
        "Engine lifecycle",
      ));
    }
    recordState("preflight");
    if (request.kind === "import") {
      await preflightImportBotBundle({
        home: primaryHome,
        bundlePath: request.bundlePath,
        appId: request.appId,
        appSecret: request.appSecret,
        workingDirectory: request.workingDirectory,
      });
    } else {
      await moveBot({
        sourceHome: request.sourceHome,
        targetHome: request.targetHome,
        botId: request.botId,
        sourceVersion: request.sourceVersion,
        activeLifecycleId: request.id,
      });
    }
    for (const home of homes) before.set(home, await captureHomeState(home, request.runtime, inspect));
    recordState("stopping", { before: [...before.values()] });
    for (const home of [...new Set(homes)].sort((a, b) => a.localeCompare(b))) await stop(home);

    if (request.kind === "import") {
      targetOriginalConfig = fs.readFileSync(path.join(primaryHome, "config.yaml"));
      fs.writeFileSync(originalConfigFile, targetOriginalConfig, { mode: 0o600, flag: "wx" });
      recordState("transferring");
      imported = await importBotBundle({
        home: primaryHome,
        bundlePath: request.bundlePath,
        appId: request.appId,
        appSecret: request.appSecret,
        workingDirectory: request.workingDirectory,
      });
    } else {
      recordState("transferring");
      moved = await moveBot({
        sourceHome: request.sourceHome,
        targetHome: request.targetHome,
        botId: request.botId,
        apply: true,
        sourceVersion: request.sourceVersion,
        transactionId: request.id,
      });
    }

    recordState("starting", {
      result: imported ?? moved,
    });
    sanitizeOneShotEnvironment();
    const targetBefore = before.get(primaryHome)!;
    const targetLaunch = startHome(primaryHome, targetBefore.runtime ?? request.runtime, launch);
    launchedHomes.add(primaryHome);
    if (!await health(primaryHome, targetLaunch)) throw new Error(`target Engine health check failed: ${primaryHome}`);

    if (request.kind === "move") {
      const sourceHome = path.resolve(request.sourceHome);
      const sourceBefore = before.get(sourceHome)!;
      if (sourceBefore.wasRunning && sourceBefore.runtime && homeHasConfiguredBots(sourceHome)) {
        const sourceLaunch = startHome(sourceHome, sourceBefore.runtime, launch);
        launchedHomes.add(sourceHome);
        if (!await health(sourceHome, sourceLaunch)) throw new Error(`source Engine health check failed: ${sourceHome}`);
      }
    }

    recordState("success", {
      botId: imported?.botId ?? moved?.botId,
      recoveryDirectory: moved?.recoveryDirectory,
    });
    recoveryComplete = true;
    fs.rmSync(originalConfigFile, { force: true });
    fs.rmSync(requestFile, { force: true });
    removeActiveMarkers(homes, request.id);
    await notify(request, true, request.kind === "import"
      ? `Bot '${imported!.botId}' 导入完成，目标 Engine 已启动并通过健康检查。`
      : `Bot '${moved!.botId}' 迁移完成，相关 Engine 已按原状态恢复并通过健康检查。`);
  } catch (err) {
    const recoveryErrors: Error[] = [];
    recordState("rolling-back", { error: errorMessage(err) });
    for (const home of [...launchedHomes].reverse()) {
      try { await stop(home); } catch (stopError) { recoveryErrors.push(asError(stopError)); }
    }
    try {
      if (imported && targetOriginalConfig) {
        await rollbackImportedBot({ home: primaryHome, botId: imported.botId, originalConfig: targetOriginalConfig });
      } else if (moved) {
        await rollbackCompletedMove(moved);
      }
    } catch (rollbackError) {
      recoveryErrors.push(asError(rollbackError));
    }
    for (const item of [...before.values()].sort((a, b) => a.home.localeCompare(b.home))) {
      if (!item.wasRunning || !item.runtime) continue;
      try {
        if (await inspect(item.home)) continue;
        const restored = startHome(item.home, item.runtime, launch);
        if (!await health(item.home, restored)) throw new Error(`restored Engine health check failed: ${item.home}`);
      } catch (restoreError) {
        recoveryErrors.push(asError(restoreError));
      }
    }
    recoveryComplete = recoveryErrors.length === 0;
    recordState(recoveryComplete ? "failed-rolled-back" : "recovery-failed", {
      error: errorMessage(err),
      recoveryErrors: recoveryErrors.map((item) => item.message),
    });
    if (recoveryComplete) {
      fs.rmSync(originalConfigFile, { force: true });
      fs.rmSync(requestFile, { force: true });
      removeActiveMarkers(homes, request.id);
    }
    await notify(request, false, recoveryComplete
      ? `Bot ${request.kind === "import" ? "导入" : "迁移"}失败，数据和 Engine 运行状态已恢复：${errorMessage(err)}`
      : `Bot ${request.kind === "import" ? "导入" : "迁移"}失败且恢复不完整：${errorMessage(err)}；${recoveryErrors.map((item) => item.message).join("；")}`);
    throw err;
  } finally {
    for (const release of lifecycleReleases.reverse()) release();
  }
}

function homeHasConfiguredBots(home: string): boolean {
  const value = yaml.parse(fs.readFileSync(path.join(home, "config.yaml"), "utf-8")) as Record<string, unknown>;
  if (!Array.isArray(value?.["bots"])) throw new Error(`source config has no bots array: ${home}`);
  return value["bots"].length > 0;
}

async function captureHomeState(
  home: string,
  fallback: TransferRuntimeTarget,
  inspect: typeof inspectRunningEngine,
): Promise<HomeBeforeState> {
  const running = await inspect(home);
  if (running) return { home, wasRunning: true, runtime: runtimeFromState(running.state) };
  const state = readProcessState(home)?.processes.engine;
  if (state && isProcessAlive(state.pid)) return { home, wasRunning: true, runtime: runtimeFromState(state) };
  return { home, wasRunning: false, runtime: resolveStoppedHomeRuntime(home, fallback) };
}

function runtimeFromState(state: EngineProcessState): TransferRuntimeTarget {
  return {
    runtimePath: state.runtimePath,
    nodePath: state.nodePath,
    version: state.version,
    runtimeMode: state.runtimeMode,
    sourceDirectory: state.sourceDirectory ?? queryProcessEnvironmentValue(state.pid, "NIUBOT_SOURCE_DIR") ?? state.runtimePath,
    logLevel: state.logLevel ?? queryProcessEnvironmentValue(state.pid, "NIUBOT_LOG_LEVEL") ?? undefined,
    debugAgentStdout: state.debugAgentStdout ?? queryProcessEnvironmentValue(state.pid, "NIUBOT_DEBUG_AGENT_STDOUT") ?? undefined,
  };
}

function resolveStoppedHomeRuntime(home: string, fallback: TransferRuntimeTarget): TransferRuntimeTarget {
  try {
    const shared = new SharedReleaseStore(resolveSharedRuntimeRoot());
    const store = new HomeReleaseStore(home, shared);
    const state = store.readStateStrict();
    for (const ref of [state.current]) {
      if (!ref) continue;
      try {
        const runtimePath = store.resolveRuntime(ref, true);
        const pkg = JSON.parse(fs.readFileSync(path.join(runtimePath, "package.json"), "utf-8")) as { version?: string };
        if (!pkg.version) continue;
        return {
          runtimePath,
          nodePath: ref.node.nodePath,
          version: pkg.version,
          runtimeMode: "production",
          sourceDirectory: runtimePath,
          logLevel: fallback.logLevel,
          debugAgentStdout: fallback.debugAgentStdout,
        };
      } catch { /* try the next recorded release */ }
    }
  } catch { /* home predates release-state v2 */ }
  return fallback;
}

function startHome(
  home: string,
  runtime: TransferRuntimeTarget,
  launch: typeof launchDetachedEngine,
): LaunchedEngine {
  const engineEntry = path.join(runtime.runtimePath, "dist", "index.js");
  if (!fs.existsSync(engineEntry)) throw new Error(`Engine entry not found: ${engineEntry}`);
  const logDirectory = path.join(home, "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  return launch({
    niubotHome: home,
    engineEntry,
    runtimePath: runtime.runtimePath,
    nodePath: runtime.nodePath,
    version: runtime.version,
    runtimeMode: runtime.runtimeMode,
    logFile: path.join(logDirectory, `niubot-${new Date().toISOString().slice(0, 10)}.log`),
    env: {
      NIUBOT_SOURCE_DIR: runtime.sourceDirectory ?? runtime.runtimePath,
      NIUBOT_ENV: runtime.runtimeMode ?? "",
      NIUBOT_LOG_LEVEL: runtime.logLevel ?? process.env["NIUBOT_LOG_LEVEL"] ?? "info",
      NIUBOT_DEBUG_AGENT_STDOUT: runtime.debugAgentStdout ?? "",
    },
  });
}

async function checkHomeHealth(home: string, launched: LaunchedEngine): Promise<boolean> {
  const timeoutMs = resolveEngineStartTimeoutMs();
  const identity = await waitForEngineIdentity(launched.endpoint, {
    instanceId: launched.state.instanceId,
    pid: launched.state.pid,
    home,
    runtimePath: launched.state.runtimePath,
  }, timeoutMs, 250);
  if (!identity) return false;
  let config;
  try { config = loadConfig(path.join(home, "config.yaml")); } catch { return false; }
  const results = await Promise.all(config.bots.map((bot) => waitForLocalApiHealth(
    resolveBotEndpoint(home, bot.id, { unixSocketDirectory: path.dirname(bot.dbPath) }),
    timeoutMs,
    500,
  )));
  return results.every(Boolean);
}

async function notify(request: BotTransferWorkerRequest, success: boolean, text: string): Promise<void> {
  if (!request.notifyChatId || !request.notifyBotId) return;
  const homes = request.kind === "import"
    ? [request.notifyHome, request.home].filter((item): item is string => Boolean(item)).map((item) => path.resolve(item))
    : success
      ? [request.notifyHome, request.targetHome, request.sourceHome].filter((item): item is string => Boolean(item)).map((item) => path.resolve(item))
      : [request.notifyHome, request.sourceHome, request.targetHome].filter((item): item is string => Boolean(item)).map((item) => path.resolve(item));
  for (const home of homes) {
    try {
      const config = loadConfig(path.join(home, "config.yaml"));
      const bot = config.bots.find((candidate) => candidate.id === request.notifyBotId);
      if (!bot) continue;
      const response = await localApiRequest(
        resolveBotEndpoint(home, bot.id, { unixSocketDirectory: path.dirname(bot.dbPath) }),
        "/send",
        { method: "POST", body: { chat_id: request.notifyChatId, text }, timeoutMs: 3_000 },
      );
      if (response.statusCode >= 200 && response.statusCode < 300) return;
    } catch { /* notification is best effort */ }
  }
}

function readRequest(requestFile: string): BotTransferWorkerRequest {
  const value = JSON.parse(fs.readFileSync(path.resolve(requestFile), "utf-8")) as BotTransferWorkerRequest;
  if (value.schemaVersion !== 1 || !value.id || (value.kind !== "import" && value.kind !== "move")) {
    throw new Error("invalid Bot transfer worker request");
  }
  return value;
}

function adoptActiveMarkers(homes: string[], id: string, primaryHome: string, stateFile: string): void {
  const processStartMarker = queryProcessStartMarker(process.pid);
  if (!processStartMarker) throw new Error("Bot transfer worker has no verifiable process marker");
  for (const home of new Set(homes.map((item) => path.resolve(item)))) {
    const markerFile = path.join(home, "run", "bot-transfer-active", `${id}.json`);
    if (!fs.existsSync(markerFile)) continue;
    const existing = readLifecycleMarker(markerFile);
    if (existing.id !== id || !samePlatformPath(existing.primaryHome, primaryHome)
      || path.resolve(existing.stateFile) !== path.resolve(stateFile)) {
      throw new Error(`Bot transfer lifecycle marker differs from request: ${markerFile}`);
    }
    const temporary = `${markerFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({
      schemaVersion: 1,
      id,
      status: "running",
      pid: process.pid,
      processStartMarker,
      primaryHome,
      stateFile,
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try { replaceFileSync(temporary, markerFile); } finally { fs.rmSync(temporary, { force: true }); }
  }
}

function writeState(
  stateFile: string,
  request: BotTransferWorkerRequest,
  phase: string,
  details: Record<string, unknown> = {},
): void {
  const temporary = `${stateFile}.${process.pid}.tmp`;
  const contents = `${JSON.stringify({
    schemaVersion: 1,
    id: request.id,
    kind: request.kind,
    phase,
    updatedAt: new Date().toISOString(),
    ...details,
  }, null, 2)}\n`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, contents, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try { replaceFileSync(temporary, stateFile); } finally { fs.rmSync(temporary, { force: true }); }
}

function removeActiveMarkers(homes: string[], id: string): void {
  for (const home of new Set(homes.map((item) => path.resolve(item)))) {
    const root = path.join(home, "run", "bot-transfer-active");
    fs.rmSync(path.join(root, `${id}.json`), { force: true });
    try { if (fs.readdirSync(root).length === 0) fs.rmdirSync(root); } catch { /* best effort */ }
  }
}

function sanitizeOneShotEnvironment(): void {
  for (const name of [
    "NIUBOT_BOT_TRANSFER_REQUEST",
    "NIUBOT_AGENT_SESSION",
    "NIUBOT_CHAT_ID",
    "NIUBOT_USER_ID",
    "NIUBOT_API_SOCKET",
  ]) delete process.env[name];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

const invokedAsScript = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false;
if (invokedAsScript) {
  const requestFile = process.env["NIUBOT_BOT_TRANSFER_REQUEST"];
  if (!requestFile) {
    console.error("NIUBOT_BOT_TRANSFER_REQUEST is not set");
    process.exitCode = 1;
  } else {
    runBotTransferWorker(requestFile).catch((err) => {
      console.error(`[${new Date().toISOString()}] Bot transfer worker failed: ${errorMessage(err)}`);
      process.exitCode = 1;
    });
  }
}
