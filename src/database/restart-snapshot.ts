import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { NiuBotConfig } from "../config.js";
import { removeFileSync, replaceFileSync, samePlatformPath } from "../platform/files.js";

export const PREFLIGHT_DATABASE_MANIFEST_ENV = "NIUBOT_PREFLIGHT_DATABASE_MANIFEST";

interface SnapshotRecord {
  databasePath: string;
  existed: boolean;
  rollbackPath?: string;
  mode?: number;
}

interface PreflightDatabaseManifest {
  schemaVersion: 1;
  mappings: Array<{
    sourcePath: string;
    preflightPath: string;
  }>;
}

export interface RestartDatabaseSnapshot {
  rootDirectory: string;
  manifestPath: string;
  records: SnapshotRecord[];
}

export function assertDatabasesAtCompatibleSchemaVersion(
  databasePaths: string[],
  compatibleVersions: readonly number[],
  candidateSchemaVersion: number,
): void {
  if (!compatibleVersions.includes(candidateSchemaVersion)) {
    throw new Error(
      `legacy preflight cannot safely run candidate schema ${candidateSchemaVersion}; ` +
      "use the migration-safe restart worker",
    );
  }
  const checked = new Set<string>();
  for (const configuredPath of databasePaths) {
    const databasePath = resolveDatabaseTarget(path.resolve(configuredPath));
    const key = platformPathKey(databasePath);
    if (checked.has(key)) continue;
    checked.add(key);
    if (!fs.existsSync(databasePath)) {
      throw new Error("legacy preflight cannot safely initialize a missing database");
    }
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const version = db.pragma("user_version", { simple: true }) as number;
      if (!compatibleVersions.includes(version)) {
        throw new Error(
          `legacy preflight cannot safely upgrade database schema ${version}; ` +
          `compatible versions are ${compatibleVersions.join(", ")}; ` +
          "use the migration-safe restart worker",
        );
      }
    } finally {
      db.close();
    }
  }
}

export async function createRestartDatabaseSnapshot(options: {
  rootDirectory: string;
  databasePaths: string[];
  backupTimeoutMs?: number;
}): Promise<RestartDatabaseSnapshot> {
  const rootDirectory = path.resolve(options.rootDirectory);
  fs.mkdirSync(path.dirname(rootDirectory), { recursive: true, mode: 0o700 });
  fs.mkdirSync(rootDirectory, { mode: 0o700 });
  const preflightDirectory = path.join(rootDirectory, "preflight");
  fs.mkdirSync(preflightDirectory, { mode: 0o700 });

  const records: SnapshotRecord[] = [];
  const mappings: PreflightDatabaseManifest["mappings"] = [];
  const grouped = new Map<string, { databasePath: string; sourcePaths: string[] }>();

  for (const configuredPath of options.databasePaths) {
    const sourcePath = path.resolve(configuredPath);
    const databasePath = resolveDatabaseTarget(sourcePath);
    const key = platformPathKey(databasePath);
    const existing = grouped.get(key);
    if (existing) {
      existing.sourcePaths.push(sourcePath);
    } else {
      grouped.set(key, { databasePath, sourcePaths: [sourcePath] });
    }
  }

  try {
    let index = 0;
    for (const group of grouped.values()) {
      index += 1;
      const existed = fs.existsSync(group.databasePath);
      const rollbackPath = existed ? path.join(rootDirectory, `database-${index}.sqlite`) : undefined;
      const preflightPath = path.join(preflightDirectory, `database-${index}.sqlite`);
      const mode = existed ? fs.statSync(group.databasePath).mode & 0o777 : undefined;

      if (rollbackPath) {
        await backupDatabase(group.databasePath, rollbackPath, options.backupTimeoutMs ?? 120_000);
        fs.copyFileSync(rollbackPath, preflightPath, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(rollbackPath, 0o600);
        fs.chmodSync(preflightPath, 0o600);
      }

      records.push({ databasePath: group.databasePath, existed, rollbackPath, mode });
      for (const sourcePath of group.sourcePaths) mappings.push({ sourcePath, preflightPath });
    }

    const manifest: PreflightDatabaseManifest = { schemaVersion: 1, mappings };
    const manifestPath = path.join(rootDirectory, "preflight-manifest.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    return { rootDirectory, manifestPath, records };
  } catch (err) {
    fs.rmSync(rootDirectory, { recursive: true, force: true });
    throw err;
  }
}

export function applyPreflightDatabaseManifest(
  config: NiuBotConfig,
  manifestPath: string,
): NiuBotConfig {
  const absoluteManifestPath = path.resolve(manifestPath);
  const manifestRoot = path.dirname(absoluteManifestPath);
  const parsed = JSON.parse(fs.readFileSync(absoluteManifestPath, "utf-8")) as Partial<PreflightDatabaseManifest>;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.mappings)) {
    throw new Error("invalid preflight database manifest");
  }

  const mappings = parsed.mappings.map((mapping) => {
    if (!mapping || typeof mapping.sourcePath !== "string" || typeof mapping.preflightPath !== "string") {
      throw new Error("invalid preflight database mapping");
    }
    const sourcePath = path.resolve(mapping.sourcePath);
    const preflightPath = path.resolve(mapping.preflightPath);
    const relative = path.relative(manifestRoot, preflightPath);
    if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw new Error("preflight database must be inside the snapshot directory");
    }
    if (samePlatformPath(sourcePath, preflightPath)) {
      throw new Error("preflight database cannot use the live database path");
    }
    return { sourcePath, preflightPath };
  });

  return {
    ...config,
    bots: config.bots.map((bot) => {
      const mapping = mappings.find((candidate) => samePlatformPath(candidate.sourcePath, bot.dbPath));
      if (!mapping) throw new Error(`preflight database mapping missing for bot '${bot.id}'`);
      return { ...bot, dbPath: mapping.preflightPath };
    }),
  };
}

export function restoreRestartDatabaseSnapshot(snapshot: RestartDatabaseSnapshot): void {
  const staged = new Map<SnapshotRecord, string>();
  try {
    for (const record of snapshot.records) {
      if (!record.existed || !record.rollbackPath) continue;
      assertHealthyDatabase(record.rollbackPath);
      fs.mkdirSync(path.dirname(record.databasePath), { recursive: true });
      const temporaryPath = path.join(
        path.dirname(record.databasePath),
        `.${path.basename(record.databasePath)}.niubot-restore-${randomUUID()}.tmp`,
      );
      fs.copyFileSync(record.rollbackPath, temporaryPath, fs.constants.COPYFILE_EXCL);
      syncFile(temporaryPath);
      fs.chmodSync(temporaryPath, record.mode ?? 0o600);
      staged.set(record, temporaryPath);
    }

    for (const record of snapshot.records) {
      removeDatabaseFiles(record.databasePath);
      if (!record.existed) continue;
      const temporaryPath = staged.get(record);
      if (!temporaryPath) throw new Error("database restore file was not staged");
      replaceFileSync(temporaryPath, record.databasePath);
      staged.delete(record);
      syncDirectory(path.dirname(record.databasePath));
    }
  } finally {
    for (const temporaryPath of staged.values()) {
      try { removeFileSync(temporaryPath); } catch { /* preserve the original error */ }
    }
  }
}

export function cleanupRestartDatabaseSnapshot(snapshot: RestartDatabaseSnapshot): void {
  fs.rmSync(snapshot.rootDirectory, { recursive: true, force: true });
}

async function backupDatabase(sourcePath: string, destinationPath: string, timeoutMs: number): Promise<void> {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const deadline = Date.now() + timeoutMs;
  try {
    await source.backup(destinationPath, {
      progress: () => {
        if (Date.now() > deadline) throw new Error(`database backup timed out after ${timeoutMs}ms`);
        return 100;
      },
    });
  } finally {
    source.close();
  }
  assertHealthyDatabase(destinationPath);
}

function assertHealthyDatabase(databasePath: string): void {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const result = db.pragma("quick_check", { simple: true });
    if (result !== "ok") throw new Error("database snapshot failed SQLite quick_check");
  } finally {
    db.close();
    removeDatabaseSidecars(databasePath);
  }
}

function resolveDatabaseTarget(databasePath: string): string {
  try {
    return fs.realpathSync.native(databasePath);
  } catch {
    return path.resolve(databasePath);
  }
}

function platformPathKey(databasePath: string): string {
  const resolved = path.resolve(databasePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function removeDatabaseFiles(databasePath: string): void {
  removeFileSync(databasePath);
  removeDatabaseSidecars(databasePath);
}

function removeDatabaseSidecars(databasePath: string): void {
  for (const candidate of [`${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`]) {
    removeFileSync(candidate);
  }
}

function syncFile(filePath: string): void {
  const fd = fs.openSync(filePath, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  try {
    const fd = fs.openSync(directory, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {
    // Directory fsync is not supported on every filesystem.
  }
}
