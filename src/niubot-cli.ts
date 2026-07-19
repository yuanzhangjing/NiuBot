import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

type PathBuildOptions = {
  projectRoot?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  execPath?: string;
  platform?: NodeJS.Platform;
};

export type NbtShimStatus = "created" | "updated" | "unchanged" | "conflict" | "skipped";

export type NbtShimResult = {
  status: NbtShimStatus;
  shimPath: string;
  targetPath: string;
  reason?: string;
};

type NbtShimOptions = {
  projectRoot?: string;
  homeDir?: string;
  execPath?: string;
  platform?: NodeJS.Platform;
  localAppData?: string;
};

type RuntimeNbtShimOptions = NbtShimOptions & {
  preflight?: boolean;
};

const NBT_SHIM_MARKER = "# Managed by NiuBot: nbt shim";

export function getProjectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function getBundledNiubotBinDir(
  projectRoot = getProjectRoot(),
  platform: NodeJS.Platform = process.platform,
): string {
  return pathForPlatform(platform).join(projectRoot, "bin");
}

export function getBundledNbtPath(
  projectRoot = getProjectRoot(),
  platform: NodeJS.Platform = process.platform,
): string {
  return pathForPlatform(platform).join(getBundledNiubotBinDir(projectRoot, platform), "nbt");
}

export function ensureNbtShim(options: NbtShimOptions = {}): NbtShimResult {
  const projectRoot = options.projectRoot ?? getProjectRoot();
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const pathApi = pathForPlatform(platform);
  const targetPath = platform === "win32"
    ? pathApi.join(projectRoot, "dist", "cli.js")
    : getBundledNbtPath(projectRoot, platform);
  const shimPath = pathApi.join(
    getNbtShimDirectory(homeDir, platform, options.localAppData),
    platform === "win32" ? "nbt.cmd" : "nbt",
  );

  if (!homeDir) {
    return { status: "skipped", shimPath, targetPath, reason: "home directory is empty" };
  }
  if (!fs.existsSync(targetPath)) {
    return { status: "skipped", shimPath, targetPath, reason: "bundled nbt not found" };
  }

  const desired = platform === "win32"
    ? buildWindowsNbtShimContent(options.execPath ?? process.execPath, targetPath)
    : buildNbtShimContent(targetPath);
  fs.mkdirSync(pathApi.dirname(shimPath), { recursive: true });

  if (fs.existsSync(shimPath)) {
    const existing = fs.readFileSync(shimPath, "utf-8");
    if (existing === desired) {
      return { status: "unchanged", shimPath, targetPath };
    }
    if (!existing.includes(NBT_SHIM_MARKER)) {
      return { status: "conflict", shimPath, targetPath, reason: "existing nbt is not managed by NiuBot" };
    }
    fs.writeFileSync(shimPath, desired, { mode: 0o755 });
    if (platform !== "win32") fs.chmodSync(shimPath, 0o755);
    return { status: "updated", shimPath, targetPath };
  }

  fs.writeFileSync(shimPath, desired, { mode: 0o755 });
  if (platform !== "win32") fs.chmodSync(shimPath, 0o755);
  return { status: "created", shimPath, targetPath };
}

export function ensureRuntimeNbtShim(options: RuntimeNbtShimOptions = {}): NbtShimResult {
  const projectRoot = options.projectRoot ?? getProjectRoot();
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const pathApi = pathForPlatform(platform);
  const targetPath = platform === "win32" ? pathApi.join(projectRoot, "dist", "cli.js") : getBundledNbtPath(projectRoot, platform);
  const shimPath = pathApi.join(
    getNbtShimDirectory(homeDir, platform, options.localAppData),
    platform === "win32" ? "nbt.cmd" : "nbt",
  );

  if (options.preflight) {
    return { status: "skipped", shimPath, targetPath, reason: "preflight run" };
  }

  return ensureNbtShim({ ...options, projectRoot, homeDir, platform });
}

export function prependNiubotBinToPath(
  currentPath = process.env["PATH"] ?? "",
  options: PathBuildOptions = {},
): string {
  const projectRoot = options.projectRoot ?? getProjectRoot();
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const execPath = options.execPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const delimiter = platform === "win32" ? ";" : ":";

  return uniquePathEntries([
    ...(platform === "win32" && homeDir
      ? [getNbtShimDirectory(homeDir, platform, env["LOCALAPPDATA"])]
      : []),
    getBundledNiubotBinDir(projectRoot, platform),
    ...getNpmGlobalBinCandidates({ projectRoot, env, homeDir, execPath, platform }),
    ...currentPath.split(delimiter),
  ]).join(delimiter);
}

function getNpmGlobalBinCandidates(options: Required<PathBuildOptions>): string[] {
  const candidates: string[] = [];
  const pathApi = pathForPlatform(options.platform);
  const nodeModulesMarker = `${pathApi.sep}node_modules${pathApi.sep}`;
  const nodeModulesIndex = options.projectRoot.indexOf(nodeModulesMarker);
  if (nodeModulesIndex >= 0) {
    const modulePrefix = options.projectRoot.slice(0, nodeModulesIndex);
    candidates.push(options.platform === "win32"
      ? modulePrefix
      : pathApi.basename(modulePrefix) === "lib"
        ? pathApi.join(pathApi.dirname(modulePrefix), "bin")
        : pathApi.join(modulePrefix, "bin"));
  }

  const npmPrefix = options.env["npm_config_prefix"] ?? options.env["NPM_CONFIG_PREFIX"];
  if (npmPrefix) candidates.push(options.platform === "win32" ? npmPrefix : pathApi.join(npmPrefix, "bin"));

  if (options.execPath) candidates.push(pathApi.dirname(options.execPath));
  if (options.homeDir && options.platform !== "win32") {
    candidates.push(pathApi.join(options.homeDir, ".local", "bin"));
    candidates.push(pathApi.join(options.homeDir, ".npm-global", "bin"));
  }

  return candidates;
}

function uniquePathEntries(entries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

function buildNbtShimContent(targetPath: string): string {
  return [
    "#!/bin/sh",
    NBT_SHIM_MARKER,
    `exec ${shellSingleQuote(targetPath)} "$@"`,
    "",
  ].join("\n");
}

export function buildWindowsNbtShimContent(nodePath: string, targetPath: string): string {
  return [
    "@echo off",
    `REM ${NBT_SHIM_MARKER}`,
    `\"${nodePath.replaceAll('"', '""')}\" \"${targetPath.replaceAll('"', '""')}\" %*`,
    "",
  ].join("\r\n");
}

function getNbtShimDirectory(homeDir: string, platform: NodeJS.Platform, localAppData?: string): string {
  const pathApi = pathForPlatform(platform);
  if (platform === "win32") {
    return pathApi.join(localAppData || pathApi.join(homeDir, "AppData", "Local"), "NiuBot", "bin");
  }
  return pathApi.join(homeDir, ".local", "bin");
}

function pathForPlatform(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
