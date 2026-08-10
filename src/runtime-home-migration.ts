import path from "node:path";
import { HomeReleaseStore, type HomeReleaseState } from "./home-release-store.js";
import { type NodeRuntimeRef, type ReleaseRef } from "./release-ref.js";
import { SharedReleaseInstaller } from "./shared-release-installer.js";
import { SharedReleaseStore } from "./shared-release-store.js";
import { samePlatformPath } from "./platform/files.js";
import { acquireProcessLock } from "./process-lock.js";
import { ReleaseStore } from "./release-store.js";

export interface RuntimeHomeMigrationOptions {
  niubotHome: string;
  runtimePath: string;
  node: NodeRuntimeRef;
  sharedStore: SharedReleaseStore;
  env: NodeJS.ProcessEnv;
  verify?: (packageDirectory: string, version: string) => void | Promise<void>;
}

interface PreparedRuntimeHomeMigration {
  homeStore: HomeReleaseStore;
  legacyRef: Extract<ReleaseRef, { storage: "legacy" }>;
  sharedRef: Extract<ReleaseRef, { storage: "shared" }>;
}

export interface CompletedRuntimeHomeMigration {
  homeStore: HomeReleaseStore;
  sharedRef: Extract<ReleaseRef, { storage: "shared" }>;
  state: HomeReleaseState;
}

export interface CompleteRuntimeHomeMigrationOptions extends RuntimeHomeMigrationOptions {
  settleMs?: number;
  retryMs?: number;
  timeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  acquireRestartLock?: () => () => void;
}

/**
 * Copy the currently running legacy package into the shared store without
 * changing the active version. The reference swap is deliberately separate:
 * callers finalize only after the Engine has completed normal startup.
 */
async function prepareRuntimeHomeMigration(
  options: RuntimeHomeMigrationOptions,
): Promise<PreparedRuntimeHomeMigration | undefined> {
  if (typeof process.getuid === "function" && process.getuid() === 0 && !options.env["NIUBOT_ALLOW_ROOT_STORE"]) {
    throw new Error("Refusing to migrate a per-user NiuBot runtime store as root");
  }
  const homeStore = new HomeReleaseStore(options.niubotHome, options.sharedStore);
  let state = homeStore.readOrMigrateLegacy(options.node, {
    runtimePath: options.runtimePath,
    node: options.node,
  });
  if (state.transaction) return undefined;

  const runtimeRef = homeStore.releaseRefForRuntimePath(options.runtimePath, options.node);
  if (!runtimeRef || runtimeRef.storage === "shared") return undefined;

  if (!state.current) {
    state = {
      ...state,
      schemaVersion: 2,
      current: runtimeRef,
    };
    homeStore.writeState(state);
    homeStore.writeSharedRef({ state, runtimePath: options.runtimePath });
  }
  if (!isSameLegacyRuntime(state.current, runtimeRef)) {
    if (!legacyStoreCommittedHealthyRuntime(options.runtimePath)) return undefined;
    state = {
      ...state,
      current: runtimeRef,
      firstSharedSuccessAt: undefined,
      sharedSuccessfulStarts: undefined,
    };
    homeStore.writeState(state);
    homeStore.writeSharedRef({ state, runtimePath: options.runtimePath });
  }

  const installed = await new SharedReleaseInstaller(options.sharedStore).importInstalledTree({
    sourceDirectory: options.runtimePath,
    sourceKind: "legacy",
    nodePath: options.node.nodePath,
    nodeVersion: options.node.nodeVersion,
    nodeAbi: options.node.nodeAbi,
    cwd: safeWorkingDirectory(options.runtimePath),
    env: options.env,
    verify: options.verify,
  });
  const sharedRef: Extract<ReleaseRef, { storage: "shared" }> = {
    storage: "shared",
    artifactId: installed.artifactId,
    node: options.node,
  };
  const transactionId = `legacy-adopt-${process.pid}-${Date.now()}`;
  homeStore.writeSharedRef({
    state,
    pending: {
      transactionId,
      protected: [sharedRef, ...releaseRefs(state)],
      updatedAt: new Date().toISOString(),
    },
    runtimePath: options.runtimePath,
  });
  return {
    homeStore,
    legacyRef: runtimeRef,
    sharedRef,
  };
}

function finalizeRuntimeHomeMigration(plan: PreparedRuntimeHomeMigration): HomeReleaseState {
  try {
    const state = plan.homeStore.replaceEquivalentRelease(plan.legacyRef, plan.sharedRef);
    plan.homeStore.writeSharedRef({ state, runtimePath: plan.legacyRef.runtimePath });
    return state;
  } catch (err) {
    try {
      plan.homeStore.writeSharedRef({ state: plan.homeStore.readState(), runtimePath: plan.legacyRef.runtimePath });
    } catch {
      // Preserve the original error. A stale pending ref is conservative: it
      // protects an artifact from cleanup and is repaired on the next start.
    }
    throw err;
  }
}

/**
 * Finish legacy adoption after the Engine is serving normally. An update
 * started by an older runtime still owns the home transaction while the new
 * Engine boots, so wait for that transaction to commit instead of requiring a
 * second user restart.
 */
export async function completeRuntimeHomeMigrationAfterStartup(
  options: CompleteRuntimeHomeMigrationOptions,
): Promise<CompletedRuntimeHomeMigration | undefined> {
  const sleep = options.sleep ?? delay;
  const settleMs = options.settleMs ?? 2_000;
  const retryMs = options.retryMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const acquireRestartLock = options.acquireRestartLock ?? (() => acquireProcessLock(
    path.join(options.niubotHome, "run", "restart.lock"),
    "Restart",
  ));
  if (settleMs > 0) await sleep(settleMs);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    let releaseRestartLock: (() => void) | undefined;
    try {
      releaseRestartLock = acquireRestartLock();
    } catch (err) {
      if (!isBusyRestartLock(err)) throw err;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for Restart lock");
      await sleep(retryMs);
      continue;
    }

    let transactionId: string | undefined;
    try {
      const plan = await prepareRuntimeHomeMigration(options);
      if (plan) {
        return {
          homeStore: plan.homeStore,
          sharedRef: plan.sharedRef,
          state: finalizeRuntimeHomeMigration(plan),
        };
      }

      const homeStore = new HomeReleaseStore(options.niubotHome, options.sharedStore);
      let state = homeStore.readState();
      transactionId = state.transaction?.transactionId;
      if (!transactionId) {
        const runtimeRef = homeStore.releaseRefForRuntimePath(options.runtimePath, options.node);
        if (!state.current && runtimeRef?.storage === "shared") {
          state = homeStore.commitInitialHealthy(runtimeRef);
          homeStore.writeSharedRef({ state, runtimePath: options.runtimePath });
          return { homeStore, sharedRef: runtimeRef, state };
        }
        reconcileSharedRuntimeRef(homeStore, state, options.runtimePath, options.node);
        return undefined;
      }
    } finally {
      releaseRestartLock();
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for runtime transaction '${transactionId}'`);
    await sleep(retryMs);
  }
}

function reconcileSharedRuntimeRef(
  homeStore: HomeReleaseStore,
  state: HomeReleaseState,
  runtimePath: string,
  node: NodeRuntimeRef,
): void {
  const runtimeRef = homeStore.releaseRefForRuntimePath(runtimePath, node);
  if (runtimeRef?.storage !== "shared" || state.current?.storage !== "shared") return;
  if (runtimeRef.artifactId !== state.current.artifactId
    || runtimeRef.node.nodePath !== state.current.node.nodePath
    || runtimeRef.node.nodeAbi !== state.current.node.nodeAbi) return;
  homeStore.writeSharedRef({ state, runtimePath });
}

function isBusyRestartLock(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Restart is already running");
}

function isSameLegacyRuntime(
  left: ReleaseRef | undefined,
  right: Extract<ReleaseRef, { storage: "legacy" }>,
): boolean {
  return left?.storage === "legacy"
    && samePlatformPath(left.runtimePath, right.runtimePath)
    && left.node.nodePath === right.node.nodePath
    && left.node.nodeAbi === right.node.nodeAbi;
}

function legacyStoreCommittedHealthyRuntime(runtimePath: string): boolean {
  const botDirectory = path.dirname(path.dirname(path.dirname(runtimePath)));
  const legacyStore = new ReleaseStore(botDirectory);
  const releaseId = legacyStore.releaseIdForRuntimePath(runtimePath);
  if (!releaseId) return false;
  const state = legacyStore.migrateLegacyLinks();
  return state.current === releaseId && state.lastKnownGood === releaseId;
}

function releaseRefs(state: HomeReleaseState): ReleaseRef[] {
  return [state.current, state.transaction?.candidate, state.transaction?.rollbackCurrent]
    .filter((ref): ref is ReleaseRef => ref !== undefined);
}

function safeWorkingDirectory(fallback: string): string {
  try { return process.cwd(); } catch { return fallback; }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
