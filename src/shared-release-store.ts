import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { recoverFileReplacementSync, replaceFileSync } from "./platform/files.js";
import { acquireProcessLock } from "./process-lock.js";
import { isProcessAlive, processStartMarkersMatch, queryProcessStartMarker } from "./platform/process.js";
import { isReleaseRef, isSafeIdentifier, type ReleaseRef, type ReleaseSlots } from "./release-ref.js";

const PACKAGE_NAME = "@yuanzhangjing/niubot";
const COMPLETE_MARKER = ".complete";
const STAGING_OWNER = ".owner.json";
export const SHARED_MANIFEST_SCHEMA_VERSION = 1;
export const SHARED_HOME_REF_SCHEMA_VERSION = 1;

export type ArtifactSourceKind = "npm" | "source" | "seed" | "legacy";

export interface ArtifactIdentity {
  version: string;
  nodeAbi: string;
  platform: NodeJS.Platform;
  arch: string;
  sourceDigest: string;
  lockDigest: string;
}

export interface SharedReleaseManifest {
  schemaVersion: typeof SHARED_MANIFEST_SCHEMA_VERSION;
  artifactId: string;
  packageName: typeof PACKAGE_NAME;
  version: string;
  sourceKind: ArtifactSourceKind;
  sourceDigest: string;
  lockDigest?: string;
  treeDigest: string;
  installedAt: string;
  installerNodePath: string;
  nodeVersion: string;
  nodeAbi: string;
  platform: NodeJS.Platform;
  arch: string;
}

export interface PendingHomeRef {
  transactionId: string;
  protected: ReleaseRef[];
  updatedAt: string;
}

export interface SharedHomeRef {
  schemaVersion: typeof SHARED_HOME_REF_SCHEMA_VERSION;
  homeId: string;
  homePath: string;
  active: ReleaseSlots;
  pending?: PendingHomeRef;
  rollback: ReleaseRef[];
  runtimePath?: string;
  updatedAt: string;
}

export interface PublishStagedArtifactOptions {
  stagingDirectory: string;
  manifest: SharedReleaseManifest;
}

export type PublishResult = "published" | "reused";

export class SharedReleaseStore {
  readonly releasesDirectory: string;
  readonly stagingDirectory: string;
  readonly packagesDirectory: string;
  readonly locksDirectory: string;
  readonly refsDirectory: string;
  readonly trashDirectory: string;
  readonly lockFile: string;

  constructor(readonly rootDirectory: string) {
    this.releasesDirectory = path.join(rootDirectory, "releases");
    this.stagingDirectory = path.join(rootDirectory, "staging");
    this.packagesDirectory = path.join(rootDirectory, "packages");
    this.locksDirectory = path.join(rootDirectory, "locks");
    this.refsDirectory = path.join(rootDirectory, "refs");
    this.trashDirectory = path.join(rootDirectory, "trash");
    this.lockFile = path.join(this.locksDirectory, "store.lock");
  }

  ensureDirectories(): void {
    for (const directory of [
      this.rootDirectory,
      this.releasesDirectory,
      this.stagingDirectory,
      this.packagesDirectory,
      this.locksDirectory,
      this.refsDirectory,
      this.trashDirectory,
    ]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
    }
  }

  acquireLock(timeoutMs = 5_000): () => void {
    this.ensureDirectories();
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        return acquireProcessLock(this.lockFile, "Shared release store");
      } catch (err) {
        if (Date.now() >= deadline || !(err instanceof Error) || !err.message.includes("already running")) throw err;
        blockingDelay(20);
      }
    }
  }

  createStagingDirectory(prefix = "artifact"): string {
    this.ensureDirectories();
    const safePrefix = sanitizeToken(prefix);
    const directory = fs.mkdtempSync(path.join(this.stagingDirectory, `${safePrefix}-${randomUUID()}-`));
    writePrivateJson(path.join(directory, STAGING_OWNER), {
      pid: process.pid,
      processStartMarker: queryProcessStartMarker(process.pid),
      createdAt: new Date().toISOString(),
    });
    return directory;
  }

  releaseDirectory(artifactId: string): string {
    assertSafeIdentifier(artifactId, "artifact id");
    return path.join(this.releasesDirectory, artifactId);
  }

  packageDirectory(artifactId: string): string {
    return path.join(this.releaseDirectory(artifactId), "package");
  }

  artifactIdForRuntimePath(runtimePath: string): string | undefined {
    const relative = path.relative(canonicalPath(this.releasesDirectory), canonicalPath(runtimePath));
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return undefined;
    const parts = relative.split(path.sep);
    return parts.length === 2 && parts[1] === "package" && isSafeIdentifier(parts[0]) ? parts[0] : undefined;
  }

  manifestFile(artifactId: string): string {
    return path.join(this.releaseDirectory(artifactId), "manifest.json");
  }

  publishPackageArchive(stagedArchive: string, filename = path.basename(stagedArchive)): string {
    if (path.basename(filename) !== filename || !filename.endsWith(".tgz")) {
      throw new Error(`Invalid package archive name: ${filename}`);
    }
    const stagingParent = assertDirectChild(path.dirname(stagedArchive), this.stagingDirectory, "package staging directory");
    const source = path.join(stagingParent, path.basename(stagedArchive));
    if (!fs.lstatSync(source).isFile()) throw new Error(`Staged package archive is unavailable: ${source}`);
    const destination = path.join(this.packagesDirectory, filename);
    const releaseLock = this.acquireLock();
    try {
      if (fs.existsSync(destination)) {
        if (hashFile(source) !== hashFile(destination)) {
          throw new Error(`Cached package archive has different content: ${filename}`);
        }
        fs.rmSync(source, { force: true });
        return destination;
      }
      fs.renameSync(source, destination);
      syncDirectory(this.packagesDirectory);
      return destination;
    } finally {
      releaseLock();
    }
  }

  publishStagedArtifact(options: PublishStagedArtifactOptions): PublishResult {
    this.ensureDirectories();
    const staging = assertDirectChild(options.stagingDirectory, this.stagingDirectory, "staging directory");
    const stagingStats = fs.lstatSync(staging);
    if (!stagingStats.isDirectory() || stagingStats.isSymbolicLink()) {
      throw new Error(`Staging path is not a real directory: ${staging}`);
    }
    const packageDirectory = path.join(staging, "package");
    validateManifestShape(options.manifest);
    validatePackageMetadata(packageDirectory, options.manifest.version);
    const actualDigest = computeTreeDigest(packageDirectory);
    if (actualDigest !== options.manifest.treeDigest) {
      throw new Error(`Staged artifact tree digest mismatch: ${actualDigest} != ${options.manifest.treeDigest}`);
    }

    try { fs.unlinkSync(path.join(staging, STAGING_OWNER)); } catch { /* old/external staging */ }
    writePrivateJson(path.join(staging, "manifest.json"), options.manifest);
    fs.writeFileSync(path.join(staging, COMPLETE_MARKER), `${options.manifest.artifactId}\n`, { mode: 0o600 });
    removeGroupAndOtherWriteBits(staging);

    const destination = this.releaseDirectory(options.manifest.artifactId);
    if (fs.existsSync(destination)) {
      const existingManifest = this.readManifest(options.manifest.artifactId);
      if (existingManifest && existingManifest.treeDigest !== options.manifest.treeDigest) {
        throw new Error(`Shared artifact '${options.manifest.artifactId}' has different content`);
      }
      try {
        this.assertUsableArtifact(options.manifest.artifactId, options.manifest.treeDigest);
        fs.rmSync(staging, { recursive: true, force: true });
        return "reused";
      } catch {
        const quarantine = path.join(this.trashDirectory, `${options.manifest.artifactId}-corrupt-${Date.now()}-${randomUUID()}`);
        fs.renameSync(destination, quarantine);
      }
    }
    try {
      fs.renameSync(staging, destination);
      syncDirectory(this.releasesDirectory);
      return "published";
    } catch (err) {
      if (!fs.existsSync(destination)) throw err;
      this.assertUsableArtifact(options.manifest.artifactId, options.manifest.treeDigest);
      fs.rmSync(staging, { recursive: true, force: true });
      return "reused";
    }
  }

  readManifest(artifactId: string): SharedReleaseManifest | undefined {
    try {
      const manifestFile = this.manifestFile(artifactId);
      recoverFileReplacementSync(manifestFile);
      const value = JSON.parse(fs.readFileSync(manifestFile, "utf-8")) as unknown;
      return isSharedReleaseManifest(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  assertUsableArtifact(artifactId: string, expectedTreeDigest?: string, verifyTree = false): SharedReleaseManifest {
    const releaseDirectory = this.releaseDirectory(artifactId);
    const marker = fs.readFileSync(path.join(releaseDirectory, COMPLETE_MARKER), "utf-8").trim();
    if (marker !== artifactId) throw new Error(`Shared artifact '${artifactId}' has an invalid completion marker`);
    const manifest = this.readManifest(artifactId);
    if (!manifest || manifest.artifactId !== artifactId) {
      throw new Error(`Shared artifact '${artifactId}' has an invalid manifest`);
    }
    if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
      throw new Error(`Shared artifact '${artifactId}' targets ${manifest.platform}/${manifest.arch}, not ${process.platform}/${process.arch}`);
    }
    validatePackageMetadata(this.packageDirectory(artifactId), manifest.version);
    if (expectedTreeDigest && manifest.treeDigest !== expectedTreeDigest) {
      throw new Error(`Shared artifact '${artifactId}' has different content`);
    }
    if (expectedTreeDigest || verifyTree) {
      const actualTreeDigest = computeTreeDigest(this.packageDirectory(artifactId));
      if (actualTreeDigest !== manifest.treeDigest) {
        throw new Error(`Shared artifact '${artifactId}' is corrupted`);
      }
    }
    return manifest;
  }

  writeHomeRef(ref: SharedHomeRef): void {
    validateHomeRef(ref);
    const releaseLock = this.acquireLock();
    try {
      writePrivateJson(this.homeRefFile(ref.homeId), ref);
    } finally {
      releaseLock();
    }
  }

  readHomeRef(homeId: string): SharedHomeRef | undefined {
    try {
      const refFile = this.homeRefFile(homeId);
      recoverFileReplacementSync(refFile);
      const value = JSON.parse(fs.readFileSync(refFile, "utf-8")) as unknown;
      return isSharedHomeRef(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  readAllHomeRefs(): SharedHomeRef[] {
    this.ensureDirectories();
    this.recoverHomeRefBackups();
    return fs.readdirSync(this.refsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => this.readHomeRef(entry.name.slice(0, -5)))
      .filter((item): item is SharedHomeRef => item !== undefined);
  }

  readAllHomeRefsStrict(): SharedHomeRef[] {
    this.ensureDirectories();
    this.recoverHomeRefBackups();
    return fs.readdirSync(this.refsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => {
        const homeId = entry.name.slice(0, -5);
        const ref = this.readHomeRef(homeId);
        if (!ref || ref.homeId !== homeId) throw new Error(`Invalid shared home ref: ${entry.name}`);
        return ref;
      });
  }

  homeRefFile(homeId: string): string {
    assertSafeIdentifier(homeId, "home id");
    return path.join(this.refsDirectory, `${homeId}.json`);
  }

  private recoverHomeRefBackups(): void {
    for (const entry of fs.readdirSync(this.refsDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json.replace-backup")) continue;
      recoverFileReplacementSync(path.join(this.refsDirectory, entry.name.slice(0, -".replace-backup".length)));
    }
  }

  stagingOwnerIsActive(stagingPath: string): boolean {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(stagingPath, STAGING_OWNER), "utf-8")) as {
        pid?: unknown;
        processStartMarker?: unknown;
      };
      if (!Number.isInteger(value.pid) || Number(value.pid) <= 0) return false;
      if (!isProcessAlive(Number(value.pid))) return false;
      if (typeof value.processStartMarker !== "string" || !value.processStartMarker) return true;
      return processStartMarkersMatch(value.processStartMarker, queryProcessStartMarker(Number(value.pid)));
    } catch {
      return false;
    }
  }
}

export function buildArtifactId(identity: ArtifactIdentity): string {
  for (const [label, value] of Object.entries(identity)) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`Artifact ${label} is empty`);
  }
  return [
    sanitizeToken(identity.version),
    `node${sanitizeToken(identity.nodeAbi)}`,
    sanitizeToken(identity.platform),
    sanitizeToken(identity.arch),
    digestToken(identity.sourceDigest),
    digestToken(identity.lockDigest),
  ].join("-");
}

export function buildImportedArtifactId(options: {
  sourceKind: "npm" | "seed" | "legacy";
  version: string;
  nodeAbi: string;
  platform: NodeJS.Platform;
  arch: string;
  treeDigest: string;
}): string {
  return [
    options.sourceKind,
    sanitizeToken(options.version),
    `node${sanitizeToken(options.nodeAbi)}`,
    sanitizeToken(options.platform),
    sanitizeToken(options.arch),
    digestToken(options.treeDigest),
  ].join("-");
}

export function createHomeId(homePath: string): string {
  const canonical = canonicalPath(homePath);
  const normalized = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return createHash("sha256").update(normalized).digest("hex");
}

export function computeTreeDigest(rootDirectory: string): string {
  const root = fs.realpathSync.native(rootDirectory);
  const hash = createHash("sha256");
  hash.update("niubot-tree-v1\0");
  visitTree(root, "", hash);
  return hash.digest("hex");
}

export function createSharedReleaseManifest(options: Omit<SharedReleaseManifest, "schemaVersion" | "packageName">): SharedReleaseManifest {
  const manifest: SharedReleaseManifest = {
    schemaVersion: SHARED_MANIFEST_SCHEMA_VERSION,
    packageName: PACKAGE_NAME,
    ...options,
  };
  validateManifestShape(manifest);
  return manifest;
}

function visitTree(root: string, relativeDirectory: string, hash: ReturnType<typeof createHash>): void {
  const directory = path.join(root, relativeDirectory);
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
    const normalized = relative.split(path.sep).join("/");
    const absolute = path.join(root, relative);
    const stats = fs.lstatSync(absolute);
    const executable = stats.mode & 0o111 ? "x" : "-";
    if (stats.isSymbolicLink()) {
      hash.update(`l\0${normalized}\0${executable}\0${fs.readlinkSync(absolute)}\0`);
    } else if (stats.isDirectory()) {
      hash.update(`d\0${normalized}\0${executable}\0`);
      visitTree(root, relative, hash);
    } else if (stats.isFile()) {
      const content = fs.readFileSync(absolute);
      hash.update(`f\0${normalized}\0${executable}\0${content.length}\0`);
      hash.update(content);
      hash.update("\0");
    } else {
      throw new Error(`Unsupported artifact entry: ${absolute}`);
    }
  }
}

function validatePackageMetadata(packageDirectory: string, expectedVersion: string): void {
  let pkg: { name?: string; version?: string };
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf-8")) as typeof pkg;
  } catch (err) {
    throw new Error(`Artifact package metadata is unavailable: ${errorMessage(err)}`);
  }
  if (pkg.name !== PACKAGE_NAME || pkg.version !== expectedVersion) {
    throw new Error(`Artifact package mismatch: ${pkg.name ?? "(missing)"}@${pkg.version ?? "(missing)"}`);
  }
}

function validateManifestShape(value: unknown): asserts value is SharedReleaseManifest {
  if (!isSharedReleaseManifest(value)) throw new Error("Invalid shared release manifest");
}

function isSharedReleaseManifest(value: unknown): value is SharedReleaseManifest {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item["schemaVersion"] === SHARED_MANIFEST_SCHEMA_VERSION
    && isSafeIdentifier(item["artifactId"])
    && item["packageName"] === PACKAGE_NAME
    && isNonEmptyString(item["version"])
    && ["npm", "source", "seed", "legacy"].includes(String(item["sourceKind"]))
    && isNonEmptyString(item["sourceDigest"])
    && (item["lockDigest"] === undefined || isNonEmptyString(item["lockDigest"]))
    && isHexDigest(item["treeDigest"])
    && isIsoDate(item["installedAt"])
    && isNonEmptyString(item["installerNodePath"])
    && isNonEmptyString(item["nodeVersion"])
    && isNonEmptyString(item["nodeAbi"])
    && isNonEmptyString(item["platform"])
    && isNonEmptyString(item["arch"]);
}

function validateHomeRef(ref: SharedHomeRef): void {
  if (!isSharedHomeRef(ref)) throw new Error("Invalid shared home ref");
  if (createHomeId(ref.homePath) !== ref.homeId) throw new Error("Shared home ref id does not match home path");
}

function isSharedHomeRef(value: unknown): value is SharedHomeRef {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item["schemaVersion"] === SHARED_HOME_REF_SCHEMA_VERSION
    && isSafeIdentifier(item["homeId"])
    && typeof item["homePath"] === "string"
    && path.isAbsolute(item["homePath"])
    && isReleaseSlots(item["active"])
    && (item["pending"] === undefined || isPendingHomeRef(item["pending"]))
    && Array.isArray(item["rollback"])
    && item["rollback"].every(isReleaseRef)
    && (item["runtimePath"] === undefined || (typeof item["runtimePath"] === "string" && path.isAbsolute(item["runtimePath"])))
    && isIsoDate(item["updatedAt"]);
}

function isReleaseSlots(value: unknown): value is ReleaseSlots {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return [item["current"], item["previous"], item["lastKnownGood"]]
    .every((ref) => ref === undefined || isReleaseRef(ref));
}

function isPendingHomeRef(value: unknown): value is PendingHomeRef {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return isSafeIdentifier(item["transactionId"])
    && Array.isArray(item["protected"])
    && item["protected"].every(isReleaseRef)
    && isIsoDate(item["updatedAt"]);
}

function writePrivateJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
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

function removeGroupAndOtherWriteBits(root: string): void {
  if (process.platform === "win32") return;
  const visit = (entryPath: string): void => {
    const stats = fs.lstatSync(entryPath);
    if (!stats.isSymbolicLink()) fs.chmodSync(entryPath, stats.mode & ~0o022);
    if (stats.isDirectory()) {
      for (const name of fs.readdirSync(entryPath)) visit(path.join(entryPath, name));
    }
  };
  visit(root);
}

function assertDirectChild(value: string, parent: string, label: string): string {
  const resolved = path.resolve(value);
  const resolvedParent = path.resolve(parent);
  if (path.dirname(resolved) !== resolvedParent) throw new Error(`${label} is outside the shared store`);
  if (fs.existsSync(resolvedParent) && fs.existsSync(resolved)
    && path.dirname(fs.realpathSync.native(resolved)) !== fs.realpathSync.native(resolvedParent)) {
    throw new Error(`${label} resolves outside the shared store`);
  }
  return resolved;
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!isSafeIdentifier(value)) throw new Error(`Invalid ${label}: ${value}`);
}

function sanitizeToken(value: string): string {
  const sanitized = value.replace(/[^0-9A-Za-z._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitized) throw new Error(`Invalid artifact token: ${value}`);
  return sanitized.slice(0, 80);
}

function digestToken(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isHexDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  const suffix: string[] = [];
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return resolved;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  try { return path.join(fs.realpathSync.native(existing), ...suffix); } catch { return resolved; }
}

function syncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {
    // Directory fsync is not available on every platform/filesystem.
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hashFile(filePath: string): string {
  return createHash("sha512").update(fs.readFileSync(filePath)).digest("hex");
}

function blockingDelay(milliseconds: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}
