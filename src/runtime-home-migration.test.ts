import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HomeReleaseStore } from "./home-release-store.js";
import { currentNodeRuntimeRef, type ReleaseRef } from "./release-ref.js";
import {
  completeRuntimeHomeMigrationAfterStartup,
} from "./runtime-home-migration.js";
import { computeTreeDigest, createSharedReleaseManifest, SharedReleaseStore } from "./shared-release-store.js";
import { acquireProcessLock } from "./process-lock.js";
import { ReleaseStore } from "./release-store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime home migration", () => {
  it("commits an empty home's shared runtime only after Engine startup", async () => {
    const fixture = createFixture();
    const runtime = publishSharedPackage(fixture.sharedStore, "initial", "1.2.3");
    expect(fixture.homeStore.readState().current).toBeUndefined();

    const completed = await completeRuntimeHomeMigrationAfterStartup({
      niubotHome: fixture.home,
      runtimePath: runtime,
      node: currentNodeRuntimeRef(),
      sharedStore: fixture.sharedStore,
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
      settleMs: 0,
    });

    expect(completed?.state.current).toEqual(completed?.sharedRef);
    expect(completed?.state.sharedSuccessfulStarts).toBe(1);
    expect(fixture.sharedStore.readHomeRef(fixture.homeStore.homeId)?.active.current).toEqual(completed?.sharedRef);
  });

  it("copies the running legacy tree and swaps only equivalent refs", async () => {
    const fixture = createFixture();
    const previous = createLegacyPackage(fixture.home, "previous", "0.2.4");
    const current = createLegacyPackage(fixture.home, "current", "0.2.6");
    const node = currentNodeRuntimeRef();
    const currentRef: ReleaseRef = { storage: "legacy", runtimePath: current, node };
    const previousRef: ReleaseRef = { storage: "legacy", runtimePath: previous, node };
    fixture.homeStore.writeState({
      schemaVersion: 2,
      current: currentRef,
      previous: previousRef,
      lastKnownGood: currentRef,
    });

    const completed = await completeRuntimeHomeMigrationAfterStartup({
      niubotHome: fixture.home,
      runtimePath: current,
      node,
      sharedStore: fixture.sharedStore,
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
      verify: () => undefined,
      settleMs: 0,
    });

    expect(completed).toBeDefined();
    expect(completed!.state.current).toEqual(completed!.sharedRef);
    expect(completed!.state).not.toHaveProperty("lastKnownGood");
    expect(completed!.state).not.toHaveProperty("previous");
    expect(completed!.state.firstSharedSuccessAt).toBeUndefined();
    expect(completed!.state.sharedSuccessfulStarts).toBeUndefined();
    expect(fixture.sharedStore.readManifest(completed!.sharedRef.artifactId)?.sourceKind).toBe("legacy");
    expect(fixture.sharedStore.readHomeRef(fixture.homeStore.homeId)?.pending).toBeUndefined();
  });

  it("does not overwrite a current release that changed while the legacy tree was copied", async () => {
    const fixture = createFixture();
    const current = createLegacyPackage(fixture.home, "current", "0.2.6");
    const other = createLegacyPackage(fixture.home, "other", "0.2.7");
    const node = currentNodeRuntimeRef();
    const currentRef: ReleaseRef = { storage: "legacy", runtimePath: current, node };
    const otherRef: ReleaseRef = { storage: "legacy", runtimePath: other, node };
    fixture.homeStore.writeState({ schemaVersion: 2, current: currentRef });
    await expect(completeRuntimeHomeMigrationAfterStartup({
      niubotHome: fixture.home,
      runtimePath: current,
      node,
      sharedStore: fixture.sharedStore,
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
      verify: () => {
        fixture.homeStore.writeState({ schemaVersion: 2, current: otherRef });
      },
      settleMs: 0,
    })).rejects.toThrow(/Current release changed/);
    expect(fixture.homeStore.readState().current).toEqual(otherRef);
    expect(fixture.sharedStore.readHomeRef(fixture.homeStore.homeId)?.pending).toBeUndefined();
  });

  it("waits for an older update transaction and migrates on the same Engine start", async () => {
    const fixture = createFixture();
    const current = createLegacyPackage(fixture.home, "current-npm", "0.2.6");
    const node = currentNodeRuntimeRef();
    const currentRef: ReleaseRef = { storage: "legacy", runtimePath: current, node };
    fixture.homeStore.writeState({
      schemaVersion: 2,
      current: currentRef,
      transaction: {
        transactionId: "old-updater",
        phase: "activating",
        candidate: currentRef,
        rollback: {},
      },
    });
    let waits = 0;

    const completed = await completeRuntimeHomeMigrationAfterStartup({
      niubotHome: fixture.home,
      runtimePath: current,
      node,
      sharedStore: fixture.sharedStore,
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
      verify: () => undefined,
      settleMs: 0,
      retryMs: 0,
      timeoutMs: 1_000,
      sleep: async () => {
        waits += 1;
        fixture.homeStore.writeState({ schemaVersion: 2, current: currentRef, lastKnownGood: currentRef });
      },
    });

    expect(waits).toBe(1);
    expect(completed?.state.current).toMatchObject({ storage: "shared" });
    expect(completed?.state).not.toHaveProperty("lastKnownGood");
    expect(fixture.sharedStore.readHomeRef(fixture.homeStore.homeId)?.pending).toBeUndefined();
  });

  it("repairs stale shared state from a committed healthy legacy update", async () => {
    const fixture = createFixture();
    const stale = createLegacyPackage(fixture.home, "stale-seed", "0.2.4");
    const node = currentNodeRuntimeRef();
    const staleLegacyRef: ReleaseRef = { storage: "legacy", runtimePath: stale, node };
    fixture.homeStore.writeState({
      schemaVersion: 2,
      current: staleLegacyRef,
      lastKnownGood: staleLegacyRef,
    });
    const staleMigration = await completeRuntimeHomeMigrationAfterStartup({
      niubotHome: fixture.home,
      runtimePath: stale,
      node,
      sharedStore: fixture.sharedStore,
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
      verify: () => undefined,
      settleMs: 0,
    });
    const staleSharedRef = staleMigration!.sharedRef;
    const current = createLegacyPackage(fixture.home, "current-npm", "0.2.7");
    new ReleaseStore(path.join(fixture.home, "Bot")).writeState({
      schemaVersion: 1,
      current: "current-npm",
      previous: "stale-seed",
      lastKnownGood: "current-npm",
    });

    const completed = await completeRuntimeHomeMigrationAfterStartup({
      niubotHome: fixture.home,
      runtimePath: current,
      node,
      sharedStore: fixture.sharedStore,
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
      verify: () => undefined,
      settleMs: 0,
    });

    expect(completed).toBeDefined();
    expect(completed!.state.current).toEqual(completed!.sharedRef);
    expect(completed!.state).not.toHaveProperty("lastKnownGood");
    expect(completed!.state).not.toHaveProperty("previous");
    expect(completed!.state.firstSharedSuccessAt).toBeUndefined();
    expect(completed!.state.sharedSuccessfulStarts).toBeUndefined();
    expect(fixture.sharedStore.readManifest(completed!.sharedRef.artifactId)?.version).toBe("0.2.7");
  });

  it("waits for the restart lock before changing home state", async () => {
    const fixture = createFixture();
    const current = createLegacyPackage(fixture.home, "current", "0.2.6");
    const node = currentNodeRuntimeRef();
    const currentRef: ReleaseRef = { storage: "legacy", runtimePath: current, node };
    fixture.homeStore.writeState({ schemaVersion: 2, current: currentRef, lastKnownGood: currentRef });
    const releaseLock = acquireProcessLock(
      path.join(fixture.home, "run", "restart.lock"),
      "Restart",
    );
    let waits = 0;

    const completed = await completeRuntimeHomeMigrationAfterStartup({
      niubotHome: fixture.home,
      runtimePath: current,
      node,
      sharedStore: fixture.sharedStore,
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
      verify: () => undefined,
      settleMs: 0,
      retryMs: 0,
      timeoutMs: 1_000,
      sleep: async () => {
        waits += 1;
        expect(fixture.homeStore.readState().current).toEqual(currentRef);
        releaseLock();
      },
    });

    expect(waits).toBe(1);
    expect(completed?.state.current).toEqual(completed?.sharedRef);
  });

  it("repairs a stale pending home ref after state already points to shared", async () => {
    const fixture = createFixture();
    const current = createLegacyPackage(fixture.home, "current", "0.2.6");
    const node = currentNodeRuntimeRef();
    const legacyRef: ReleaseRef = { storage: "legacy", runtimePath: current, node };
    fixture.homeStore.writeState({ schemaVersion: 2, current: legacyRef, lastKnownGood: legacyRef });
    const completed = await completeRuntimeHomeMigrationAfterStartup({
      niubotHome: fixture.home,
      runtimePath: current,
      node,
      sharedStore: fixture.sharedStore,
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
      verify: () => undefined,
      settleMs: 0,
    });
    const sharedRef = completed!.sharedRef;
    const sharedRuntime = fixture.homeStore.resolveRuntime(sharedRef, true);
    const stale = fixture.sharedStore.readHomeRef(fixture.homeStore.homeId)!;
    fixture.sharedStore.writeHomeRef({
      ...stale,
      active: { current: legacyRef, lastKnownGood: legacyRef },
      pending: {
        transactionId: "crashed-migration",
        protected: [sharedRef, legacyRef],
        updatedAt: new Date().toISOString(),
      },
    });

    const repaired = await completeRuntimeHomeMigrationAfterStartup({
      niubotHome: fixture.home,
      runtimePath: sharedRuntime,
      node,
      sharedStore: fixture.sharedStore,
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
      verify: () => undefined,
      settleMs: 0,
    });

    expect(repaired).toBeUndefined();
    const homeRef = fixture.sharedStore.readHomeRef(fixture.homeStore.homeId);
    expect(homeRef?.active.current).toEqual(sharedRef);
    expect(homeRef?.active.lastKnownGood).toBeUndefined();
    expect(homeRef?.pending).toBeUndefined();
  });

  it("ignores source and unmanaged runtimes outside the selected home", async () => {
    const fixture = createFixture();
    const outside = path.join(fixture.root, "source-runtime");
    createPackage(outside, "0.2.6");

    const plan = await completeRuntimeHomeMigrationAfterStartup({
      niubotHome: fixture.home,
      runtimePath: outside,
      node: currentNodeRuntimeRef(),
      sharedStore: fixture.sharedStore,
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
      verify: () => undefined,
      settleMs: 0,
    });

    expect(plan).toBeUndefined();
    expect(fixture.homeStore.stateExistsRecovering()).toBe(false);
  });
});

function createFixture(): {
  root: string;
  home: string;
  sharedStore: SharedReleaseStore;
  homeStore: HomeReleaseStore;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-runtime-migration-"));
  temporaryDirectories.push(root);
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const sharedStore = new SharedReleaseStore(path.join(root, "shared"));
  return { root, home, sharedStore, homeStore: new HomeReleaseStore(home, sharedStore) };
}

function createLegacyPackage(home: string, id: string, version: string): string {
  const runtime = path.join(home, "Bot", "releases", id, "package");
  createPackage(runtime, version);
  return runtime;
}

function createPackage(runtime: string, version: string): void {
  fs.mkdirSync(path.join(runtime, "dist"), { recursive: true });
  fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({
    name: "@yuanzhangjing/niubot",
    version,
    type: "module",
  }));
  fs.writeFileSync(path.join(runtime, "dist", "user-cli.js"), "");
}

function publishSharedPackage(store: SharedReleaseStore, artifactId: string, version: string): string {
  const staging = store.createStagingDirectory(artifactId);
  const runtime = path.join(staging, "package");
  createPackage(runtime, version);
  store.publishStagedArtifact({
    stagingDirectory: staging,
    manifest: createSharedReleaseManifest({
      artifactId,
      version,
      sourceKind: "npm",
      sourceDigest: artifactId,
      treeDigest: computeTreeDigest(runtime),
      installedAt: new Date().toISOString(),
      installerNodePath: process.execPath,
      nodeVersion: process.version,
      nodeAbi: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
    }),
  });
  return store.packageDirectory(artifactId);
}
