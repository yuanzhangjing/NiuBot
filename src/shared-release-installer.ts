import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { x as extractTar } from "tar";
import { verifyInstalledPackage } from "./npm-install-preflight.js";
import { runCommand, type CommandResult } from "./platform/command.js";
import {
  buildArtifactId,
  buildImportedArtifactId,
  computeTreeDigest,
  createSharedReleaseManifest,
  type ArtifactSourceKind,
  type SharedReleaseManifest,
  SharedReleaseStore,
} from "./shared-release-store.js";

type CommandRunner = typeof runCommand;

export interface InstallArchiveOptions {
  archivePath: string;
  sourceKind: "npm" | "source";
  sourceDigest?: string;
  expectedVersion?: string;
  /** Rewrite a locally packed stable source archive into its allocated DEV version. */
  versionOverride?: string;
  nodePath: string;
  nodeVersion: string;
  nodeAbi: string;
  npmCommand: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  preferOffline?: boolean;
  run?: CommandRunner;
  verify?: (packageDirectory: string, version: string) => void | Promise<void>;
}

export interface ImportInstalledTreeOptions {
  sourceDirectory: string;
  sourceKind: "npm" | "seed" | "legacy";
  nodePath: string;
  nodeVersion: string;
  nodeAbi: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  run?: CommandRunner;
  verify?: (packageDirectory: string, version: string) => void | Promise<void>;
}

export interface InstalledSharedRelease {
  artifactId: string;
  packageDirectory: string;
  manifest: SharedReleaseManifest;
  reused: boolean;
}

export class SharedReleaseInstaller {
  constructor(readonly store: SharedReleaseStore) {}

  async installArchive(options: InstallArchiveOptions): Promise<InstalledSharedRelease> {
    let staging: string | undefined;
    try {
      staging = this.store.createStagingDirectory(options.expectedVersion ?? "archive");
      const packageDirectory = path.join(staging, "package");
      fs.mkdirSync(packageDirectory);
      await extractTar({ file: options.archivePath, cwd: packageDirectory, strip: 1 });
      let pkg = readPackage(packageDirectory);
      if (options.versionOverride) {
        rewritePackageVersion(packageDirectory, pkg.version, options.versionOverride);
        pkg = readPackage(packageDirectory);
      }
      if (options.expectedVersion && pkg.version !== options.expectedVersion) {
        throw new Error(`Candidate version mismatch: ${pkg.version}; expected ${options.expectedVersion}`);
      }
      const shrinkwrap = path.join(packageDirectory, "npm-shrinkwrap.json");
      if (!fs.existsSync(shrinkwrap)) throw new Error("Candidate package does not contain npm-shrinkwrap.json");
      const sourceDigest = options.sourceDigest ?? hashFile(options.archivePath, "sha512");
      const lockDigest = hashFile(shrinkwrap, "sha256");
      const artifactId = buildArtifactId({
        version: pkg.version,
        nodeAbi: options.nodeAbi,
        platform: process.platform,
        arch: process.arch,
        sourceDigest,
        lockDigest,
      });
      const reuseLock = this.store.acquireLock();
      try {
        const existing = this.store.readManifest(artifactId);
        if (existing) {
          try {
            this.store.assertUsableArtifact(artifactId, existing.treeDigest);
            fs.rmSync(staging, { recursive: true, force: true });
            staging = undefined;
            return resultFor(this.store, existing, true);
          } catch {
            // Keep the extracted candidate. publishStagedArtifact will quarantine
            // the damaged immutable directory after a complete reinstall.
          }
        }
      } finally {
        reuseLock();
      }
      const install = await (options.run ?? runCommand)(options.npmCommand, [
        "ci",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        ...(options.preferOffline ? ["--prefer-offline"] : []),
      ], {
        cwd: packageDirectory,
        env: options.env,
        timeoutMs: options.timeoutMs,
      });
      assertCommandSucceeded(install, "npm ci");
      await verifyCandidate(packageDirectory, pkg.version, options);
      const manifest = createSharedReleaseManifest({
        artifactId,
        version: pkg.version,
        sourceKind: options.sourceKind,
        sourceDigest,
        lockDigest,
        treeDigest: computeTreeDigest(packageDirectory),
        installedAt: new Date().toISOString(),
        installerNodePath: options.nodePath,
        nodeVersion: options.nodeVersion,
        nodeAbi: options.nodeAbi,
        platform: process.platform,
        arch: process.arch,
      });
      const releaseLock = this.store.acquireLock();
      let publish;
      try {
        publish = this.store.publishStagedArtifact({ stagingDirectory: staging!, manifest });
      } finally {
        releaseLock();
      }
      staging = undefined;
      return resultFor(this.store, manifest, publish === "reused");
    } finally {
      if (staging) fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  async importInstalledTree(options: ImportInstalledTreeOptions): Promise<InstalledSharedRelease> {
    let staging: string | undefined;
    try {
      assertSelfContainedTree(options.sourceDirectory);
      const pkg = readPackage(options.sourceDirectory);
      staging = this.store.createStagingDirectory(`${options.sourceKind}-${pkg.version}`);
      const packageDirectory = path.join(staging, "package");
      fs.cpSync(options.sourceDirectory, packageDirectory, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
      normalizeCopiedInternalLinks(options.sourceDirectory, packageDirectory);
      await verifyCandidate(packageDirectory, pkg.version, options);
      const treeDigest = computeTreeDigest(packageDirectory);
      const artifactId = buildImportedArtifactId({
        sourceKind: options.sourceKind,
        version: pkg.version,
        nodeAbi: options.nodeAbi,
        platform: process.platform,
        arch: process.arch,
        treeDigest,
      });
      const manifest = createSharedReleaseManifest({
        artifactId,
        version: pkg.version,
        sourceKind: options.sourceKind,
        sourceDigest: treeDigest,
        treeDigest,
        installedAt: new Date().toISOString(),
        installerNodePath: options.nodePath,
        nodeVersion: options.nodeVersion,
        nodeAbi: options.nodeAbi,
        platform: process.platform,
        arch: process.arch,
      });
      const releaseLock = this.store.acquireLock();
      let publish;
      try {
        publish = this.store.publishStagedArtifact({ stagingDirectory: staging, manifest });
      } finally {
        releaseLock();
      }
      staging = undefined;
      return resultFor(this.store, manifest, publish === "reused");
    } finally {
      if (staging) fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}

function rewritePackageVersion(packageDirectory: string, originalVersion: string, version: string): void {
  const packageFile = path.join(packageDirectory, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf-8")) as Record<string, unknown>;
  if (packageJson["version"] !== originalVersion) throw new Error("Package version changed during DEV rewrite");
  packageJson["version"] = version;
  fs.writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);

  const shrinkwrapFile = path.join(packageDirectory, "npm-shrinkwrap.json");
  const shrinkwrap = JSON.parse(fs.readFileSync(shrinkwrapFile, "utf-8")) as Record<string, unknown>;
  shrinkwrap["version"] = version;
  const packages = shrinkwrap["packages"];
  if (packages && typeof packages === "object" && !Array.isArray(packages)) {
    const root = (packages as Record<string, unknown>)[""];
    if (root && typeof root === "object" && !Array.isArray(root)) {
      (root as Record<string, unknown>)["version"] = version;
    }
  }
  fs.writeFileSync(shrinkwrapFile, `${JSON.stringify(shrinkwrap, null, 2)}\n`);
}

async function verifyCandidate(
  packageDirectory: string,
  version: string,
  options: Pick<InstallArchiveOptions, "nodePath" | "cwd" | "env" | "run" | "verify">,
): Promise<void> {
  if (options.verify) {
    await options.verify(packageDirectory, version);
    return;
  }
  await verifyInstalledPackage({
    packageRoot: packageDirectory,
    nodePath: options.nodePath,
    packageName: "@yuanzhangjing/niubot",
    expectedVersion: version,
    cwd: options.cwd,
    env: options.env,
    run: options.run,
  });
}

function readPackage(packageDirectory: string): { name: string; version: string } {
  const value = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf-8")) as {
    name?: string;
    version?: string;
  };
  if (value.name !== "@yuanzhangjing/niubot" || !value.version) {
    throw new Error(`Invalid NiuBot package: ${packageDirectory}`);
  }
  return { name: value.name, version: value.version };
}

function assertSelfContainedTree(sourceDirectory: string): void {
  const root = fs.realpathSync.native(sourceDirectory);
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync.native(entryPath);
        const relative = path.relative(root, target);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error(`Installed tree contains an external symbolic link: ${entryPath}`);
        }
      } else if (entry.isDirectory()) {
        visit(entryPath);
      }
    }
  };
  visit(root);
}

function normalizeCopiedInternalLinks(sourceDirectory: string, destinationDirectory: string): void {
  const sourceRoot = fs.realpathSync.native(sourceDirectory);
  const visit = (relativeDirectory: string): void => {
    const source = path.join(sourceRoot, relativeDirectory);
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const relative = path.join(relativeDirectory, entry.name);
      const sourceEntry = path.join(sourceRoot, relative);
      const destinationEntry = path.join(destinationDirectory, relative);
      if (entry.isSymbolicLink()) {
        const sourceTarget = fs.realpathSync.native(sourceEntry);
        const targetRelativeToRoot = path.relative(sourceRoot, sourceTarget);
        const destinationTarget = path.join(destinationDirectory, targetRelativeToRoot);
        const normalizedTarget = path.relative(path.dirname(destinationEntry), destinationTarget) || ".";
        const targetIsDirectory = fs.statSync(sourceTarget).isDirectory();
        fs.unlinkSync(destinationEntry);
        fs.symlinkSync(normalizedTarget, destinationEntry, process.platform === "win32" ? (targetIsDirectory ? "junction" : "file") : undefined);
      } else if (entry.isDirectory()) {
        visit(relative);
      }
    }
  };
  visit("");
}

function hashFile(filePath: string, algorithm: "sha256" | "sha512"): string {
  return createHash(algorithm).update(fs.readFileSync(filePath)).digest("hex");
}

function assertCommandSucceeded(result: CommandResult, label: string): void {
  if (result.exitCode !== 0) throw new Error(`${label} exited with status ${result.exitCode}: ${result.stderr.trim()}`);
}

function resultFor(store: SharedReleaseStore, manifest: SharedReleaseManifest, reused: boolean): InstalledSharedRelease {
  return {
    artifactId: manifest.artifactId,
    packageDirectory: store.packageDirectory(manifest.artifactId),
    manifest,
    reused,
  };
}
