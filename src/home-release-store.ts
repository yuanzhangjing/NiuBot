import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { recoverFileReplacementSync, replaceFileSync } from "./platform/files.js";
import { isReleaseRef, sameReleaseRef, type NodeRuntimeRef, type ReleaseRef } from "./release-ref.js";
import { ReleaseStore, type ReleaseState } from "./release-store.js";
import type { RestartDatabaseSnapshot } from "./database/restart-snapshot.js";
import { isProcessAlive, processStartMarkersMatch, queryProcessStartMarker } from "./platform/process.js";
import { createHomeId, type SharedHomeRef, SharedReleaseStore } from "./shared-release-store.js";

// Keep schema 2 for rollback compatibility: released 0.2.x runtimes accept
// missing previous/LKG slots and ignore unknown stable-state fields.
export const HOME_RELEASE_STATE_SCHEMA_VERSION = 2;

export interface UnresolvedLegacyRelease {
  runtimePath: string;
  reason: string;
}

export interface HomeReleaseState {
  schemaVersion: typeof HOME_RELEASE_STATE_SCHEMA_VERSION;
  current?: ReleaseRef;
  rejectedRecommendation?: RejectedRecommendation;
  unresolvedLegacy?: UnresolvedLegacyRelease[];
  firstSharedSuccessAt?: string;
  sharedSuccessfulStarts?: number;
  transaction?: HomeReleaseTransaction;
}

export interface HomeReleaseTransaction {
  transactionId: string;
  phase: "activating";
  candidate: ReleaseRef;
  rollbackCurrent?: ReleaseRef;
  ownerPid?: number;
  ownerStartMarker?: string;
  databaseSnapshot?: RestartDatabaseSnapshot;
}

export interface RejectedRecommendation {
  generation: number;
  artifactId: string;
  failedAt: string;
  reason?: string;
}

interface HomeReleaseStateV2 {
  schemaVersion: typeof HOME_RELEASE_STATE_SCHEMA_VERSION;
  current?: ReleaseRef;
  previous?: ReleaseRef;
  lastKnownGood?: ReleaseRef;
  unresolvedLegacy?: UnresolvedLegacyRelease[];
  firstSharedSuccessAt?: string;
  sharedSuccessfulStarts?: number;
  transaction?: {
    transactionId: string;
    phase: "activating";
    candidate: ReleaseRef;
    rollback: { current?: ReleaseRef; previous?: ReleaseRef; lastKnownGood?: ReleaseRef };
    ownerPid?: number;
    ownerStartMarker?: string;
    databaseSnapshot?: RestartDatabaseSnapshot;
  };
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
    let value: unknown;
    try {
      recoverFileReplacementSync(this.stateFile);
      value = JSON.parse(fs.readFileSync(this.stateFile, "utf-8")) as unknown;
    } catch {
      // An absent state is valid before lazy migration/bootstrap.
      return { schemaVersion: HOME_RELEASE_STATE_SCHEMA_VERSION };
    }
    if (isHomeReleaseState(value)) return value;
    // Do not hide a failed compatibility migration as an empty home. A write
    // or reference failure here must stop activation instead of discarding the
    // only known-good selection in memory.
    if (isHomeReleaseStateV2(value)) return this.migrateV2State(value);
    return { schemaVersion: HOME_RELEASE_STATE_SCHEMA_VERSION };
  }

  stateExistsRecovering(): boolean {
    recoverFileReplacementSync(this.stateFile);
    return fs.existsSync(this.stateFile);
  }

  readStateStrict(options: { persistMigration?: boolean } = {}): HomeReleaseState {
    recoverFileReplacementSync(this.stateFile);
    const value = JSON.parse(fs.readFileSync(this.stateFile, "utf-8")) as unknown;
    if (isHomeReleaseState(value)) return value;
    if (isHomeReleaseStateV2(value)) {
      return options.persistMigration === false ? this.normalizeV2State(value) : this.migrateV2State(value);
    }
    throw new Error(`Invalid home release state: ${this.stateFile}`);
  }

  readOrMigrateLegacy(
    node: NodeRuntimeRef,
    running?: LegacyMigrationRuntime,
    verify: (runtimePath: string, node: NodeRuntimeRef) => boolean = verifyLegacyRuntime,
  ): HomeReleaseState {
    recoverFileReplacementSync(this.stateFile);
    if (fs.existsSync(this.stateFile)) {
      const value = JSON.parse(fs.readFileSync(this.stateFile, "utf-8")) as unknown;
      if (isHomeReleaseState(value)) return value;
      if (isHomeReleaseStateV2(value)) return this.migrateV2State(value, running?.runtimePath);
      throw new Error(`Invalid home release state: ${this.stateFile}`);
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
      current: selectLegacyReleaseRef(selected.state, running?.runtimePath, selected.botDirectory, toRef),
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
      current: state.transaction.rollbackCurrent ?? state.current,
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

  writeState(input: HomeReleaseState | HomeReleaseStateV2): void {
    const state = isHomeReleaseState(input)
      ? input
      : isHomeReleaseStateV2(input)
        ? this.normalizeV2State(input)
        : undefined;
    if (!state) throw new Error("Invalid home release state");
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

  commitHealthy(ref: ReleaseRef): HomeReleaseState {
    this.resolveRuntime(ref);
    const state = this.readStateStrict();
    const firstSharedSuccessAt = ref.storage === "shared"
      ? state.firstSharedSuccessAt ?? new Date().toISOString()
      : state.firstSharedSuccessAt;
    const next: HomeReleaseState = {
      ...state,
      current: ref,
      transaction: undefined,
      rejectedRecommendation: undefined,
      firstSharedSuccessAt,
      sharedSuccessfulStarts: ref.storage === "shared" ? (state.sharedSuccessfulStarts ?? 0) + 1 : state.sharedSuccessfulStarts,
    };
    this.writeState(next);
    return next;
  }

  recordRejectedRecommendation(generation: number, release: ReleaseRef & { storage: "shared" }, reason?: string): HomeReleaseState {
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error("Invalid recommendation generation");
    this.resolveRuntime(release, true);
    const state = this.readStateStrict();
    const next: HomeReleaseState = {
      ...state,
      rejectedRecommendation: {
        generation,
        artifactId: release.artifactId,
        failedAt: new Date().toISOString(),
        reason,
      },
      transaction: undefined,
    };
    this.writeState(next);
    return next;
  }

  /**
   * Replace storage references after an installed legacy tree has been copied
   * byte-for-byte into the shared store. This is a storage migration, not a
   * version activation: slot meaning and ordering must remain unchanged.
   */
  replaceEquivalentRelease(expected: ReleaseRef, replacement: ReleaseRef): HomeReleaseState {
    this.resolveRuntime(expected, true);
    this.resolveRuntime(replacement, true);
    const state = this.readStateStrict();
    if (state.transaction) {
      throw new Error(`Cannot migrate runtime storage during transaction '${state.transaction.transactionId}'`);
    }
    if (!sameReleaseRef(state.current, expected)) {
      throw new Error("Current release changed before equivalent runtime migration completed");
    }
    const next: HomeReleaseState = {
      ...state,
      current: replacement,
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

  private migrateV2State(state: HomeReleaseStateV2, runningRuntimePath?: string): HomeReleaseState {
    const next = this.normalizeV2State(state, runningRuntimePath);
    // A released worker may still own and update the old transaction shape.
    // Rewriting it underneath that process would make the old worker unable to
    // read its own state. Normalize in memory only until the owner exits.
    if (next.transaction && this.transactionOwnerIsActive(next.transaction)) return next;
    this.writeState(next);
    this.writeSharedRef({ state: next });
    return next;
  }

  private normalizeV2State(state: HomeReleaseStateV2, runningRuntimePath?: string): HomeReleaseState {
    const candidates = [state.current, state.lastKnownGood, state.previous];
    const running = runningRuntimePath
      ? candidates.find((ref) => ref && sameRuntimePath(this, ref, runningRuntimePath))
      : undefined;
    const current = running ?? candidates.find((ref) => ref && isUsableRef(this, ref));
    const transaction = state.transaction ? {
      transactionId: state.transaction.transactionId,
      phase: "activating" as const,
      candidate: state.transaction.candidate,
      rollbackCurrent: state.transaction.rollback.current
        ?? state.transaction.rollback.lastKnownGood
        ?? state.transaction.rollback.previous
        ?? current,
      ownerPid: state.transaction.ownerPid,
      ownerStartMarker: state.transaction.ownerStartMarker,
      databaseSnapshot: state.transaction.databaseSnapshot,
    } : undefined;
    return {
      schemaVersion: HOME_RELEASE_STATE_SCHEMA_VERSION,
      current,
      unresolvedLegacy: state.unresolvedLegacy,
      firstSharedSuccessAt: state.firstSharedSuccessAt,
      sharedSuccessfulStarts: state.sharedSuccessfulStarts,
      transaction,
    };
  }
}

export function isHomeReleaseState(value: unknown): value is HomeReleaseState {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item["schemaVersion"] === HOME_RELEASE_STATE_SCHEMA_VERSION
    && !("previous" in item)
    && !("lastKnownGood" in item)
    && (item["current"] === undefined || isReleaseRef(item["current"]))
    && (item["rejectedRecommendation"] === undefined || isRejectedRecommendation(item["rejectedRecommendation"]))
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
  return [state.current, state.transaction?.candidate, state.transaction?.rollbackCurrent]
    .filter((ref): ref is ReleaseRef => ref !== undefined);
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
    && !("rollback" in item)
    && isReleaseRef(item["candidate"])
    && (item["rollbackCurrent"] === undefined || isReleaseRef(item["rollbackCurrent"]))
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

function isHomeReleaseStateV2(value: unknown): value is HomeReleaseStateV2 {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item["schemaVersion"] === 2
    && ("previous" in item || "lastKnownGood" in item || isHomeReleaseTransactionV2(item["transaction"]))
    && [item["current"], item["previous"], item["lastKnownGood"]].every((ref) => ref === undefined || isReleaseRef(ref))
    && (item["transaction"] === undefined || isHomeReleaseTransactionV2(item["transaction"]));
}

function isHomeReleaseTransactionV2(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item["transactionId"] === "string" && item["phase"] === "activating"
    && isReleaseRef(item["candidate"])
    && Boolean(item["rollback"] && typeof item["rollback"] === "object")
    && Object.values(item["rollback"] as Record<string, unknown>).every((ref) => ref === undefined || isReleaseRef(ref))
    && (item["ownerPid"] === undefined || (Number.isInteger(item["ownerPid"]) && Number(item["ownerPid"]) > 0))
    && (item["ownerStartMarker"] === undefined || typeof item["ownerStartMarker"] === "string")
    && (item["databaseSnapshot"] === undefined || isDatabaseSnapshot(item["databaseSnapshot"]));
}

function isRejectedRecommendation(value: unknown): value is RejectedRecommendation {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return Number.isSafeInteger(item["generation"]) && Number(item["generation"]) > 0
    && typeof item["artifactId"] === "string" && item["artifactId"].length > 0
    && isIsoDate(item["failedAt"])
    && (item["reason"] === undefined || typeof item["reason"] === "string");
}

function isUsableRef(store: HomeReleaseStore, ref: ReleaseRef): boolean {
  try { store.resolveRuntime(ref); return true; } catch { return false; }
}

function sameRuntimePath(store: HomeReleaseStore, ref: ReleaseRef, runtimePath: string): boolean {
  try { return sameCanonicalPath(store.resolveRuntime(ref), runtimePath); } catch { return false; }
}

function selectLegacyReleaseRef(
  state: ReleaseState,
  runningRuntimePath: string | undefined,
  botDirectory: string,
  toRef: (id: string | undefined) => ReleaseRef | undefined,
): ReleaseRef | undefined {
  const ids = [state.current, state.lastKnownGood, state.previous];
  if (runningRuntimePath) {
    const running = ids.find((id) => id && sameCanonicalPath(path.join(botDirectory, "releases", id, "package"), runningRuntimePath));
    const ref = toRef(running);
    if (ref) return ref;
  }
  for (const id of ids) {
    const ref = toRef(id);
    if (ref) return ref;
  }
  return undefined;
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
