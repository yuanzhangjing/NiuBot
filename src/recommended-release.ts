import fs from "node:fs";
import path from "node:path";
import { recoverFileReplacementSync, replaceFileSync } from "./platform/files.js";
import { isReleaseRef, probeNodeRuntimeRef, sameReleaseRef, type ReleaseRef } from "./release-ref.js";
import { type SharedReleaseManifest, SharedReleaseStore } from "./shared-release-store.js";
import { comparePackageVersions, isProductionVersion } from "./version.js";

export const RECOMMENDED_RELEASE_SCHEMA_VERSION = 1;

export interface RecommendedReleaseState {
  schemaVersion: typeof RECOMMENDED_RELEASE_SCHEMA_VERSION;
  generation: number;
  release: ReleaseRef & { storage: "shared" };
  updatedAt: string;
}

export interface PromoteRecommendedReleaseOptions {
  expectedGeneration?: number;
  allowSameVersionReplacement?: boolean;
}

/** Automatic adoption is upgrade-only. Rebinding the same immutable artifact
 * to a repaired Node runtime is also safe and does not change package content. */
export function shouldAdoptRecommendedRelease(
  current: ReleaseRef | undefined,
  currentVersion: string | undefined,
  recommended: ReleaseRef & { storage: "shared" },
  recommendedVersion: string,
): boolean {
  if (!current || !currentVersion) return true;
  if (sameReleaseRef(current, recommended)) return false;
  if (current.storage === "shared" && current.artifactId === recommended.artifactId) return true;
  return comparePackageVersions(recommendedVersion, currentVersion) === 1;
}

/** User-wide production recommendation. It is a restart hint, never a live-process pointer. */
export class RecommendedReleaseStore {
  readonly stateFile: string;

  constructor(readonly sharedStore: SharedReleaseStore) {
    this.stateFile = path.join(sharedStore.rootDirectory, "recommended.json");
  }

  read(): RecommendedReleaseState | undefined {
    try {
      recoverFileReplacementSync(this.stateFile);
      const value = JSON.parse(fs.readFileSync(this.stateFile, "utf-8")) as unknown;
      return isRecommendedReleaseState(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  readStrict(): RecommendedReleaseState {
    try {
      recoverFileReplacementSync(this.stateFile);
      const value = JSON.parse(fs.readFileSync(this.stateFile, "utf-8")) as unknown;
      if (!isRecommendedReleaseState(value)) throw new Error("invalid shape");
      this.assertEligible(value.release, false, false, true);
      return value;
    } catch (err) {
      throw new Error(`Invalid recommended release state: ${this.stateFile}`, { cause: err });
    }
  }

  stateExistsRecovering(): boolean {
    recoverFileReplacementSync(this.stateFile);
    return fs.existsSync(this.stateFile);
  }

  promote(
    release: ReleaseRef & { storage: "shared" },
    options: PromoteRecommendedReleaseOptions = {},
  ): RecommendedReleaseState {
    const unlock = this.sharedStore.acquireLock();
    try {
      // Validate while holding the same lock as cleanup so the artifact cannot
      // disappear between verification and publishing the recommendation.
      const candidate = this.assertEligible(release, true, true);
      const current = this.stateExistsRecovering() ? this.readStrict() : undefined;
      if (options.expectedGeneration !== undefined && (current?.generation ?? 0) !== options.expectedGeneration) {
        throw new Error(`Recommended release changed during activation: expected generation ${options.expectedGeneration}, found ${current?.generation ?? 0}`);
      }
      if (current && sameReleaseRef(current.release, release)) return current;
      if (current) {
        const existing = this.assertEligible(current.release, false, false, true);
        const compared = comparePackageVersions(candidate.version, existing.version);
        if (compared === undefined) throw new Error("Recommended releases must use valid semantic versions");
        if (compared < 0) {
          throw new Error(`Refusing to replace recommended ${existing.version} with older ${candidate.version}`);
        }
        if (compared === 0
          && current.release.artifactId !== release.artifactId
          && !options.allowSameVersionReplacement) {
          throw new Error(`Recommended ${candidate.version} already points to different content`);
        }
      }
      const next: RecommendedReleaseState = {
        schemaVersion: RECOMMENDED_RELEASE_SCHEMA_VERSION,
        generation: (current?.generation ?? 0) + 1,
        release,
        updatedAt: new Date().toISOString(),
      };
      writePrivateJson(this.stateFile, next);
      return next;
    } finally {
      unlock();
    }
  }

  private assertEligible(
    release: ReleaseRef & { storage: "shared" },
    verifyNode = false,
    verifyTree = false,
    allowLegacySeed = false,
  ): SharedReleaseManifest {
    const manifest = this.sharedStore.assertUsableArtifact(release.artifactId, undefined, verifyTree);
    if (manifest.sourceKind !== "npm" && manifest.sourceKind !== "legacy"
      && !(allowLegacySeed && manifest.sourceKind === "seed")) {
      throw new Error(`Artifact '${release.artifactId}' is not an eligible production release`);
    }
    if (!isProductionVersion(manifest.version)) {
      throw new Error(`Artifact '${release.artifactId}' is not a stable production version`);
    }
    if (manifest.nodeAbi !== release.node.nodeAbi) {
      throw new Error(`Artifact '${release.artifactId}' Node ABI does not match its release reference`);
    }
    if (verifyNode) {
      const actualNode = probeNodeRuntimeRef(release.node.nodePath);
      if (actualNode.nodeVersion !== release.node.nodeVersion || actualNode.nodeAbi !== release.node.nodeAbi) {
        throw new Error(`Artifact '${release.artifactId}' Node runtime identity is stale`);
      }
    }
    return manifest;
  }
}

export function isRecommendedReleaseState(value: unknown): value is RecommendedReleaseState {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item["schemaVersion"] === RECOMMENDED_RELEASE_SCHEMA_VERSION
    && Number.isSafeInteger(item["generation"])
    && Number(item["generation"]) > 0
    && isReleaseRef(item["release"])
    && item["release"].storage === "shared"
    && typeof item["updatedAt"] === "string"
    && !Number.isNaN(Date.parse(item["updatedAt"]));
}

function writePrivateJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    replaceFileSync(temporary, filePath);
    syncDirectory(path.dirname(filePath));
  } catch (err) {
    try { fs.unlinkSync(temporary); } catch { /* ignore */ }
    throw err;
  }
}

function syncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {
    // Directory fsync is not available on every platform/filesystem.
  }
}
