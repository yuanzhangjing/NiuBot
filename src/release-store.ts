import fs from "node:fs";
import path from "node:path";
import { replaceFileSync } from "./platform/files.js";

export const RELEASE_STATE_SCHEMA_VERSION = 1;

export interface ReleaseState {
  schemaVersion: typeof RELEASE_STATE_SCHEMA_VERSION;
  current?: string;
  previous?: string;
  lastKnownGood?: string;
}

export class ReleaseStore {
  readonly releasesDirectory: string;
  readonly packagesDirectory: string;
  readonly stateFile: string;

  constructor(readonly botDirectory: string) {
    this.releasesDirectory = path.join(botDirectory, "releases");
    this.packagesDirectory = path.join(botDirectory, "packages");
    this.stateFile = path.join(this.releasesDirectory, "state.json");
  }

  ensureDirectories(): void {
    fs.mkdirSync(this.releasesDirectory, { recursive: true });
    fs.mkdirSync(this.packagesDirectory, { recursive: true });
  }

  readState(): ReleaseState {
    try {
      const value = JSON.parse(fs.readFileSync(this.stateFile, "utf-8")) as unknown;
      if (isReleaseState(value)) return value;
    } catch {
      // Missing state is a valid empty store.
    }
    return { schemaVersion: RELEASE_STATE_SCHEMA_VERSION };
  }

  writeState(state: ReleaseState): void {
    this.ensureDirectories();
    if (!isReleaseState(state)) throw new Error("Invalid release state");
    for (const id of [state.current, state.previous, state.lastKnownGood]) {
      if (id) this.assertReleaseId(id);
    }
    const tempFile = path.join(this.releasesDirectory, `.state.${process.pid}.${Date.now()}.tmp`);
    const fd = fs.openSync(tempFile, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      replaceFileSync(tempFile, this.stateFile);
    } catch (err) {
      try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
      throw err;
    }
  }

  releaseDirectory(id: string): string {
    this.assertReleaseId(id);
    return path.join(this.releasesDirectory, id);
  }

  packageDirectory(id: string): string {
    return path.join(this.releaseDirectory(id), "package");
  }

  activate(id: string): ReleaseState {
    this.assertUsableRelease(id);
    const state = this.readState();
    const next: ReleaseState = {
      schemaVersion: RELEASE_STATE_SCHEMA_VERSION,
      current: id,
      previous: state.lastKnownGood ?? state.current,
      lastKnownGood: state.lastKnownGood,
    };
    this.writeState(next);
    return next;
  }

  markLastKnownGood(id: string): ReleaseState {
    this.assertUsableRelease(id);
    const state = this.readState();
    const next = { ...state, current: id, lastKnownGood: id };
    this.writeState(next);
    return next;
  }

  restoreLastKnownGood(): string | undefined {
    const state = this.readState();
    if (!state.lastKnownGood) return undefined;
    this.assertUsableRelease(state.lastKnownGood);
    this.writeState({ ...state, current: state.lastKnownGood });
    return state.lastKnownGood;
  }

  migrateLegacyLinks(): ReleaseState {
    const existing = this.readState();
    if (existing.current || existing.previous || existing.lastKnownGood) return existing;
    const state: ReleaseState = {
      schemaVersion: RELEASE_STATE_SCHEMA_VERSION,
      current: this.readLegacyLink("current"),
      previous: this.readLegacyLink("previous"),
      lastKnownGood: this.readLegacyLink("last-known-good"),
    };
    if (state.current || state.previous || state.lastKnownGood) this.writeState(state);
    return state;
  }

  cleanup(options: { protectedRuntimePaths?: string[]; keepRecent?: number; keepPackages?: number } = {}): void {
    this.ensureDirectories();
    const state = this.readState();
    const protectedIds = new Set([state.current, state.previous, state.lastKnownGood].filter(Boolean));
    for (const runtimePath of options.protectedRuntimePaths ?? []) {
      const id = this.releaseIdFromRuntimePath(runtimePath);
      if (id) protectedIds.add(id);
    }

    const releases = fs.readdirSync(this.releasesDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));
    let recentKept = 0;
    for (const id of releases) {
      if (protectedIds.has(id)) continue;
      recentKept++;
      if (recentKept <= (options.keepRecent ?? 3)) continue;
      try { fs.rmSync(this.releaseDirectory(id), { recursive: true, force: true }); } catch { /* retry next cleanup */ }
    }

    const packages = fs.readdirSync(this.packagesDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));
    for (const file of packages.slice(options.keepPackages ?? 5)) {
      try { fs.rmSync(path.join(this.packagesDirectory, file), { force: true }); } catch { /* retry next cleanup */ }
    }
  }

  private assertUsableRelease(id: string): void {
    const packageJson = path.join(this.packageDirectory(id), "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJson, "utf-8")) as { name?: string; version?: string };
      if (pkg.name !== "@yuanzhangjing/niubot" || !pkg.version) throw new Error("metadata mismatch");
    } catch (err) {
      throw new Error(`Release '${id}' is not usable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private readLegacyLink(name: string): string | undefined {
    const link = path.join(this.botDirectory, name);
    try {
      const target = fs.realpathSync(link);
      const relative = path.relative(fs.realpathSync(this.releasesDirectory), target);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) return undefined;
      this.assertUsableRelease(relative);
      return relative;
    } catch {
      return undefined;
    }
  }

  private releaseIdFromRuntimePath(runtimePath: string): string | undefined {
    const releasesDirectory = canonicalPath(this.releasesDirectory);
    const relative = path.relative(releasesDirectory, canonicalPath(runtimePath));
    const parts = relative.split(path.sep);
    if (parts.length >= 2 && parts[1] === "package" && parts[0] && !parts[0].startsWith("..")) {
      return parts[0];
    }
    return undefined;
  }

  private assertReleaseId(id: string): void {
    if (!id || id === "." || id === ".." || id.includes("/") || id.includes("\\") || path.basename(id) !== id) {
      throw new Error(`Invalid release id: ${id}`);
    }
  }
}

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function isReleaseState(value: unknown): value is ReleaseState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  if (state["schemaVersion"] !== RELEASE_STATE_SCHEMA_VERSION) return false;
  return [state["current"], state["previous"], state["lastKnownGood"]]
    .every((item) => item === undefined || typeof item === "string");
}
