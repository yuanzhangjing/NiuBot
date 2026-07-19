import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readEngineIdentity, requestEngineShutdown } from "./local-api/engine-client.js";
import type { EngineIdentity } from "./local-api/engine-server.js";
import { endpointFromAddress, resolveEngineEndpoint, type LocalIpcEndpoint } from "./platform/ipc.js";
import { samePlatformPath } from "./platform/files.js";
import {
  forceTerminateProcessTree,
  isProcessAlive,
  waitForProcessStartMarker,
  waitForProcessExit,
} from "./platform/process.js";
import {
  clearProcessState,
  readProcessState,
  writeProcessState,
  type EngineProcessState,
} from "./process-state.js";

export interface RunningEngine {
  state: EngineProcessState;
  identity: EngineIdentity;
}

export interface LaunchEngineOptions {
  niubotHome: string;
  engineEntry: string;
  runtimePath: string;
  logFile: string;
  version: string;
  runtimeMode?: string;
  env?: NodeJS.ProcessEnv;
}

export interface LaunchedEngine {
  state: EngineProcessState;
  endpoint: LocalIpcEndpoint;
}

export async function inspectRunningEngine(niubotHome: string): Promise<RunningEngine | undefined> {
  const processState = readProcessState(niubotHome);
  if (!processState) return undefined;
  const state = processState.processes.engine;
  const identity = await readEngineIdentity(endpointFromAddress(state.endpoint), 750);
  if (!identity) return undefined;
  if (identity.instanceId !== state.instanceId || identity.pid !== state.pid) return undefined;
  if (!samePlatformPath(identity.home, niubotHome) || !samePlatformPath(identity.runtimePath, state.runtimePath)) return undefined;
  return { state, identity };
}

export function launchDetachedEngine(options: LaunchEngineOptions): LaunchedEngine {
  const endpoint = resolveEngineEndpoint(options.niubotHome);
  const instanceId = randomUUID();
  const controlToken = randomBytes(32).toString("hex");
  const startedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
  const logFd = fs.openSync(options.logFile, "a");
  let child;
  try {
    child = spawn(process.execPath, [options.engineEntry], {
      cwd: options.runtimePath,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        ...options.env,
        NIUBOT_HOME: options.niubotHome,
        NIUBOT_INSTANCE_ID: instanceId,
        NIUBOT_CONTROL_TOKEN: controlToken,
        NIUBOT_STARTED_AT: startedAt,
      },
    });
  } finally {
    fs.closeSync(logFd);
  }
  child.once("error", (err) => {
    try { fs.appendFileSync(options.logFile, `[${new Date().toISOString()}] Engine spawn failed: ${err.message}\n`); } catch { /* ignore */ }
  });
  if (!child.pid) throw new Error("Engine process did not provide a PID");
  child.unref();
  const platformStartMarker = waitForProcessStartMarker(child.pid);
  if (!platformStartMarker) {
    // Use the ChildProcess handle here: no verified OS marker exists yet, so
    // a PID-based tree kill could target a reused PID if the child exited.
    try { child.kill(); } catch { /* already stopped */ }
    throw new Error(`Engine process ${child.pid} started, but its identity marker could not be read`);
  }

  const state: EngineProcessState = {
    pid: child.pid,
    instanceId,
    startedAt,
    platformStartMarker,
    endpoint: endpoint.address,
    endpointKind: endpoint.kind,
    controlToken,
    version: options.version,
    runtimeMode: options.runtimeMode,
    runtimePath: options.runtimePath,
    nodePath: process.execPath,
  };
  writeProcessState(options.niubotHome, state);
  // Legacy compatibility for releases that only understand niubot.pid.
  fs.writeFileSync(path.join(options.niubotHome, "niubot.pid"), String(child.pid));
  return { state, endpoint };
}

export async function stopEngine(niubotHome: string): Promise<{ stopped: boolean; pid?: number }> {
  const recordedState = readProcessState(niubotHome);
  const running = await inspectRunningEngine(niubotHome);
  if (running) {
    const endpoint = endpointFromAddress(running.state.endpoint);
    let accepted = false;
    try {
      accepted = await requestEngineShutdown(endpoint, running.state.controlToken, 2_000);
    } catch {
      // Use the verified PID fallback below.
    }

    if (accepted) {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const identity = await readEngineIdentity(endpoint, 500);
        if (!identity || identity.instanceId !== running.state.instanceId) break;
        await delay(250);
      }
    }

    const remaining = await readEngineIdentity(endpoint, 500);
    if (remaining?.instanceId === running.state.instanceId) {
      await forceStopVerifiedProcess(running.state);
    } else if (running.state.pid !== process.pid && isProcessAlive(running.state.pid)) {
      // The endpoint may disappear before the process actually exits. Do not
      // clear its state and leave an orphan behind; verify the OS creation
      // marker before using the precise process-tree fallback.
      const exited = accepted && await waitForProcessExit(running.state.pid, 2_000);
      if (!exited) await forceStopVerifiedProcess(running.state);
    }
    clearProcessState(niubotHome, running.state.instanceId);
    removeLegacyPidFile(niubotHome);
    return { stopped: true, pid: running.state.pid };
  }

  if (recordedState) {
    const state = recordedState.processes.engine;
    if (!isProcessAlive(state.pid)) {
      clearProcessState(niubotHome, state.instanceId);
      removeLegacyPidFile(niubotHome);
      return { stopped: false, pid: state.pid };
    }
    if (state.pid === process.pid) {
      throw new Error("Refusing to force-stop the current process without Engine IPC confirmation");
    }
    await forceStopVerifiedProcess(state);
    clearProcessState(niubotHome, state.instanceId);
    removeLegacyPidFile(niubotHome);
    return { stopped: true, pid: state.pid };
  }

  return stopLegacyEngine(niubotHome);
}

async function forceStopVerifiedProcess(state: EngineProcessState): Promise<void> {
  if (!isProcessAlive(state.pid)) return;
  const currentMarker = waitForProcessStartMarker(state.pid);
  if (!state.platformStartMarker || !currentMarker || currentMarker !== state.platformStartMarker) {
    throw new Error("Engine process state exists, but its identity could not be verified");
  }
  forceTerminateProcessTree(state.pid);
  if (!await waitForProcessExit(state.pid, 5_000)) {
    throw new Error(`Engine process ${state.pid} did not exit after forced termination`);
  }
}

function asyncLegacyStop(pid: number): Promise<void> {
  try { process.kill(pid, "SIGTERM"); } catch { return Promise.resolve(); }
  return waitForProcessExit(pid, 5_000).then((exited) => {
    if (!exited) {
      forceTerminateProcessTree(pid);
      return waitForProcessExit(pid, 5_000).then((forcedExit) => {
        if (!forcedExit) throw new Error(`Legacy Engine process ${pid} did not exit after forced termination`);
      });
    }
  });
}

async function stopLegacyEngine(niubotHome: string): Promise<{ stopped: boolean; pid?: number }> {
  const pidFile = path.join(niubotHome, "niubot.pid");
  const pid = readLegacyPid(pidFile);
  if (!pid || !isProcessAlive(pid)) {
    removeLegacyPidFile(niubotHome);
    return { stopped: false };
  }
  await asyncLegacyStop(pid);
  removeLegacyPidFile(niubotHome);
  return { stopped: true, pid };
}

function readLegacyPid(pidFile: string): number | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function removeLegacyPidFile(niubotHome: string): void {
  try { fs.unlinkSync(path.join(niubotHome, "niubot.pid")); } catch { /* ignore */ }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
