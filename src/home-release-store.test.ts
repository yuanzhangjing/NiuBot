import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HomeReleaseStore } from "./home-release-store.js";
import { currentNodeRuntimeRef, type ReleaseRef } from "./release-ref.js";
import { computeTreeDigest, createHomeId, createSharedReleaseManifest, SharedReleaseStore } from "./shared-release-store.js";

const tempDirectories: string[] = [];

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-home-release-"));
  tempDirectories.push(root);
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const shared = new SharedReleaseStore(path.join(root, "shared"));
  return { home, shared, store: new HomeReleaseStore(home, shared) };
}

function createLegacy(home: string, bot = "Bot", id = "old"): string {
  const runtime = path.join(home, bot, "releases", id, "package");
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({
    name: "@yuanzhangjing/niubot",
    version: "1.0.0",
  }));
  return runtime;
}

function createShared(shared: SharedReleaseStore, artifactId = "shared-a"): void {
  const staging = shared.createStagingDirectory("home-test");
  const packageDirectory = path.join(staging, "package");
  fs.mkdirSync(packageDirectory);
  fs.writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({
    name: "@yuanzhangjing/niubot",
    version: "2.0.0",
  }));
  shared.publishStagedArtifact({
    stagingDirectory: staging,
    manifest: createSharedReleaseManifest({
      artifactId,
      version: "2.0.0",
      sourceKind: "legacy",
      sourceDigest: "tree",
      treeDigest: computeTreeDigest(packageDirectory),
      installedAt: new Date().toISOString(),
      installerNodePath: process.execPath,
      nodeVersion: process.version,
      nodeAbi: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
    }),
  });
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("home release store", () => {
  it("keeps the home id stable when the home directory is created later", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-future-home-"));
    tempDirectories.push(root);
    const home = path.join(root, "not-created-yet");
    const shared = new SharedReleaseStore(path.join(root, "shared"));
    const store = new HomeReleaseStore(home, shared);
    fs.mkdirSync(home);
    expect(store.homeId).toBe(createHomeId(home));
  });

  it("recovers an interrupted Windows state replacement before existence checks", () => {
    const { store } = setup();
    store.writeState({ schemaVersion: 2 });
    fs.renameSync(store.stateFile, `${store.stateFile}.replace-backup`);
    expect(store.stateExistsRecovering()).toBe(true);
    expect(store.readStateStrict()).toEqual({ schemaVersion: 2 });
  });

  it("stores legacy and shared slots together", () => {
    const { home, shared, store } = setup();
    createShared(shared);
    const node = currentNodeRuntimeRef();
    const legacy: ReleaseRef = { storage: "legacy", runtimePath: createLegacy(home), node };
    const current: ReleaseRef = { storage: "shared", artifactId: "shared-a", node };
    store.writeState({ schemaVersion: 2, current: legacy, lastKnownGood: legacy });
    expect(store.activate(current)).toEqual({
      schemaVersion: 2,
      current,
      previous: legacy,
      lastKnownGood: legacy,
    });
    expect(store.markLastKnownGood(current)).toMatchObject({
      current,
      previous: legacy,
      lastKnownGood: current,
      sharedSuccessfulStarts: 1,
    });
  });

  it("derives refs for managed shared and legacy runtime paths", () => {
    const { home, shared, store } = setup();
    createShared(shared);
    const node = currentNodeRuntimeRef();
    const legacyPath = createLegacy(home);
    expect(store.releaseRefForRuntimePath(shared.packageDirectory("shared-a"), node)).toEqual({
      storage: "shared",
      artifactId: "shared-a",
      node,
    });
    expect(store.releaseRefForRuntimePath(legacyPath, node)).toEqual({
      storage: "legacy",
      runtimePath: fs.realpathSync.native(legacyPath),
      node,
    });
    expect(store.releaseRefForRuntimePath(path.join(path.dirname(home), "outside"), node)).toBeUndefined();
  });

  it("rejects arbitrary paths disguised as legacy releases", () => {
    const { home, store } = setup();
    const arbitrary = path.join(home, "runtime", "package");
    fs.mkdirSync(arbitrary, { recursive: true });
    fs.writeFileSync(path.join(arbitrary, "package.json"), JSON.stringify({
      name: "@yuanzhangjing/niubot",
      version: "1.0.0",
    }));
    expect(() => store.resolveRuntime({
      storage: "legacy",
      runtimePath: arbitrary,
      node: currentNodeRuntimeRef(),
    })).toThrow(/managed release layout/);
  });

  it("records pending protection before activation", () => {
    const { home, shared, store } = setup();
    const legacy: ReleaseRef = {
      storage: "legacy",
      runtimePath: createLegacy(home),
      node: currentNodeRuntimeRef(),
    };
    store.writeState({ schemaVersion: 2, current: legacy, lastKnownGood: legacy });
    store.writeSharedRef({
      pending: {
        transactionId: "restart-1",
        protected: [legacy],
        updatedAt: new Date().toISOString(),
      },
      rollback: [legacy],
      runtimePath: legacy.runtimePath,
    });
    expect(shared.readHomeRef(store.homeId)).toMatchObject({
      active: { current: legacy, lastKnownGood: legacy },
      pending: { transactionId: "restart-1" },
      rollback: [legacy],
    });
  });

  it("discovers releases from every legacy bot store conservatively", () => {
    const { home, store } = setup();
    const active = createLegacy(home, "BotA", "active");
    const unresolved = createLegacy(home, "BotB", "older");
    expect(store.discoverUnresolvedLegacy([active])).toEqual([{
      runtimePath: fs.realpathSync.native(unresolved),
      reason: "legacy release has no verified Node runtime binding",
    }]);
  });

  it("migrates schema v1 slots without losing rollback order", () => {
    const { home, store } = setup();
    const current = createLegacy(home, "Bot", "current");
    const previous = createLegacy(home, "Bot", "previous");
    const lkg = createLegacy(home, "Bot", "lkg");
    fs.writeFileSync(path.join(home, "Bot", "releases", "state.json"), JSON.stringify({
      schemaVersion: 1,
      current: "current",
      previous: "previous",
      lastKnownGood: "lkg",
    }));

    const state = store.readOrMigrateLegacy(currentNodeRuntimeRef(), undefined, () => true);
    expect(state.current).toMatchObject({ storage: "legacy", runtimePath: fs.realpathSync.native(current) });
    expect(state.previous).toMatchObject({ storage: "legacy", runtimePath: fs.realpathSync.native(previous) });
    expect(state.lastKnownGood).toMatchObject({ storage: "legacy", runtimePath: fs.realpathSync.native(lkg) });
    expect(state.unresolvedLegacy).toBeUndefined();
    expect(store.readState()).toEqual(state);
  });

  it("rolls an interrupted activation back before launch", () => {
    const { home, shared, store } = setup();
    createShared(shared);
    const node = currentNodeRuntimeRef();
    const legacy: ReleaseRef = { storage: "legacy", runtimePath: createLegacy(home), node };
    const candidate: ReleaseRef = { storage: "shared", artifactId: "shared-a", node };
    store.writeState({
      schemaVersion: 2,
      current: candidate,
      lastKnownGood: legacy,
      transaction: {
        transactionId: "interrupted",
        phase: "activating",
        candidate,
        rollback: { current: legacy, lastKnownGood: legacy },
      },
    });
    const recovered = store.reconcileInterruptedTransaction();
    expect(recovered.current).toEqual(legacy);
    expect(recovered.lastKnownGood).toEqual(legacy);
    expect(recovered.transaction).toBeUndefined();
  });

  it("prefers the legacy store and Node used by the verified running process", () => {
    const { home, store } = setup();
    createLegacy(home, "BotA", "lkg");
    fs.writeFileSync(path.join(home, "BotA", "releases", "state.json"), JSON.stringify({
      schemaVersion: 1,
      lastKnownGood: "lkg",
    }));
    const runningPath = createLegacy(home, "BotB", "running");
    fs.writeFileSync(path.join(home, "BotB", "releases", "state.json"), JSON.stringify({
      schemaVersion: 1,
      current: "running",
    }));
    const runningNode = { ...currentNodeRuntimeRef(), nodeVersion: `${process.version}-running` };
    const state = store.readOrMigrateLegacy(currentNodeRuntimeRef(), {
      runtimePath: runningPath,
      node: runningNode,
    }, () => false);
    expect(state.current).toEqual({ storage: "legacy", runtimePath: fs.realpathSync.native(runningPath), node: runningNode });
  });

  it("rejects transaction snapshots outside the home restart directory", () => {
    const { store } = setup();
    expect(() => store.assertTransactionSnapshotContained({
      rootDirectory: path.resolve(os.tmpdir(), "outside-snapshot"),
      manifestPath: path.resolve(os.tmpdir(), "outside-snapshot", "preflight-manifest.json"),
      records: [],
    })).toThrow(/outside NIUBOT_HOME/);
  });
});
