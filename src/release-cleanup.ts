import fs from "node:fs";
import path from "node:path";
import { HomeReleaseStore, type HomeReleaseState } from "./home-release-store.js";
import { RecommendedReleaseStore } from "./recommended-release.js";
import { readProcessState } from "./process-state.js";
import type { ReleaseRef } from "./release-ref.js";
import { SharedReleaseStore } from "./shared-release-store.js";
import { isDevVersion, isProductionVersion } from "./version.js";

export interface CleanupCandidate {
  kind: "shared-release" | "shared-trash" | "staging" | "package-cache" | "legacy-release" | "legacy-trash";
  sourcePath: string;
  targetPath?: string;
  reason: string;
}

export interface SharedCleanupOptions {
  now?: number;
  releaseGraceMs?: number;
  trashGraceMs?: number;
  keepRecent?: number;
  stagingGraceMs?: number;
  keepPackages?: number;
  apply?: boolean;
  knownHomes?: string[];
}

export function cleanupSharedReleases(
  store: SharedReleaseStore,
  options: SharedCleanupOptions = {},
): CleanupCandidate[] {
  const now = options.now ?? Date.now();
  const releaseGraceMs = options.releaseGraceMs ?? 7 * 24 * 60 * 60 * 1_000;
  const trashGraceMs = options.trashGraceMs ?? 7 * 24 * 60 * 60 * 1_000;
  const keepRecent = options.keepRecent ?? 3;
  const releaseLock = store.acquireLock();
  try {
    const protectedIds = collectProtectedArtifactIds(store, options.knownHomes ?? []);
    const releases = readDirectories(store.releasesDirectory)
      .map((entry) => ({ ...entry, mtimeMs: fs.statSync(entry.fullPath).mtimeMs }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    const recentUnprotected = ["production", "dev", "legacy"]
      .flatMap((channel) => releases
        .filter((entry) => !protectedIds.has(entry.name) && artifactChannel(store, entry.name) === channel)
        .slice(0, keepRecent));
    const recentIds = new Set(recentUnprotected.map((entry) => entry.name));
    const candidates: CleanupCandidate[] = [];
    for (const release of releases) {
      if (protectedIds.has(release.name) || recentIds.has(release.name)) continue;
      if (now - release.mtimeMs < releaseGraceMs) continue;
      const targetPath = path.join(store.trashDirectory, `${release.name}-${now}`);
      candidates.push({
        kind: "shared-release",
        sourcePath: release.fullPath,
        targetPath,
        reason: "unreferenced shared artifact past grace period",
      });
      if (options.apply) fs.renameSync(release.fullPath, targetPath);
    }
    for (const trash of readDirectories(store.trashDirectory)) {
      const mtimeMs = fs.statSync(trash.fullPath).mtimeMs;
      if (now - mtimeMs < trashGraceMs) continue;
      candidates.push({
        kind: "shared-trash",
        sourcePath: trash.fullPath,
        reason: "trash artifact past deletion grace period",
      });
      if (options.apply) fs.rmSync(trash.fullPath, { recursive: true, force: true });
    }
    const stagingGraceMs = options.stagingGraceMs ?? 24 * 60 * 60 * 1_000;
    for (const staging of readDirectories(store.stagingDirectory)) {
      const mtimeMs = fs.statSync(staging.fullPath).mtimeMs;
      if (now - mtimeMs < stagingGraceMs || store.stagingOwnerIsActive(staging.fullPath)) continue;
      candidates.push({ kind: "staging", sourcePath: staging.fullPath, reason: "abandoned staging directory past grace period" });
      if (options.apply) fs.rmSync(staging.fullPath, { recursive: true, force: true });
    }
    const packages = readFiles(store.packagesDirectory, ".tgz")
      .map((entry) => ({ ...entry, mtimeMs: fs.statSync(entry.fullPath).mtimeMs }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const archive of packages.slice(options.keepPackages ?? 5)) {
      if (now - archive.mtimeMs < releaseGraceMs) continue;
      candidates.push({ kind: "package-cache", sourcePath: archive.fullPath, reason: "download cache past retention policy" });
      if (options.apply) fs.rmSync(archive.fullPath, { force: true });
    }
    return candidates;
  } finally {
    releaseLock();
  }
}

function artifactChannel(store: SharedReleaseStore, artifactId: string): "production" | "dev" | "legacy" {
  const version = store.readManifest(artifactId)?.version;
  if (version && isProductionVersion(version)) return "production";
  if (version && isDevVersion(version)) return "dev";
  return "legacy";
}

export interface LegacyCleanupOptions {
  now?: number;
  graceMs?: number;
  apply?: boolean;
  runningRuntimePath?: string;
  trashGraceMs?: number;
}

export function cleanupLegacyReleases(
  niubotHome: string,
  state: HomeReleaseState,
  options: LegacyCleanupOptions = {},
): CleanupCandidate[] {
  const successfulAt = state.firstSharedSuccessAt ? Date.parse(state.firstSharedSuccessAt) : Number.NaN;
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? 7 * 24 * 60 * 60 * 1_000;
  if (!Number.isFinite(successfulAt) || !state.sharedSuccessfulStarts || now - successfulAt < graceMs) return [];

  const canonicalHome = canonicalPath(niubotHome);
  const protectedPaths = new Set<string>();
  for (const ref of [state.current]) {
    if (ref?.storage === "legacy") protectedPaths.add(canonicalPath(ref.runtimePath));
  }
  for (const ref of state.transaction
    ? [state.transaction.candidate, state.transaction.rollbackCurrent]
    : []) {
    if (ref?.storage === "legacy") protectedPaths.add(canonicalPath(ref.runtimePath));
  }
  for (const unresolved of state.unresolvedLegacy ?? []) protectedPaths.add(canonicalPath(unresolved.runtimePath));
  if (options.runningRuntimePath) protectedPaths.add(canonicalPath(options.runningRuntimePath));

  const candidates: CleanupCandidate[] = [];
  for (const bot of readDirectories(canonicalHome)) {
    const releasesDirectory = path.join(bot.fullPath, "releases");
    if (!isDirectory(releasesDirectory)) continue;
    for (const release of readDirectories(releasesDirectory)) {
      const packageDirectory = path.join(release.fullPath, "package");
      if (!isDirectory(packageDirectory) || protectedPaths.has(canonicalPath(packageDirectory))) continue;
      if (now - fs.statSync(release.fullPath).mtimeMs < graceMs) continue;
      const trashRoot = path.join(canonicalHome, "runtime", "legacy-trash");
      const targetPath = path.join(trashRoot, `${sanitize(bot.name)}-${sanitize(release.name)}-${now}`);
      candidates.push({
        kind: "legacy-release",
        sourcePath: release.fullPath,
        targetPath,
        reason: "unreferenced legacy release after successful shared start and grace period",
      });
      if (options.apply) {
        fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
        fs.renameSync(release.fullPath, targetPath);
        const movedAt = new Date(now);
        fs.utimesSync(targetPath, movedAt, movedAt);
      }
    }
  }
  const trashRoot = path.join(canonicalHome, "runtime", "legacy-trash");
  const trashGraceMs = options.trashGraceMs ?? 7 * 24 * 60 * 60 * 1_000;
  for (const trash of readDirectories(trashRoot)) {
    if (now - fs.statSync(trash.fullPath).mtimeMs < trashGraceMs) continue;
    candidates.push({ kind: "legacy-trash", sourcePath: trash.fullPath, reason: "legacy trash past deletion grace period" });
    if (options.apply) fs.rmSync(trash.fullPath, { recursive: true, force: true });
  }
  return candidates;
}

function collectProtectedArtifactIds(store: SharedReleaseStore, knownHomes: string[]): Set<string> {
  const result = new Set<string>();
  const recommendedStore = new RecommendedReleaseStore(store);
  addSharedRef(result, recommendedStore.stateExistsRecovering() ? recommendedStore.readStrict().release : undefined);
  const refs = store.readAllHomeRefsStrict();
  const refsByHome = new Map(refs.map((ref) => [canonicalPath(ref.homePath), ref]));
  for (const homeRef of refs) {
    for (const ref of [
      homeRef.active.current,
      homeRef.active.previous,
      homeRef.active.lastKnownGood,
      ...(homeRef.pending?.protected ?? []),
      ...homeRef.rollback,
    ]) addSharedRef(result, ref);
    if (homeRef.runtimePath) {
      const id = store.artifactIdForRuntimePath(homeRef.runtimePath);
      if (id) result.add(id);
    }
  }
  for (const home of new Set([...knownHomes.map(canonicalPath), ...refs.map((ref) => canonicalPath(ref.homePath))])) {
    const homeStore = new HomeReleaseStore(home, store);
    if (homeStore.stateExistsRecovering()) {
      const state = homeStore.readStateStrict({ persistMigration: false });
      const sharedIds = releaseStateArtifactIds(state);
      const homeRef = refsByHome.get(home);
      if (sharedIds.size > 0 && !homeRef) throw new Error(`Cleanup refused: shared ref is missing for ${home}`);
      for (const id of sharedIds) {
        if (!homeRefContainsArtifact(homeRef!, id)) {
          throw new Error(`Cleanup refused: home state and shared ref disagree for ${home}`);
        }
        result.add(id);
      }
    }
    const runtimePath = readProcessState(home)?.processes.engine.runtimePath;
    if (runtimePath) {
      const artifactId = store.artifactIdForRuntimePath(runtimePath);
      if (artifactId) result.add(artifactId);
    }
  }
  return result;
}

function releaseStateArtifactIds(state: HomeReleaseState): Set<string> {
  const ids = new Set<string>();
  for (const ref of [state.current, state.transaction?.candidate, state.transaction?.rollbackCurrent]) addSharedRef(ids, ref);
  return ids;
}

function homeRefContainsArtifact(homeRef: ReturnType<SharedReleaseStore["readHomeRef"]>, artifactId: string): boolean {
  if (!homeRef) return false;
  const refs = [
    homeRef.active.current,
    homeRef.active.previous,
    homeRef.active.lastKnownGood,
    ...(homeRef.pending?.protected ?? []),
    ...homeRef.rollback,
  ];
  return refs.some((ref) => ref?.storage === "shared" && ref.artifactId === artifactId);
}

function addSharedRef(target: Set<string>, ref: ReleaseRef | undefined): void {
  if (ref?.storage === "shared") target.add(ref.artifactId);
}

function readDirectories(directory: string): Array<{ name: string; fullPath: string }> {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, fullPath: path.join(directory, entry.name) }));
  } catch {
    return [];
  }
}

function readFiles(directory: string, suffix: string): Array<{ name: string; fullPath: string }> {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => ({ name: entry.name, fullPath: path.join(directory, entry.name) }));
  } catch {
    return [];
  }
}

function isDirectory(value: string): boolean {
  try { return fs.statSync(value).isDirectory(); } catch { return false; }
}

function canonicalPath(value: string): string {
  try { return fs.realpathSync.native(value); } catch { return path.resolve(value); }
}

function sanitize(value: string): string {
  return value.replace(/[^0-9A-Za-z._-]+/g, "-").slice(0, 80) || "release";
}
