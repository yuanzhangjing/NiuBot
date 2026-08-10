import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HomeReleaseStore, type HomeReleaseState } from "./home-release-store.js";
import { cleanupLegacyReleases, cleanupSharedReleases } from "./release-cleanup.js";
import { currentNodeRuntimeRef, type ReleaseRef } from "./release-ref.js";
import { computeTreeDigest, createHomeId, createSharedReleaseManifest, SharedReleaseStore } from "./shared-release-store.js";
import { RecommendedReleaseStore } from "./recommended-release.js";

const tempDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-cleanup-"));
  tempDirectories.push(root);
  return root;
}

function publish(
  store: SharedReleaseStore,
  id: string,
  sourceKind: "legacy" | "npm" | "source" = "legacy",
  version = "1.0.0",
): void {
  const staging = store.createStagingDirectory(id);
  const packageDirectory = path.join(staging, "package");
  fs.mkdirSync(packageDirectory);
  fs.writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({
    name: "@yuanzhangjing/niubot",
    version,
  }));
  store.publishStagedArtifact({
    stagingDirectory: staging,
    manifest: createSharedReleaseManifest({
      artifactId: id,
      version,
      sourceKind,
      sourceDigest: id,
      treeDigest: computeTreeDigest(packageDirectory),
      installedAt: new Date(0).toISOString(),
      installerNodePath: process.execPath,
      nodeVersion: process.version,
      nodeAbi: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
    }),
  });
  fs.utimesSync(store.releaseDirectory(id), new Date(0), new Date(0));
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("shared release cleanup", () => {
  it("protects the global production recommendation", () => {
    const store = new SharedReleaseStore(path.join(temporaryRoot(), "shared"));
    publish(store, "recommended", "npm");
    publish(store, "unused");
    new RecommendedReleaseStore(store).promote({
      storage: "shared",
      artifactId: "recommended",
      node: currentNodeRuntimeRef(),
    });
    const candidates = cleanupSharedReleases(store, { now: Date.now(), releaseGraceMs: 0, keepRecent: 0 });
    expect(candidates.map((item) => path.basename(item.sourcePath))).toEqual(["unused"]);
  });

  it("protects active, pending, rollback, and running artifacts", () => {
    const root = temporaryRoot();
    const store = new SharedReleaseStore(path.join(root, "shared"));
    for (const id of ["active", "pending", "rollback", "running", "unused"]) publish(store, id);
    const node = currentNodeRuntimeRef();
    const shared = (artifactId: string): ReleaseRef => ({ storage: "shared", artifactId, node });
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    store.writeHomeRef({
      schemaVersion: 1,
      homeId: createHomeId(home),
      homePath: fs.realpathSync.native(home),
      active: { current: shared("active") },
      pending: { transactionId: "tx", protected: [shared("pending")], updatedAt: new Date().toISOString() },
      rollback: [shared("rollback")],
      runtimePath: store.packageDirectory("running"),
      updatedAt: new Date().toISOString(),
    });

    const dryRun = cleanupSharedReleases(store, { now: Date.now(), releaseGraceMs: 0, keepRecent: 0 });
    expect(dryRun.map((item) => path.basename(item.sourcePath))).toEqual(["unused"]);
    expect(fs.existsSync(store.releaseDirectory("unused"))).toBe(true);

    cleanupSharedReleases(store, { now: Date.now(), releaseGraceMs: 0, keepRecent: 0, apply: true });
    expect(fs.existsSync(store.releaseDirectory("unused"))).toBe(false);
    for (const id of ["active", "pending", "rollback", "running"]) {
      expect(fs.existsSync(store.releaseDirectory(id))).toBe(true);
    }
  });

  it("keeps live staging but reports abandoned staging and old package cache", () => {
    const store = new SharedReleaseStore(path.join(temporaryRoot(), "shared"));
    const active = store.createStagingDirectory("active");
    const abandoned = store.createStagingDirectory("abandoned");
    fs.writeFileSync(path.join(abandoned, ".owner.json"), "{}\n");
    fs.utimesSync(abandoned, new Date(0), new Date(0));
    for (let index = 0; index < 2; index++) {
      const file = path.join(store.packagesDirectory, `${index}.tgz`);
      fs.writeFileSync(file, String(index));
      fs.utimesSync(file, new Date(index * 1_000), new Date(index * 1_000));
    }
    const candidates = cleanupSharedReleases(store, {
      now: Date.now(),
      stagingGraceMs: 0,
      releaseGraceMs: 0,
      keepPackages: 1,
    });
    expect(candidates.some((item) => item.sourcePath === active)).toBe(false);
    expect(candidates.some((item) => item.sourcePath === abandoned && item.kind === "staging")).toBe(true);
    expect(candidates.filter((item) => item.kind === "package-cache")).toHaveLength(1);
  });

  it("keeps recent production and DEV artifacts independently", () => {
    const store = new SharedReleaseStore(path.join(temporaryRoot(), "shared"));
    publish(store, "production-old", "npm", "1.0.0");
    publish(store, "production-new", "npm", "1.1.0");
    publish(store, "dev-old", "source", "1.1.0-dev.1");
    publish(store, "dev-new", "source", "1.1.0-dev.2");
    fs.utimesSync(store.releaseDirectory("production-new"), new Date(2_000), new Date(2_000));
    fs.utimesSync(store.releaseDirectory("dev-new"), new Date(2_000), new Date(2_000));

    const candidates = cleanupSharedReleases(store, { now: Date.now(), releaseGraceMs: 0, keepRecent: 1 });
    expect(candidates.filter((item) => item.kind === "shared-release").map((item) => path.basename(item.sourcePath)).sort())
      .toEqual(["dev-old", "production-old"]);
  });

  it("refuses cleanup when a shared ref is damaged", () => {
    const root = temporaryRoot();
    const store = new SharedReleaseStore(path.join(root, "shared"));
    store.ensureDirectories();
    fs.writeFileSync(path.join(store.refsDirectory, "broken.json"), "not-json\n");
    expect(() => cleanupSharedReleases(store, { apply: true })).toThrow(/Invalid shared home ref/);
  });

  it("refuses cleanup when the recommendation state is damaged", () => {
    const store = new SharedReleaseStore(path.join(temporaryRoot(), "shared"));
    store.ensureDirectories();
    fs.writeFileSync(path.join(store.rootDirectory, "recommended.json"), "not-json\n");
    expect(() => cleanupSharedReleases(store, { apply: true })).toThrow(/Invalid recommended release state/);
  });

  it("refuses cleanup when a known home state has no matching ref", () => {
    const root = temporaryRoot();
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    const store = new SharedReleaseStore(path.join(root, "shared"));
    publish(store, "active");
    const homeStore = new HomeReleaseStore(home, store);
    homeStore.writeState({
      schemaVersion: 2,
      current: { storage: "shared", artifactId: "active", node: currentNodeRuntimeRef() },
    });
    expect(() => cleanupSharedReleases(store, { apply: true, knownHomes: [home] })).toThrow(/ref is missing/);
  });

  it("normalizes an old home state without recursively taking the store lock", () => {
    const root = temporaryRoot();
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, "runtime"), { recursive: true });
    const store = new SharedReleaseStore(path.join(root, "shared"));
    publish(store, "active");
    const current: ReleaseRef = { storage: "shared", artifactId: "active", node: currentNodeRuntimeRef() };
    const homeStore = new HomeReleaseStore(home, store);
    fs.writeFileSync(homeStore.stateFile, JSON.stringify({ schemaVersion: 2, current, lastKnownGood: current }));
    store.writeHomeRef({
      schemaVersion: 1,
      homeId: createHomeId(home),
      homePath: fs.realpathSync.native(home),
      active: { current },
      rollback: [],
      updatedAt: new Date().toISOString(),
    });
    expect(() => cleanupSharedReleases(store, {
      knownHomes: [home], now: Date.now(), releaseGraceMs: 0, keepRecent: 0,
    })).not.toThrow();
    expect(JSON.parse(fs.readFileSync(homeStore.stateFile, "utf-8"))).toHaveProperty("lastKnownGood");
  });
});

describe("legacy release cleanup", () => {
  it("is disabled before a successful shared start and moves only unprotected releases", () => {
    const home = temporaryRoot();
    const old = createLegacy(home, "old");
    const unused = createLegacy(home, "unused");
    const node = currentNodeRuntimeRef();
    const protectedRef: ReleaseRef = { storage: "legacy", runtimePath: old, node };
    const notReady: HomeReleaseState = { schemaVersion: 2, current: protectedRef };
    expect(cleanupLegacyReleases(home, notReady, { graceMs: 0 })).toEqual([]);

    const ready: HomeReleaseState = {
      schemaVersion: 2,
      current: { storage: "shared", artifactId: "shared", node },
      transaction: {
        transactionId: "migration",
        phase: "activating",
        candidate: { storage: "shared", artifactId: "shared", node },
        rollbackCurrent: protectedRef,
      },
      firstSharedSuccessAt: new Date(0).toISOString(),
      sharedSuccessfulStarts: 1,
    };
    const dryRun = cleanupLegacyReleases(home, ready, { now: Date.now(), graceMs: 0 });
    expect(dryRun).toHaveLength(1);
    expect(fs.realpathSync.native(dryRun[0]!.sourcePath)).toBe(fs.realpathSync.native(path.dirname(unused)));
    expect(fs.existsSync(unused)).toBe(true);
    cleanupLegacyReleases(home, ready, { now: Date.now(), graceMs: 0, apply: true });
    expect(fs.existsSync(unused)).toBe(false);
    expect(fs.existsSync(old)).toBe(true);
  });

  it("protects transaction rollback refs and deletes legacy trash only after its second grace period", () => {
    const home = temporaryRoot();
    const protectedRuntime = createLegacy(home, "transaction-old");
    createLegacy(home, "unused");
    const node = currentNodeRuntimeRef();
    const state: HomeReleaseState = {
      schemaVersion: 2,
      current: { storage: "shared", artifactId: "candidate", node },
      firstSharedSuccessAt: new Date(0).toISOString(),
      sharedSuccessfulStarts: 1,
      transaction: {
        transactionId: "tx",
        phase: "activating",
        candidate: { storage: "shared", artifactId: "candidate", node },
        rollbackCurrent: { storage: "legacy", runtimePath: protectedRuntime, node },
      },
    };
    const trash = path.join(home, "runtime", "legacy-trash", "old-trash");
    fs.mkdirSync(trash, { recursive: true });
    fs.utimesSync(trash, new Date(0), new Date(0));
    const candidates = cleanupLegacyReleases(home, state, {
      now: Date.now(),
      graceMs: 0,
      trashGraceMs: 1_000,
    });
    expect(candidates.some((item) => item.sourcePath === path.dirname(protectedRuntime))).toBe(false);
    expect(candidates.some((item) => item.kind === "legacy-trash"
      && fs.realpathSync.native(item.sourcePath) === fs.realpathSync.native(trash))).toBe(true);
    cleanupLegacyReleases(home, state, { now: Date.now(), graceMs: 0, trashGraceMs: 1_000, apply: true });
    expect(fs.existsSync(protectedRuntime)).toBe(true);
    expect(fs.existsSync(trash)).toBe(false);
  });
});

function createLegacy(home: string, id: string): string {
  const packageDirectory = path.join(home, "Bot", "releases", id, "package");
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.writeFileSync(path.join(packageDirectory, "package.json"), "{}\n");
  fs.utimesSync(path.dirname(packageDirectory), new Date(0), new Date(0));
  return packageDirectory;
}
