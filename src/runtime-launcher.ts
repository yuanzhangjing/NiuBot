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
import { isDevVersion, isProductionVersion, runtimeEnvironmentForVersion } from "./version.js";
import { selectLatestDevelopmentRelease, selectLatestProductionRelease } from "./development-release.js";

export type LauncherCommand = "niubot" | "nbt";

export interface RuntimeLauncherOptions {
  command: LauncherCommand;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  installedPackageRoot?: string;
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
  const installedPackageRoot = options.installedPackageRoot ?? projectRootFromLauncher();
  if (!state.current && fs.existsSync(path.join(installedPackageRoot, "src"))) {
    return runSourceEntrypoint(options.command, argv, parsed, installedPackageRoot, env);
  }
  const failures: string[] = [];
  let uncommittedCandidate: ReleaseRef | undefined;
  // Empty homes may start from the device recommendation, but the launcher
  // does not persist it. The running Engine commits it only after startup.
  if (!state.current) {
    try {
      const recommendedStore = new RecommendedReleaseStore(sharedStore);
      const recommended = recommendedStore.stateExistsRecovering() ? recommendedStore.readStrict() : undefined;
      if (recommended) {
        homeStore.resolveRuntime(recommended.release, true);
        uncommittedCandidate = recommended.release;
      } else {
        uncommittedCandidate = selectLatestProductionRelease(sharedStore)?.ref;
      }
    } catch (err) {
      failures.push(`recommended bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!state.current && !uncommittedCandidate) {
    try {
      uncommittedCandidate = await importInstalledProductionPackage({
        homeStore,
        packageRoot: installedPackageRoot,
        env,
        verify: options.bootstrapVerify,
      });
    } catch (err) {
      failures.push(`shared bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const recommendation = state.current
    ? recommendedStartRef(options.command, argv, state, homeStore, sharedStore)
    : undefined;
  const launchRefs = options.command === "nbt" && runningRef
    ? uniqueReleaseRefs([runningRef, ...orderedFallbacks(state)])
    : recommendation
      ? uniqueReleaseRefs([recommendation, ...orderedFallbacks(state)])
      : uniqueReleaseRefs([...(uncommittedCandidate ? [uncommittedCandidate] : []), ...orderedFallbacks(state)]);
  for (const ref of launchRefs) {
    try {
      const runtimePath = homeStore.resolveRuntime(ref, true);
      assertNodeAbi(ref);
      const entry = path.join(runtimePath, "dist", options.command === "niubot" ? "user-cli.js" : "cli.js");
      if (!fs.existsSync(entry)) throw new Error(`CLI entry is missing: ${entry}`);
      const args = options.command === "nbt" ? parsed.forwardedArgs : argv;
      const selectedEnvironment = releaseEnvironment(sharedStore, ref);
      const result = spawnSync(ref.node.nodePath, [entry, ...args], {
        cwd: safeWorkingDirectory(runtimePath),
        env: {
          ...env,
          NIUBOT_HOME: parsed.home,
          NIUBOT_ENV: selectedEnvironment,
          NIUBOT_LEGACY_SOURCE_MIGRATION: isLegacyDevRuntime(sharedStore, ref, env, runningRef, running?.state.runtimeMode) ? "1" : "",
          NIUBOT_LAUNCH_CANDIDATE_ARTIFACT_ID: !state.current && ref.storage === "shared" ? ref.artifactId : "",
        },
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
    const currentEnvironment = releaseEnvironmentForRef(homeStore, sharedStore, state.current);
    const selected = currentEnvironment === "dev"
      ? selectLatestDevelopmentRelease(sharedStore)?.ref
      : selectLatestProductionRelease(sharedStore)?.ref;
    const ref = selected ?? (currentEnvironment === "dev"
      ? undefined
      : await importInstalledProductionPackage({
        homeStore,
        packageRoot: installedPackageRoot,
        env,
        verify: options.bootstrapVerify,
      }));
    if (!ref) throw new Error("No compatible DEV recovery artifact is available");
    const runtimePath = homeStore.resolveRuntime(ref, true);
    assertNodeAbi(ref);
    const entry = path.join(runtimePath, "dist", options.command === "niubot" ? "user-cli.js" : "cli.js");
    const args = options.command === "nbt" ? parsed.forwardedArgs : argv;
    const selectedEnvironment = releaseEnvironment(sharedStore, ref);
    const result = spawnSync(ref.node.nodePath, [entry, ...args], {
      cwd: safeWorkingDirectory(runtimePath),
      env: {
        ...env,
        NIUBOT_HOME: parsed.home,
        NIUBOT_ENV: selectedEnvironment,
        NIUBOT_LEGACY_SOURCE_MIGRATION: isLegacyDevRuntime(sharedStore, ref, env) ? "1" : "",
        NIUBOT_LAUNCH_CANDIDATE_ARTIFACT_ID: ref.storage === "shared" ? ref.artifactId : "",
      },
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

function runSourceEntrypoint(
  command: LauncherCommand,
  argv: string[],
  parsed: ReturnType<typeof parseLauncherHome>,
  packageRoot: string,
  env: NodeJS.ProcessEnv,
): number {
  const entry = path.join(packageRoot, "dist", command === "niubot" ? "user-cli.js" : "cli.js");
  if (!fs.existsSync(entry)) throw new Error(`Source CLI entry is missing; run the build first: ${entry}`);
  const result = spawnSync(process.execPath, [entry, ...(command === "nbt" ? parsed.forwardedArgs : argv)], {
    cwd: safeWorkingDirectory(packageRoot),
    env: {
      ...env,
      NIUBOT_HOME: parsed.home,
      NIUBOT_ENV: "dev",
      NIUBOT_SOURCE_FIRST_START: command === "niubot" && (argv[0] === "start" || argv[0] === "restart") ? "1" : "",
      NIUBOT_SOURCE_DIR: packageRoot,
    },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export async function importInstalledProductionPackage(options: {
  homeStore: HomeReleaseStore;
  packageRoot: string;
  env: NodeJS.ProcessEnv;
  verify?: (packageDirectory: string, version: string) => void | Promise<void>;
}): Promise<ReleaseRef & { storage: "shared" }> {
  if (typeof process.getuid === "function" && process.getuid() === 0 && !options.env["NIUBOT_ALLOW_ROOT_STORE"]) {
    throw new Error("Refusing to initialize a per-user NiuBot store as root");
  }
  const installedVersion = readPackageVersion(options.packageRoot);
  if (!installedVersion || !isProductionVersion(installedVersion)) {
    throw new Error(`Installed package is not a production version: ${installedVersion ?? "unknown"}`);
  }
  const installed = await new SharedReleaseInstaller(options.homeStore.sharedStore).importInstalledTree({
    sourceDirectory: options.packageRoot,
    sourceKind: "npm",
    nodePath: process.execPath,
    nodeVersion: process.version,
    nodeAbi: process.versions.modules,
    cwd: safeWorkingDirectory(options.packageRoot),
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
  return ref;
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
  const currentVersion = releaseVersion(homeStore, sharedStore, state.current);
  if (currentVersion && isDevVersion(currentVersion)) return undefined;
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
  if (!shouldAdoptRecommendedRelease(state.current, currentVersion, recommended.release, recommendedVersion)) return undefined;
  if (state.rejectedRecommendation?.generation === recommended.generation
    && state.rejectedRecommendation.artifactId === recommended.release.artifactId) return undefined;
  return recommended.release;
}

function releaseEnvironment(sharedStore: SharedReleaseStore, ref: ReleaseRef): "dev" | "production" {
  const version = ref.storage === "shared"
    ? sharedStore.readManifest(ref.artifactId)?.version
    : readPackageVersion(ref.runtimePath);
  if (!version) throw new Error("Runtime version is unavailable");
  const environment = runtimeEnvironmentForVersion(version);
  if (!environment) throw new Error(`Unsupported runtime version: ${version}`);
  return environment;
}

function isLegacyDevRuntime(
  sharedStore: SharedReleaseStore,
  ref: ReleaseRef,
  originalEnv: NodeJS.ProcessEnv,
  runningRef?: ReleaseRef,
  runningMode?: string,
): boolean {
  const version = ref.storage === "shared"
    ? sharedStore.readManifest(ref.artifactId)?.version
    : readPackageVersion(ref.runtimePath);
  if (!version || !isProductionVersion(version)) return false;
  if (ref.storage === "shared" && sharedStore.readManifest(ref.artifactId)?.sourceKind === "source") return true;
  return (ref.storage === "legacy" && originalEnv["NIUBOT_ENV"] === "dev")
    || Boolean(runningRef && sameReleaseRef(runningRef, ref) && runningMode === "dev");
}

function releaseVersion(
  homeStore: HomeReleaseStore,
  sharedStore: SharedReleaseStore,
  ref: ReleaseRef | undefined,
): string | undefined {
  if (!ref) return undefined;
  if (ref.storage === "shared") return sharedStore.readManifest(ref.artifactId)?.version;
  try { return readPackageVersion(homeStore.resolveRuntime(ref)); } catch { return undefined; }
}

function releaseEnvironmentForRef(
  homeStore: HomeReleaseStore,
  sharedStore: SharedReleaseStore,
  ref: ReleaseRef | undefined,
): "dev" | "production" | undefined {
  const version = releaseVersion(homeStore, sharedStore, ref);
  return version ? runtimeEnvironmentForVersion(version) : undefined;
}

function readPackageVersion(runtimePath: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(runtimePath, "package.json"), "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
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
