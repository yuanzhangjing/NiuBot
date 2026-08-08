import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { recoverFileReplacementSync, replaceFileSync } from "./platform/files.js";
import { isReleaseRef, type NodeRuntimeRef, type ReleaseRef, type ReleaseSlots } from "./release-ref.js";
import { ReleaseStore, type ReleaseState } from "./release-store.js";
import type { RestartDatabaseSnapshot } from "./database/restart-snapshot.js";
import { isProcessAlive, processStartMarkersMatch, queryProcessStartMarker } from "./platform/process.js";
import { createHomeId, type SharedHomeRef, SharedReleaseStore } from "./shared-release-store.js";

export const HOME_RELEASE_STATE_SCHEMA_VERSION = 2;

export interface UnresolvedLegacyRelease {
  runtimePath: string;
  reason: string;
}

export interface HomeReleaseState extends ReleaseSlots {
  schemaVersion: typeof HOME_RELEASE_STATE_SCHEMA_VERSION;
  unresolvedLegacy?: UnresolvedLegacyRelease[];
  firstSharedSuccessAt?: string;
  sharedSuccessfulStarts?: number;
  transaction?: HomeReleaseTransaction;
}

export interface HomeReleaseTransaction {
  transactionId: string;
  phase: "activating";
  candidate: ReleaseRef;
  rollback: ReleaseSlots;
  ownerPid?: number;
  ownerStartMarker?: string;
  databaseSnapshot?: RestartDatabaseSnapshot;
}

export interface LegacyMigrationRuntime {
  runtimePath: string;
  node: NodeRuntimeRef;
}

export class HomeReleaseStore {
  readonly runtimeDirectory: string;
  readonly stateFile: string;
  readonly homeId: string;

  constructor(
    readonly niubotHome: string,
    readonly sharedStore: SharedReleaseStore,
  ) {
    this.niubotHome = canonicalPath(niubotHome);
    this.runtimeDirectory = path.join(this.niubotHome, "runtime");
    this.stateFile = path.join(this.runtimeDirectory, "release-state.json");
    this.homeId = createHomeId(this.niubotHome);
  }

  readState(): HomeReleaseState {
    try {
      recoverFileReplacementSync(this.stateFile);
      const value = JSON.parse(fs.readFileSync(this.stateFile, "utf-8")) as unknown;
      if (isHomeReleaseState(value)) return value;
    } catch {
      // An absent state is valid before lazy migration/bootstrap.
    }
    return { schemaVersion: HOME_RELEASE_STATE_SCHEMA_VERSION };
  }

  stateExistsRecovering(): boolean {
    recoverFileReplacementSync(this.stateFile);
    return fs.existsSync(this.stateFile);
  }

  readStateStrict(): HomeReleaseState {
    recoverFileReplacementSync(this.stateFile);
    const value = JSON.parse(fs.readFileSync(this.stateFile, "utf-8")) as unknown;
    if (!isHomeReleaseState(value)) throw new Error(`Invalid home release state: ${this.stateFile}`);
    return value;
  }

  readOrMigrateLegacy(
    node: NodeRuntimeRef,
    running?: LegacyMigrationRuntime,
    verify: (runtimePath: string, node: NodeRuntimeRef) => boolean = verifyLegacyRuntime,
  ): HomeReleaseState {
    recoverFileReplacementSync(this.stateFile);
    if (fs.existsSync(this.stateFile)) {
      const value = JSON.parse(fs.readFileSync(this.stateFile, "utf-8")) as unknown;
      if (!isHomeReleaseState(value)) throw new Error(`Invalid home release state: ${this.stateFile}`);
      return value;
    }
    const migrated = this.migrateLegacyState(node, running, verify);
    if (migrated) return migrated;
    return { schemaVersion: HOME_RELEASE_STATE_SCHEMA_VERSION };
  }

  migrateLegacyState(
    node: NodeRuntimeRef,
    running?: LegacyMigrationRuntime,
    verify: (runtimePath: string, node: NodeRuntimeRef) => boolean = verifyLegacyRuntime,
  ): HomeReleaseState | undefined {
    const candidates: Array<{ botDirectory: string; state: ReleaseState }> = [];
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(this.niubotHome, { withFileTypes: true }); } catch { /* empty home */ }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const botDirectory = path.join(this.niubotHome, entry.name);
      const legacy = new ReleaseStore(botDirectory);
      if (!legacy.stateExistsRecovering()
        && !["current", "previous", "last-known-good"].some((name) => fs.existsSync(path.join(botDirectory, name)))) continue;
      const state = legacy.migrateLegacyLinks();
      if (state.current || state.previous || state.lastKnownGood) candidates.push({ botDirectory, state });
    }
    if (candidates.length === 0) return undefined;
    const selected = selectLegacyStore(candidates, running?.runtimePath);
    const unresolved: UnresolvedLegacyRelease[] = [];
    const toRef = (id: string | undefined): ReleaseRef | undefined => {
      if (!id) return undefined;
      const runtimePath = path.join(selected.botDirectory, "releases", id, "package");
      const selectedNode = running && sameCanonicalPath(runtimePath, running.runtimePath) ? running.node : node;
      const ref = this.releaseRefForRuntimePath(runtimePath, selectedNode);
      if (!ref) return undefined;
      if (!running || !sameCanonicalPath(runtimePath, running.runtimePath)) {
        if (!verify(runtimePath, selectedNode)) {
          unresolved.push({ runtimePath: canonicalPath(runtimePath), reason: "legacy release failed Node/native compatibility verification" });
          return undefined;
        }
      }
      return ref;
    };
    const state: HomeReleaseState = {
      schemaVersion: HOME_RELEASE_STATE_SCHEMA_VERSION,
      current: toRef(selected.state.current),
      previous: toRef(selected.state.previous),
      lastKnownGood: toRef(selected.state.lastKnownGood),
    };
    if (unresolved.length) state.unresolvedLegacy = unresolved;
    this.writeState(state);
    this.writeSharedRef({ state });
    return state;
  }

  reconcileInterruptedTransaction(state = this.readState()): HomeReleaseState {
    if (!state.transaction) return state;
    if (this.transactionOwnerIsActive(state.transaction)) {
      throw new Error(`NiuBot runtime transaction '${state.transaction.transactionId}' is still active`);
    }
    const next: HomeReleaseState = {
      ...state,
      ...state.transaction.rollback,
      transaction: undefined,
    };
    this.writeState(next);
    this.writeSharedRef({ state: next });
    return next;
  }

  transactionOwnerIsActive(transaction: HomeReleaseTransaction): boolean {
    if (!transaction.ownerPid || !isProcessAlive(transaction.ownerPid)) return false;
    if (!transaction.ownerStartMarker) return true;
    return processStartMarkersMatch(transaction.ownerStartMarker, queryProcessStartMarker(transaction.ownerPid));
  }

  assertTransactionSnapshotContained(snapshot: RestartDatabaseSnapshot): void {
    const root = canonicalPath(snapshot.rootDirectory);
    const relative = path.relative(this.niubotHome, root);
    const parts = relative.split(path.sep);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)
      || parts.length < 4 || parts[1] !== "restart" || parts[2] !== "database-snapshots") {
      throw new Error(`Transaction snapshot is outside NIUBOT_HOME restart storage: ${snapshot.rootDirectory}`);
    }
    for (const filePath of [snapshot.manifestPath, ...snapshot.records.map((record) => record.rollbackPath).filter((item): item is string => Boolean(item))]) {
      const child = canonicalPath(filePath);
      const childRelative = path.relative(root, child);
      if (path.isAbsolute(childRelative) || childRelative === ".." || childRelative.startsWith(`..${path.sep}`)) {
        throw new Error(`Transaction snapshot file is outside its root: ${filePath}`);
      }
    }
  }

  writeState(state: HomeReleaseState): void {
    if (!isHomeReleaseState(state)) throw new Error("Invalid home release state");
    for (const ref of releaseRefs(state)) this.assertResolvableRef(ref);
    fs.mkdirSync(this.runtimeDirectory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.runtimeDirectory, `.release-state.${process.pid}.${randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      replaceFileSync(temporary, this.stateFile);
    } catch (err) {
      try { fs.unlinkSync(temporary); } catch { /* ignore */ }
      throw err;
    }
  }

  resolveRuntime(ref: ReleaseRef, verifyTree = false): string {
    this.assertNodeRuntime(ref.node);
    if (ref.storage === "shared") {
      const manifest = this.sharedStore.assertUsableArtifact(ref.artifactId, undefined, verifyTree);
      if (manifest.nodeAbi !== ref.node.nodeAbi) {
        throw new Error(`Shared artifact Node ABI ${manifest.nodeAbi} does not match runtime ABI ${ref.node.nodeAbi}`);
      }
      return this.sharedStore.packageDirectory(ref.artifactId);
    }
    this.assertLegacyRuntimePath(ref.runtimePath);
    validatePackage(ref.runtimePath);
    return canonicalPath(ref.runtimePath);
  }

  releaseRefForRuntimePath(runtimePath: string, node: NodeRuntimeRef): ReleaseRef | undefined {
    const artifactId = this.sharedStore.artifactIdForRuntimePath(runtimePath);
    if (artifactId) {
      const ref: ReleaseRef = { storage: "shared", artifactId, node };
      this.resolveRuntime(ref);
      return ref;
    }
    try {
      this.assertLegacyRuntimePath(runtimePath);
      validatePackage(runtimePath);
      return { storage: "legacy", runtimePath: canonicalPath(runtimePath), node };
    } catch {
      return undefined;
    }
  }

  discoverUnresolvedLegacy(excludeRuntimePaths: string[] = []): UnresolvedLegacyRelease[] {
    const excluded = new Set(excludeRuntimePaths.map(canonicalPath));
    const result: UnresolvedLegacyRelease[] = [];
    let botEntries: fs.Dirent[];
    try { botEntries = fs.readdirSync(this.niubotHome, { withFileTypes: true }); } catch { return result; }
    for (const bot of botEntries) {
      if (!bot.isDirectory()) continue;
      const releasesDirectory = path.join(this.niubotHome, bot.name, "releases");
      let releases: fs.Dirent[];
      try { releases = fs.readdirSync(releasesDirectory, { withFileTypes: true }); } catch { continue; }
      for (const release of releases) {
        if (!release.isDirectory()) continue;
        const runtimePath = path.join(releasesDirectory, release.name, "package");
        if (!fs.existsSync(path.join(runtimePath, "package.json"))) continue;
        const canonical = canonicalPath(runtimePath);
        if (excluded.has(canonical)) continue;
        result.push({
          runtimePath: canonical,
          reason: "legacy release has no verified Node runtime binding",
        });
      }
    }
    return result.sort((left, right) => left.runtimePath.localeCompare(right.runtimePath));
  }

  activate(ref: ReleaseRef): HomeReleaseState {
    this.resolveRuntime(ref);
    const state = this.readState();
    const next: HomeReleaseState = {
      ...state,
      schemaVersion: HOME_RELEASE_STATE_SCHEMA_VERSION,
      current: ref,
      previous: state.lastKnownGood ?? state.current,
    };
    this.writeState(next);
    return next;
  }

  markLastKnownGood(ref: ReleaseRef): HomeReleaseState {
    this.resolveRuntime(ref);
    const state = this.readState();
    const firstSharedSuccessAt = ref.storage === "shared"
      ? state.firstSharedSuccessAt ?? new Date().toISOString()
      : state.firstSharedSuccessAt;
    const next: HomeReleaseState = {
      ...state,
      current: ref,
      lastKnownGood: ref,
      transaction: undefined,
      firstSharedSuccessAt,
      sharedSuccessfulStarts: ref.storage === "shared" ? (state.sharedSuccessfulStarts ?? 0) + 1 : state.sharedSuccessfulStarts,
    };
    this.writeState(next);
    return next;
  }

  writeSharedRef(options: {
    state?: HomeReleaseState;
    pending?: SharedHomeRef["pending"];
    rollback?: ReleaseRef[];
    runtimePath?: string;
  } = {}): void {
    const state = options.state ?? this.readState();
    this.sharedStore.writeHomeRef({
      schemaVersion: 1,
      homeId: this.homeId,
      homePath: this.niubotHome,
      active: {
        current: state.current,
        previous: state.previous,
        lastKnownGood: state.lastKnownGood,
      },
      pending: options.pending,
      rollback: options.rollback ?? [],
      runtimePath: options.runtimePath,
      updatedAt: new Date().toISOString(),
    });
  }

  private assertResolvableRef(ref: ReleaseRef): void {
    this.resolveRuntime(ref);
  }

  private assertNodeRuntime(node: NodeRuntimeRef): void {
    if (!fs.existsSync(node.nodePath)) throw new Error(`Node runtime is unavailable: ${node.nodePath}`);
  }

  private assertLegacyRuntimePath(runtimePath: string): void {
    const canonical = canonicalPath(runtimePath);
    const relative = path.relative(this.niubotHome, canonical);
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error(`Legacy runtime is outside NIUBOT_HOME: ${runtimePath}`);
    }
    const parts = relative.split(path.sep);
    if (parts.length !== 4 || parts[1] !== "releases" || parts[3] !== "package") {
      throw new Error(`Legacy runtime does not match the managed release layout: ${runtimePath}`);
    }
  }
}

export function isHomeReleaseState(value: unknown): value is HomeReleaseState {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item["schemaVersion"] === HOME_RELEASE_STATE_SCHEMA_VERSION
    && [item["current"], item["previous"], item["lastKnownGood"]]
      .every((ref) => ref === undefined || isReleaseRef(ref))
    && (item["unresolvedLegacy"] === undefined || (
      Array.isArray(item["unresolvedLegacy"])
      && item["unresolvedLegacy"].every(isUnresolvedLegacyRelease)
    ))
    && (item["firstSharedSuccessAt"] === undefined || isIsoDate(item["firstSharedSuccessAt"]))
    && (item["sharedSuccessfulStarts"] === undefined || (
      Number.isInteger(item["sharedSuccessfulStarts"])
      && Number(item["sharedSuccessfulStarts"]) >= 0
    ))
    && (item["transaction"] === undefined || isHomeReleaseTransaction(item["transaction"]));
}

function releaseRefs(state: HomeReleaseState): ReleaseRef[] {
  return [state.current, state.previous, state.lastKnownGood].filter((ref): ref is ReleaseRef => ref !== undefined);
}

function isUnresolvedLegacyRelease(value: unknown): value is UnresolvedLegacyRelease {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item["runtimePath"] === "string"
    && path.isAbsolute(item["runtimePath"])
    && typeof item["reason"] === "string";
}

function isHomeReleaseTransaction(value: unknown): value is HomeReleaseTransaction {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item["transactionId"] === "string"
    && item["transactionId"].length > 0
    && item["phase"] === "activating"
    && isReleaseRef(item["candidate"])
    && isReleaseSlots(item["rollback"])
    && (item["ownerPid"] === undefined || (Number.isInteger(item["ownerPid"]) && Number(item["ownerPid"]) > 0))
    && (item["ownerStartMarker"] === undefined || typeof item["ownerStartMarker"] === "string")
    && (item["databaseSnapshot"] === undefined || isDatabaseSnapshot(item["databaseSnapshot"]));
}

function isDatabaseSnapshot(value: unknown): value is RestartDatabaseSnapshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item["rootDirectory"] === "string"
    && path.isAbsolute(item["rootDirectory"])
    && typeof item["manifestPath"] === "string"
    && path.isAbsolute(item["manifestPath"])
    && Array.isArray(item["records"])
    && item["records"].every((record) => {
      if (!record || typeof record !== "object") return false;
      const entry = record as Record<string, unknown>;
      return typeof entry["databasePath"] === "string"
        && path.isAbsolute(entry["databasePath"])
        && typeof entry["existed"] === "boolean"
        && (entry["rollbackPath"] === undefined || (typeof entry["rollbackPath"] === "string" && path.isAbsolute(entry["rollbackPath"])))
        && (entry["mode"] === undefined || Number.isInteger(entry["mode"]));
    });
}

function isReleaseSlots(value: unknown): value is ReleaseSlots {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return [item["current"], item["previous"], item["lastKnownGood"]]
    .every((ref) => ref === undefined || isReleaseRef(ref));
}

function isValidLegacyPackage(runtimePath: string): boolean {
  try { validatePackage(runtimePath); return true; } catch { return false; }
}

function selectLegacyStore(
  candidates: Array<{ botDirectory: string; state: ReleaseState }>,
  runningRuntimePath?: string,
): { botDirectory: string; state: ReleaseState } {
  if (runningRuntimePath) {
    const running = candidates.find((candidate) => [candidate.state.current, candidate.state.previous, candidate.state.lastKnownGood]
      .some((id) => id && sameCanonicalPath(path.join(candidate.botDirectory, "releases", id, "package"), runningRuntimePath)));
    if (running) return running;
  }
  return candidates.find((candidate) => candidate.state.lastKnownGood)
    ?? candidates.find((candidate) => candidate.state.current)
    ?? candidates[0]!;
}

function verifyLegacyRuntime(runtimePath: string, node: NodeRuntimeRef): boolean {
  const packageJson = path.join(runtimePath, "package.json");
  const script = [
    "const {createRequire}=require('node:module');",
    "const requireFromPackage=createRequire(process.argv[1]);",
    "const Database=requireFromPackage('better-sqlite3');",
    "const db=new Database(':memory:');db.close();",
  ].join("");
  const result = spawnSync(node.nodePath, ["-e", script, packageJson], {
    encoding: "utf-8",
    windowsHide: true,
    timeout: 15_000,
  });
  return !result.error && result.status === 0;
}

function sameCanonicalPath(left: string, right: string): boolean {
  const a = canonicalPath(left);
  const b = canonicalPath(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function validatePackage(runtimePath: string): void {
  const value = JSON.parse(fs.readFileSync(path.join(runtimePath, "package.json"), "utf-8")) as {
    name?: string;
    version?: string;
  };
  if (value.name !== "@yuanzhangjing/niubot" || !value.version) {
    throw new Error(`Invalid NiuBot package at ${runtimePath}`);
  }
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

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
