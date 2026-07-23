import fs from "node:fs";
import path from "node:path";

export interface RecoverableGlobalInstallOptions {
  packageRoot: string;
  npmPrefix: string;
  commandName: string;
  install: () => void | Promise<void>;
  verify: () => void | Promise<void>;
  verifyRollback?: () => void | Promise<void>;
  platform?: NodeJS.Platform;
}

export interface RecoverableGlobalInstallResult {
  cleanupWarning?: string;
}

export class GlobalInstallError extends Error {
  readonly restored: boolean;
  readonly recoveryDirectory?: string;

  constructor(message: string, options: {
    cause: unknown;
    restored: boolean;
    recoveryDirectory?: string;
  }) {
    super(message, { cause: options.cause });
    this.name = "GlobalInstallError";
    this.restored = options.restored;
    this.recoveryDirectory = options.recoveryDirectory;
  }
}

interface ArtifactSnapshot {
  activePath: string;
  backupPath: string;
  existed: boolean;
  symbolicLinkTarget?: string;
}

/**
 * Protect an npm-owned global package update with a local backup. npm still
 * performs the real installation so its package metadata and shims remain
 * standard. If npm or post-install verification fails, the previous package
 * directory and command shims are restored before returning.
 */
export async function runRecoverableGlobalInstall(
  options: RecoverableGlobalInstallOptions,
): Promise<RecoverableGlobalInstallResult> {
  const platform = options.platform ?? process.platform;
  assertPackageBelongsToPrefix(options.packageRoot, options.npmPrefix, platform);

  const backupParent = path.join(options.npmPrefix, ".niubot-update-backups");
  fs.mkdirSync(backupParent, { recursive: true });
  const recoveryDirectory = fs.mkdtempSync(path.join(backupParent, "transaction-"));
  const packageBackup = path.join(recoveryDirectory, "package");
  const artifactPaths = [
    ...resolveGlobalCommandPaths(options.npmPrefix, options.commandName, platform),
    resolveGlobalPackageLockPath(options.packageRoot, platform),
  ];
  let snapshots: ArtifactSnapshot[];

  try {
    snapshots = artifactPaths.map((activePath, index) => snapshotArtifact(
      activePath,
      path.join(recoveryDirectory, `artifact-${index}`),
    ));
    copyEntry(options.packageRoot, packageBackup);
    for (const snapshot of snapshots) {
      if (snapshot.existed && snapshot.symbolicLinkTarget === undefined) {
        copyEntry(snapshot.activePath, snapshot.backupPath);
      }
    }
  } catch (err) {
    removeEntry(recoveryDirectory);
    throw new GlobalInstallError(
      `Could not back up the active global installation: ${errorMessage(err)}`,
      { cause: err, restored: true },
    );
  }

  try {
    for (const commandPath of resolveGlobalCommandPaths(options.npmPrefix, options.commandName, platform)) {
      removeEntry(commandPath);
    }
    await options.install();
    await options.verify();
  } catch (installError) {
    try {
      restoreSnapshot(options.packageRoot, packageBackup, snapshots, platform);
      await options.verifyRollback?.();
    } catch (restoreError) {
      throw new GlobalInstallError(
        `Global update failed and automatic restore also failed. `
        + `The recovery copy remains at ${recoveryDirectory}. `
        + `Install error: ${errorMessage(installError)}. `
        + `Restore error: ${errorMessage(restoreError)}`,
        {
          cause: installError,
          restored: false,
          recoveryDirectory,
        },
      );
    }

    const cleanupWarning = cleanupRecoveryDirectory(recoveryDirectory, backupParent);
    throw new GlobalInstallError(
      `Global update failed; the previous installation was restored. ${errorMessage(installError)}`
      + (cleanupWarning ? ` ${cleanupWarning}` : ""),
      { cause: installError, restored: true },
    );
  }

  return {
    cleanupWarning: cleanupRecoveryDirectory(recoveryDirectory, backupParent),
  };
}

export function resolveGlobalCommandPaths(
  npmPrefix: string,
  commandName: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return platform === "win32"
    ? [
        pathApi.join(npmPrefix, commandName),
        pathApi.join(npmPrefix, `${commandName}.cmd`),
        pathApi.join(npmPrefix, `${commandName}.ps1`),
      ]
    : [pathApi.join(npmPrefix, "bin", commandName)];
}

export function resolvePrimaryGlobalCommand(
  npmPrefix: string,
  commandName: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = resolveGlobalCommandPaths(npmPrefix, commandName, platform);
  return platform === "win32" ? paths[1]! : paths[0]!;
}

export function resolveGlobalPackageLockPath(
  packageRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalized = pathApi.normalize(packageRoot);
  const parts = normalized.split(pathApi.sep);
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (nodeModulesIndex < 0) {
    throw new Error(`Global package root does not contain node_modules: ${packageRoot}`);
  }
  const nodeModulesRoot = parts.slice(0, nodeModulesIndex + 1).join(pathApi.sep) || pathApi.sep;
  return pathApi.join(nodeModulesRoot, ".package-lock.json");
}

function restoreSnapshot(
  packageRoot: string,
  packageBackup: string,
  snapshots: ArtifactSnapshot[],
  platform: NodeJS.Platform,
): void {
  removeEntry(packageRoot);
  copyEntry(packageBackup, packageRoot);
  for (const snapshot of snapshots) {
    removeEntry(snapshot.activePath);
    if (!snapshot.existed) continue;
    if (snapshot.symbolicLinkTarget !== undefined) {
      fs.mkdirSync(path.dirname(snapshot.activePath), { recursive: true });
      fs.symlinkSync(
        snapshot.symbolicLinkTarget,
        snapshot.activePath,
        platform === "win32" ? "file" : undefined,
      );
    } else {
      copyEntry(snapshot.backupPath, snapshot.activePath);
    }
  }
}

function snapshotArtifact(activePath: string, backupPath: string): ArtifactSnapshot {
  try {
    const stats = fs.lstatSync(activePath);
    return {
      activePath,
      backupPath,
      existed: true,
      symbolicLinkTarget: stats.isSymbolicLink() ? fs.readlinkSync(activePath) : undefined,
    };
  } catch (err) {
    if (!isMissingPathError(err)) throw err;
    return { activePath, backupPath, existed: false };
  }
}

function assertPackageBelongsToPrefix(
  packageRoot: string,
  npmPrefix: string,
  platform: NodeJS.Platform,
): void {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const relative = pathApi.relative(pathApi.resolve(npmPrefix), pathApi.resolve(packageRoot));
  if (!relative || relative.startsWith("..") || pathApi.isAbsolute(relative)) {
    throw new Error(`Global package root is outside npm prefix: ${packageRoot}`);
  }
  if (!pathExists(packageRoot)) {
    throw new Error(`Active global package is missing: ${packageRoot}`);
  }
}

function copyEntry(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

function removeEntry(target: string): void {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function pathExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (err) {
    if (!isMissingPathError(err)) throw err;
    return false;
  }
}

function isMissingPathError(err: unknown): boolean {
  return err instanceof Error
    && "code" in err
    && (err.code === "ENOENT" || err.code === "ENOTDIR");
}

function cleanupRecoveryDirectory(recoveryDirectory: string, backupParent: string): string | undefined {
  try {
    removeEntry(recoveryDirectory);
    try {
      fs.rmdirSync(backupParent);
    } catch {
      // Other update recovery copies may still exist.
    }
    return undefined;
  } catch (err) {
    return `The no-longer-needed backup could not be removed: ${recoveryDirectory} (${errorMessage(err)})`;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
