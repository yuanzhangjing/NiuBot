import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  reserveDevelopmentVersion,
  selectLatestDevelopmentRelease,
  selectLatestProductionRelease,
} from "./development-release.js";
import { computeTreeDigest, createSharedReleaseManifest, SharedReleaseStore } from "./shared-release-store.js";

const roots: string[] = [];

function fixture(): SharedReleaseStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-dev-release-"));
  roots.push(root);
  return new SharedReleaseStore(root);
}

function publish(store: SharedReleaseStore, artifactId: string, version: string, sourceKind: "source" | "npm" = "source"): void {
  const staging = store.createStagingDirectory(artifactId);
  const packageDirectory = path.join(staging, "package");
  fs.mkdirSync(packageDirectory);
  fs.writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({
    name: "@yuanzhangjing/niubot",
    version,
  }));
  store.publishStagedArtifact({
    stagingDirectory: staging,
    manifest: createSharedReleaseManifest({
      artifactId,
      version,
      sourceKind,
      sourceDigest: artifactId,
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
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("development release versions", () => {
  it("reserves unique increasing versions without a persistent counter", () => {
    const store = fixture();
    publish(store, "dev-one", "0.2.10-dev.1");
    const first = reserveDevelopmentVersion(store, "0.2.10");
    const second = reserveDevelopmentVersion(store, "0.2.10");
    expect(first.version).toBe("0.2.10-dev.2");
    expect(second.version).toBe("0.2.10-dev.3");
    first.release();
    second.release();
  });

  it("refuses an implicit core-version downgrade", () => {
    const store = fixture();
    publish(store, "newer-core", "0.3.0-dev.1");
    expect(() => reserveDevelopmentVersion(store, "0.2.10")).toThrow(/downgrade/);
  });

  it("selects the greatest compatible dev artifact and ignores production", () => {
    const store = fixture();
    publish(store, "stable", "9.0.0");
    publish(store, "dev-one", "0.2.10-dev.1");
    publish(store, "dev-two", "0.2.10-dev.2");
    expect(selectLatestDevelopmentRelease(store)).toMatchObject({
      version: "0.2.10-dev.2",
      ref: { artifactId: "dev-two" },
    });
  });

  it("selects the greatest production artifact and excludes legacy stable source builds", () => {
    const store = fixture();
    publish(store, "stable-old", "1.0.0", "npm");
    publish(store, "stable-new", "1.1.0", "npm");
    publish(store, "legacy-source", "9.0.0", "source");
    publish(store, "dev", "2.0.0-dev.1", "source");
    expect(selectLatestProductionRelease(store)).toMatchObject({
      version: "1.1.0",
      ref: { artifactId: "stable-new" },
    });
  });
});
