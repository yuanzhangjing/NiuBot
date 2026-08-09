import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentNodeRuntimeRef, type ReleaseRef } from "./release-ref.js";
import { RecommendedReleaseStore, shouldAdoptRecommendedRelease } from "./recommended-release.js";
import { computeTreeDigest, createSharedReleaseManifest, SharedReleaseStore } from "./shared-release-store.js";

const roots: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-recommended-"));
  roots.push(root);
  const shared = new SharedReleaseStore(root);
  const publish = (artifactId: string, version: string, sourceKind: "npm" | "source" = "npm"): ReleaseRef & { storage: "shared" } => {
    const staging = shared.createStagingDirectory(artifactId);
    const packageDirectory = path.join(staging, "package");
    fs.mkdirSync(packageDirectory);
    fs.writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({
      name: "@yuanzhangjing/niubot", version,
    }));
    shared.publishStagedArtifact({
      stagingDirectory: staging,
      manifest: createSharedReleaseManifest({
        artifactId, version, sourceKind, sourceDigest: artifactId,
        treeDigest: computeTreeDigest(packageDirectory), installedAt: new Date().toISOString(),
        installerNodePath: process.execPath, nodeVersion: process.version,
        nodeAbi: process.versions.modules, platform: process.platform, arch: process.arch,
      }),
    });
    return { storage: "shared", artifactId, node: currentNodeRuntimeRef() };
  };
  return { shared, recommended: new RecommendedReleaseStore(shared), publish };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("recommended release store", () => {
  it("promotes production artifacts monotonically", () => {
    const { recommended, publish } = fixture();
    const first = recommended.promote(publish("release-a", "1.0.0"));
    const second = recommended.promote(publish("release-b", "1.1.0"), { expectedGeneration: first.generation });
    expect(second.generation).toBe(2);
    expect(recommended.readStrict().release.artifactId).toBe("release-b");
    expect(() => recommended.promote(first.release)).toThrow(/older/);
  });

  it("rejects stale commits and development artifacts", () => {
    const { recommended, publish } = fixture();
    recommended.promote(publish("release-a", "1.0.0"));
    expect(() => recommended.promote(publish("release-b", "1.1.0"), { expectedGeneration: 0 })).toThrow(/changed during activation/);
    expect(() => recommended.promote(publish("source-a", "1.2.0-dev.1", "source"))).toThrow(/not an eligible/);
    expect(() => recommended.promote(publish("prerelease-a", "1.2.0-beta.1"))).toThrow(/not a stable production version/);
  });

  it("does not silently replace equal-version content", () => {
    const { recommended, publish } = fixture();
    recommended.promote(publish("release-a", "1.0.0"));
    expect(() => recommended.promote(publish("release-b", "1.0.0"))).toThrow(/different content/);
  });

  it("repairs a stale Node path for the same immutable artifact", () => {
    const { shared, recommended, publish } = fixture();
    const release = publish("release-a", "1.0.0");
    fs.writeFileSync(recommended.stateFile, `${JSON.stringify({
      schemaVersion: 1,
      generation: 1,
      release: { ...release, node: { ...release.node, nodePath: path.join(shared.rootDirectory, "missing-node") } },
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    const repaired = recommended.promote(release, { expectedGeneration: 1 });
    expect(repaired.generation).toBe(2);
    expect(repaired.release).toEqual(release);
  });

  it("adopts only upgrades, except for rebinding the same artifact", () => {
    const node = currentNodeRuntimeRef();
    const current: ReleaseRef = { storage: "shared", artifactId: "current", node };
    expect(shouldAdoptRecommendedRelease(current, "3.0.0", { ...current, artifactId: "older" }, "2.0.0")).toBe(false);
    expect(shouldAdoptRecommendedRelease(current, "3.0.0", { ...current, artifactId: "newer" }, "4.0.0")).toBe(true);
    expect(shouldAdoptRecommendedRelease(current, "3.0.0", {
      ...current,
      node: { ...node, nodePath: path.join(os.tmpdir(), "replacement-node") },
    }, "3.0.0")).toBe(true);
  });
});
