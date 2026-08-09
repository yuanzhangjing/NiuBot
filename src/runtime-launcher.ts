import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HomeReleaseStore, type HomeReleaseState } from "./home-release-store.js";
import { sameReleaseRef, type ReleaseRef } from "./release-ref.js";
import { currentNodeRuntimeRef, probeNodeRuntimeRef } from "./release-ref.js";
import { withNodeRuntimeOnPath } from "./platform/executable.js";
import { resolveSharedRuntimeRoot } from "./platform/shared-runtime.js";
import { SharedReleaseInstaller } from "./shared-release-installer.js";
import { SharedReleaseStore } from "./shared-release-store.js";
import { RecommendedReleaseStore, shouldAdoptRecommendedRelease } from "./recommended-release.js";
import { inspectRunningEngine, stopEngine } from "./process-manager.js";
import { cleanupRestartDatabaseSnapshot, restoreRestartDatabaseSnapshot } from "./database/restart-snapshot.js";

export type LauncherCommand = "niubot" | "nbt";

export interface RuntimeLauncherOptions {
  command: LauncherCommand;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  seedRoot?: string;
  bootstrapVerify?: (packageDirectory: string, version: string) => void | Promise<void>;
}

export async function runRuntimeLauncher(options: RuntimeLauncherOptions): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const parsed = parseLauncherHome(argv, env);
  const sharedStore = new SharedReleaseStore(resolveSharedRuntimeRoot({ env }));
  const homeStore = new HomeReleaseStore(parsed.home, sharedStore);
  const running = await inspectRunningEngine(parsed.home);
  let migrationRuntime;
  if (!homeStore.stateExistsRecovering()) {
    if (running) {
      migrationRuntime = {
        runtimePath: running.state.runtimePath,
        node: probeNodeRuntimeRef(running.state.nodePath),
      };
    }
  }
  let state = homeStore.readOrMigrateLegacy(currentNodeRuntimeRef(), migrationRuntime);
  let runningRef: ReleaseRef | undefined;
  if (running) {
    try {
      runningRef = homeStore.releaseRefForRuntimePath(running.state.runtimePath, probeNodeRuntimeRef(running.state.nodePath));
    } catch {
      // Fall back to the committed home current when the recorded Node vanished.
    }
  }
  if (state.transaction) {
    if (homeStore.transactionOwnerIsActive(state.transaction)) {
      if (!(options.command === "nbt" && runningRef && sameReleaseRef(runningRef, state.transaction.candidate))) {
        throw new Error(`NiuBot runtime transaction '${state.transaction.transactionId}' is still active`);
      }
    } else {
      await stopEngine(parsed.home);
      if (state.transaction.databaseSnapshot) {
        homeStore.assertTransactionSnapshotContained(state.transaction.databaseSnapshot);
        restoreRestartDatabaseSnapshot(state.transaction.databaseSnapshot);
      }
      const snapshot = state.transaction.databaseSnapshot;
      state = homeStore.reconcileInterruptedTransaction(state);
      if (snapshot) cleanupRestartDatabaseSnapshot(snapshot);
    }
  }
  const failures: string[] = [];
  // A valid legacy release is already an authoritative runtime selection.
  // The installed npm seed is only a bootstrap/recovery source; importing it
  // must never replace a usable release merely because it is not shared yet.
  if (!state.current && env["NIUBOT_ENV"] !== "dev") {
    try {
      const recommendedStore = new RecommendedReleaseStore(sharedStore);
      const recommended = recommendedStore.stateExistsRecovering() ? recommendedStore.readStrict() : undefined;
      if (recommended) {
        homeStore.resolveRuntime(recommended.release, true);
        state = { schemaVersion: 2, current: recommended.release };
        homeStore.writeState(state);
        homeStore.writeSharedRef({ state });
      }
    } catch (err) {
      failures.push(`recommended bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!state.current) {
    try {
      state = await bootstrapFromInstalledSeed({
        homeStore,
        seedRoot: options.seedRoot ?? projectRootFromLauncher(),
        env,
        verify: options.bootstrapVerify,
        previousState: state,
      });
    } catch (err) {
      failures.push(`shared bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const recommendation = recommendedStartRef(options.command, argv, state, homeStore, sharedStore);
  const launchRefs = options.command === "nbt" && runningRef
    ? uniqueReleaseRefs([runningRef, ...orderedFallbacks(state)])
    : recommendation
      ? uniqueReleaseRefs([recommendation, ...orderedFallbacks(state)])
      : orderedFallbacks(state);
  for (const ref of launchRefs) {
    try {
      const runtimePath = homeStore.resolveRuntime(ref, true);
      assertNodeAbi(ref);
      const entry = path.join(runtimePath, "dist", options.command === "niubot" ? "user-cli.js" : "cli.js");
      if (!fs.existsSync(entry)) throw new Error(`CLI entry is missing: ${entry}`);
      const args = options.command === "nbt" ? parsed.forwardedArgs : argv;
      const selectedEnvironment = env["NIUBOT_ENV"] === "dev" || env["NIUBOT_ENV"] === "production"
        ? env["NIUBOT_ENV"]
        : runningRef && sameReleaseRef(runningRef, ref) && running?.state.runtimeMode === "dev"
          ? "dev"
          : releaseEnvironment(sharedStore, ref);
      const result = spawnSync(ref.node.nodePath, [entry, ...args], {
        cwd: safeWorkingDirectory(runtimePath),
        env: { ...env, NIUBOT_HOME: parsed.home, NIUBOT_ENV: selectedEnvironment },
        stdio: "inherit",
        windowsHide: true,
      });
      if (result.error) throw result.error;
      return result.status ?? 1;
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  try {
    const recovered = await bootstrapFromInstalledSeed({
      homeStore,
      seedRoot: options.seedRoot ?? projectRootFromLauncher(),
      env,
      verify: options.bootstrapVerify,
      previousState: state,
    });
    const ref = recovered.current!;
    const runtimePath = homeStore.resolveRuntime(ref, true);
    assertNodeAbi(ref);
    const entry = path.join(runtimePath, "dist", options.command === "niubot" ? "user-cli.js" : "cli.js");
    const args = options.command === "nbt" ? parsed.forwardedArgs : argv;
    const selectedEnvironment = env["NIUBOT_ENV"] === "dev" || env["NIUBOT_ENV"] === "production"
      ? env["NIUBOT_ENV"]
      : releaseEnvironment(sharedStore, ref);
    const result = spawnSync(ref.node.nodePath, [entry, ...args], {
      cwd: safeWorkingDirectory(runtimePath),
      env: { ...env, NIUBOT_HOME: parsed.home, NIUBOT_ENV: selectedEnvironment },
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
    throw new Error(`No usable NiuBot runtime for ${parsed.home}: ${failures.join("; ")}`);
  }
}

export async function bootstrapFromInstalledSeed(options: {
  homeStore: HomeReleaseStore;
  seedRoot: string;
  env: NodeJS.ProcessEnv;
  verify?: (packageDirectory: string, version: string) => void | Promise<void>;
  previousState?: HomeReleaseState;
}): Promise<HomeReleaseState> {
  if (typeof process.getuid === "function" && process.getuid() === 0 && !options.env["NIUBOT_ALLOW_ROOT_STORE"]) {
    throw new Error("Refusing to initialize a per-user NiuBot store as root");
  }
  const installed = await new SharedReleaseInstaller(options.homeStore.sharedStore).importInstalledTree({
    sourceDirectory: options.seedRoot,
    sourceKind: "seed",
    nodePath: process.execPath,
    nodeVersion: process.version,
    nodeAbi: process.versions.modules,
    cwd: safeWorkingDirectory(options.seedRoot),
    env: withNodeRuntimeOnPath(process.execPath, options.env),
    verify: options.verify,
  });
  const ref: ReleaseRef = {
    storage: "shared",
    artifactId: installed.artifactId,
    node: {
      nodePath: process.execPath,
      nodeVersion: process.version,
      nodeAbi: process.versions.modules,
    },
  };
  const previousState = options.previousState ?? options.homeStore.readState();
  const usablePrevious = usableSlots(options.homeStore, previousState);
  const state: HomeReleaseState = {
    ...previousState,
    schemaVersion: 2,
    current: ref,
    transaction: undefined,
    unresolvedLegacy: previousState.unresolvedLegacy ?? [],
  };
  const transactionId = `bootstrap-${Date.now()}`;
  options.homeStore.writeSharedRef({
    state: previousState,
    pending: {
      transactionId,
      protected: [ref, ...orderedFallbacks(usablePrevious)],
      updatedAt: new Date().toISOString(),
    },
  });
  options.homeStore.writeState(state);
  options.homeStore.writeSharedRef({
    state,
    pending: {
      transactionId,
      protected: [ref, ...orderedFallbacks(usablePrevious)],
      updatedAt: new Date().toISOString(),
    },
  });
  if (options.env["NIUBOT_ENV"] !== "dev") {
    try {
      new RecommendedReleaseStore(options.homeStore.sharedStore).promote(ref);
    } catch {
      // A bootstrap seed must not replace a newer or explicitly different recommendation.
    }
  }
  return state;
}

function usableSlots(homeStore: HomeReleaseStore, state: HomeReleaseState): HomeReleaseState {
  const usable = (ref: ReleaseRef | undefined): ReleaseRef | undefined => {
    if (!ref) return undefined;
    try { homeStore.resolveRuntime(ref); return ref; } catch { return undefined; }
  };
  return {
    schemaVersion: 2,
    current: usable(state.current),
  };
}

export function parseLauncherHome(argv: string[], env: NodeJS.ProcessEnv): { home: string; forwardedArgs: string[] } {
  let explicit: string | undefined;
  const forwardedArgs: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--home") {
      const value = argv[index + 1];
      if (!value) throw new Error("--home requires a path");
      explicit = value;
      index++;
      continue;
    }
    forwardedArgs.push(argv[index]!);
  }
  return {
    home: resolveLauncherHomePath(explicit ?? env["NIUBOT_HOME"] ?? path.join(os.homedir(), ".niubot")),
    forwardedArgs,
  };
}

function resolveLauncherHomePath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.resolve(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function orderedFallbacks(state: HomeReleaseState): ReleaseRef[] {
  const result: ReleaseRef[] = [];
  const seen = new Set<string>();
  for (const ref of [state.current]) {
    if (!ref) continue;
    const key = ref.storage === "shared" ? `shared:${ref.artifactId}` : `legacy:${ref.runtimePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function uniqueReleaseRefs(refs: ReleaseRef[]): ReleaseRef[] {
  const result: ReleaseRef[] = [];
  for (const ref of refs) {
    if (!result.some((existing) => sameReleaseRef(existing, ref))) result.push(ref);
  }
  return result;
}

function recommendedStartRef(
  command: LauncherCommand,
  argv: string[],
  state: HomeReleaseState,
  homeStore: HomeReleaseStore,
  sharedStore: SharedReleaseStore,
): (ReleaseRef & { storage: "shared" }) | undefined {
  if (command !== "niubot" || (argv[0] !== "start" && argv[0] !== "restart")) return undefined;
  if (state.current?.storage === "shared") {
    const currentManifest = sharedStore.readManifest(state.current.artifactId);
    if (currentManifest?.sourceKind === "source") return undefined;
  }
  const recommendedStore = new RecommendedReleaseStore(sharedStore);
  let recommended;
  try {
    recommended = recommendedStore.stateExistsRecovering() ? recommendedStore.readStrict() : undefined;
  } catch {
    return undefined;
  }
  if (!recommended || sameReleaseRef(state.current, recommended.release)) return undefined;
  const recommendedVersion = sharedStore.readManifest(recommended.release.artifactId)?.version;
  if (!recommendedVersion) return undefined;
  let currentVersion: string | undefined;
  if (state.current) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(homeStore.resolveRuntime(state.current), "package.json"), "utf-8")) as { version?: unknown };
      currentVersion = typeof pkg.version === "string" ? pkg.version : undefined;
    } catch {
      // An unusable current may be recovered by a valid recommendation.
    }
  }
  if (!shouldAdoptRecommendedRelease(state.current, currentVersion, recommended.release, recommendedVersion)) return undefined;
  if (state.rejectedRecommendation?.generation === recommended.generation
    && state.rejectedRecommendation.artifactId === recommended.release.artifactId) return undefined;
  return recommended.release;
}

function releaseEnvironment(sharedStore: SharedReleaseStore, ref: ReleaseRef): "dev" | "production" {
  if (ref.storage === "shared" && sharedStore.readManifest(ref.artifactId)?.sourceKind === "source") return "dev";
  return "production";
}

function assertNodeAbi(ref: ReleaseRef): void {
  const result = spawnSync(ref.node.nodePath, ["-p", "process.versions.modules"], {
    encoding: "utf-8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Node runtime exited with ${result.status}`);
  const actual = result.stdout.trim();
  if (actual !== ref.node.nodeAbi) throw new Error(`Node ABI mismatch: ${actual}; expected ${ref.node.nodeAbi}`);
}

function projectRootFromLauncher(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function safeWorkingDirectory(fallback: string): string {
  try { return process.cwd(); } catch { return fallback; }
}
