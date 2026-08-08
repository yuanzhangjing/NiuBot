import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentNodeRuntimeRef, type ReleaseRef } from "./release-ref.js";
import {
  buildArtifactId,
  buildImportedArtifactId,
  computeTreeDigest,
  createHomeId,
  createSharedReleaseManifest,
  SharedReleaseStore,
} from "./shared-release-store.js";

const tempDirectories: string[] = [];

function createStore(): SharedReleaseStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shared-store-"));
  tempDirectories.push(root);
  return new SharedReleaseStore(root);
}

function createStagedPackage(store: SharedReleaseStore, version = "1.2.3", content = "export {};\n") {
  const stagingDirectory = store.createStagingDirectory("test");
  const packageDirectory = path.join(stagingDirectory, "package");
  fs.mkdirSync(path.join(packageDirectory, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({
    name: "@yuanzhangjing/niubot",
    version,
  }));
  fs.writeFileSync(path.join(packageDirectory, "dist", "index.js"), content, { mode: 0o755 });
  return { stagingDirectory, packageDirectory };
}

function manifestFor(packageDirectory: string, artifactId: string, version = "1.2.3") {
  return createSharedReleaseManifest({
    artifactId,
    version,
    sourceKind: "npm",
    sourceDigest: "sha512-source",
    lockDigest: "a".repeat(64),
    treeDigest: computeTreeDigest(packageDirectory),
    installedAt: new Date().toISOString(),
    installerNodePath: process.execPath,
    nodeVersion: process.version,
    nodeAbi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
  });
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("shared release artifact identity", () => {
  it("separates source, lock, ABI, platform, and architecture", () => {
    const base = {
      version: "1.2.3",
      nodeAbi: "127",
      platform: "linux" as const,
      arch: "x64",
      sourceDigest: "sha512-source-a",
      lockDigest: "lock-a",
    };
    const id = buildArtifactId(base);
    expect(id).toMatch(/^1\.2\.3-node127-linux-x64-[0-9a-f]{12}-[0-9a-f]{12}$/);
    for (const changed of [
      { ...base, sourceDigest: "sha512-source-b" },
      { ...base, lockDigest: "lock-b" },
      { ...base, nodeAbi: "128" },
      { ...base, platform: "darwin" as const },
      { ...base, arch: "arm64" },
    ]) {
      expect(buildArtifactId(changed)).not.toBe(id);
    }
  });

  it("uses installed tree content for imported artifacts", () => {
    const first = buildImportedArtifactId({
      sourceKind: "legacy",
      version: "1.2.3",
      nodeAbi: "127",
      platform: "linux",
      arch: "x64",
      treeDigest: "a".repeat(64),
    });
    const second = buildImportedArtifactId({
      sourceKind: "legacy",
      version: "1.2.3",
      nodeAbi: "127",
      platform: "linux",
      arch: "x64",
      treeDigest: "b".repeat(64),
    });
    expect(first).not.toBe(second);
  });
});

describe("shared release tree digest", () => {
  it("is stable across mtimes but includes content and executable bits", () => {
    const store = createStore();
    const staged = createStagedPackage(store);
    const first = computeTreeDigest(staged.packageDirectory);
    const entry = path.join(staged.packageDirectory, "dist", "index.js");
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(entry, later, later);
    expect(computeTreeDigest(staged.packageDirectory)).toBe(first);
    if (process.platform !== "win32") {
      fs.chmodSync(entry, 0o644);
      expect(computeTreeDigest(staged.packageDirectory)).not.toBe(first);
      fs.chmodSync(entry, 0o755);
    }
    fs.writeFileSync(entry, "export const changed = true;\n");
    expect(computeTreeDigest(staged.packageDirectory)).not.toBe(first);
  });
});

describe("shared release publication", () => {
  it("publishes downloaded archives atomically and rejects conflicting cache content", () => {
    const store = createStore();
    const firstDirectory = store.createStagingDirectory("download");
    const first = path.join(firstDirectory, "package.tgz");
    fs.writeFileSync(first, "first");
    expect(store.publishPackageArchive(first)).toBe(path.join(store.packagesDirectory, "package.tgz"));

    const duplicateDirectory = store.createStagingDirectory("download");
    const duplicate = path.join(duplicateDirectory, "package.tgz");
    fs.writeFileSync(duplicate, "first");
    expect(store.publishPackageArchive(duplicate)).toBe(path.join(store.packagesDirectory, "package.tgz"));

    const conflictDirectory = store.createStagingDirectory("download");
    const conflict = path.join(conflictDirectory, "package.tgz");
    fs.writeFileSync(conflict, "different");
    expect(() => store.publishPackageArchive(conflict)).toThrow(/different content/);
  });

  it("publishes through staging and reuses identical immutable content", () => {
    const store = createStore();
    const artifactId = buildArtifactId({
      version: "1.2.3",
      nodeAbi: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
      sourceDigest: "source",
      lockDigest: "lock",
    });
    const first = createStagedPackage(store);
    expect(store.publishStagedArtifact({
      stagingDirectory: first.stagingDirectory,
      manifest: manifestFor(first.packageDirectory, artifactId),
    })).toBe("published");
    expect(fs.existsSync(first.stagingDirectory)).toBe(false);
    expect(store.assertUsableArtifact(artifactId).artifactId).toBe(artifactId);

    const duplicate = createStagedPackage(store);
    expect(store.publishStagedArtifact({
      stagingDirectory: duplicate.stagingDirectory,
      manifest: manifestFor(duplicate.packageDirectory, artifactId),
    })).toBe("reused");
    expect(fs.existsSync(duplicate.stagingDirectory)).toBe(false);
  });

  it("does not replace an existing artifact with different content", () => {
    const store = createStore();
    const artifactId = "fixed-artifact";
    const first = createStagedPackage(store);
    store.publishStagedArtifact({
      stagingDirectory: first.stagingDirectory,
      manifest: manifestFor(first.packageDirectory, artifactId),
    });
    const conflicting = createStagedPackage(store, "1.2.3", "export const conflict = true;\n");
    expect(() => store.publishStagedArtifact({
      stagingDirectory: conflicting.stagingDirectory,
      manifest: manifestFor(conflicting.packageDirectory, artifactId),
    })).toThrow(/different content/);
    expect(fs.existsSync(conflicting.stagingDirectory)).toBe(true);
  });

  it("detects corruption after publication", () => {
    const store = createStore();
    const artifactId = "corruption-test";
    const staged = createStagedPackage(store);
    store.publishStagedArtifact({
      stagingDirectory: staged.stagingDirectory,
      manifest: manifestFor(staged.packageDirectory, artifactId),
    });
    fs.writeFileSync(path.join(store.packageDirectory(artifactId), "dist", "index.js"), "corrupted\n");
    expect(() => store.assertUsableArtifact(artifactId, undefined, true)).toThrow(/corrupted/);
  });

  it("refuses publishing a directory outside staging", () => {
    const store = createStore();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-outside-"));
    tempDirectories.push(outside);
    fs.mkdirSync(path.join(outside, "package"));
    expect(() => store.publishStagedArtifact({
      stagingDirectory: outside,
      manifest: {} as never,
    })).toThrow(/outside the shared store/);
  });
});

describe("shared home refs", () => {
  it("writes refs atomically with active, pending, and rollback protection", () => {
    const store = createStore();
    const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-home-ref-"));
    tempDirectories.push(homePath);
    const node = currentNodeRuntimeRef();
    const current: ReleaseRef = { storage: "shared", artifactId: "current", node };
    const legacy: ReleaseRef = { storage: "legacy", runtimePath: path.join(homePath, "Bot", "releases", "old", "package"), node };
    const homeId = createHomeId(homePath);
    store.writeHomeRef({
      schemaVersion: 1,
      homeId,
      homePath: fs.realpathSync.native(homePath),
      active: { current, lastKnownGood: legacy },
      pending: {
        transactionId: "upgrade-1",
        protected: [current, legacy],
        updatedAt: new Date().toISOString(),
      },
      rollback: [legacy],
      runtimePath: legacy.runtimePath,
      updatedAt: new Date().toISOString(),
    });
    expect(store.readHomeRef(homeId)?.pending?.protected).toHaveLength(2);
    expect(store.readAllHomeRefs()).toHaveLength(1);
    if (process.platform !== "win32") {
      expect(fs.statSync(store.homeRefFile(homeId)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(store.rootDirectory).mode & 0o777).toBe(0o700);
    }
  });

  it("rejects a ref whose id does not identify its home", () => {
    const store = createStore();
    expect(() => store.writeHomeRef({
      schemaVersion: 1,
      homeId: "wrong",
      homePath: path.resolve("/tmp/example-home"),
      active: {},
      rollback: [],
      updatedAt: new Date().toISOString(),
    })).toThrow(/does not match/);
  });

  it("recovers a ref left as a Windows replacement backup", () => {
    const store = createStore();
    const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-home-ref-recover-"));
    tempDirectories.push(homePath);
    const homeId = createHomeId(homePath);
    store.writeHomeRef({
      schemaVersion: 1,
      homeId,
      homePath: fs.realpathSync.native(homePath),
      active: {},
      rollback: [],
      updatedAt: new Date().toISOString(),
    });
    const refFile = store.homeRefFile(homeId);
    fs.renameSync(refFile, `${refFile}.replace-backup`);
    expect(store.readAllHomeRefsStrict()).toHaveLength(1);
    expect(fs.existsSync(refFile)).toBe(true);
  });
});
