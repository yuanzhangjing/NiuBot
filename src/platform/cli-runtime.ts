import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { replaceFileSync } from "./files.js";

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

export type RuntimeCliShimResults = {
  niubot: NbtShimResult;
  nbt: NbtShimResult;
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
  includeNiubot?: boolean;
};

const NBT_SHIM_MARKER = "# Managed by NiuBot: nbt shim";
const NIUBOT_SHIM_MARKER = "# Managed by NiuBot: niubot shim";

export function getProjectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
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
  return ensureCliShim("nbt", options);
}

export function ensureNiubotShim(options: NbtShimOptions = {}): NbtShimResult {
  return ensureCliShim("niubot", options);
}

function ensureCliShim(command: "niubot" | "nbt", options: NbtShimOptions): NbtShimResult {
  const projectRoot = options.projectRoot ?? getProjectRoot();
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const pathApi = pathForPlatform(platform);
  const targetPath = pathApi.join(projectRoot, "dist", `${command}-launcher.js`);
  const shimPath = pathApi.join(
    getNbtShimDirectory(homeDir, platform, options.localAppData),
    platform === "win32" ? `${command}.cmd` : command,
  );

  if (!homeDir) {
    return { status: "skipped", shimPath, targetPath, reason: "home directory is empty" };
  }
  if (!fs.existsSync(targetPath)) {
    return { status: "skipped", shimPath, targetPath, reason: "bundled nbt not found" };
  }

  const desired = platform === "win32"
    ? command === "nbt"
      ? buildWindowsNbtShimContent(options.execPath ?? process.execPath, targetPath)
      : buildWindowsNiubotShimContent(options.execPath ?? process.execPath, targetPath)
    : command === "nbt"
      ? buildNbtShimContent(options.execPath ?? process.execPath, targetPath)
      : buildNiubotShimContent(options.execPath ?? process.execPath, targetPath);
  const marker = command === "nbt" ? NBT_SHIM_MARKER : NIUBOT_SHIM_MARKER;
  fs.mkdirSync(pathApi.dirname(shimPath), { recursive: true });

  if (fs.existsSync(shimPath)) {
    const existing = fs.readFileSync(shimPath, "utf-8");
    if (existing === desired) {
      return { status: "unchanged", shimPath, targetPath };
    }
    if (!isManagedShim(existing, marker, platform)) {
      return { status: "conflict", shimPath, targetPath, reason: `existing ${command} is not managed by NiuBot` };
    }
    writeManagedShim(shimPath, desired, platform);
    return { status: "updated", shimPath, targetPath };
  }

  writeManagedShim(shimPath, desired, platform);
  return { status: "created", shimPath, targetPath };
}

function isManagedShim(content: string, marker: string, platform: NodeJS.Platform): boolean {
  const lines = content.split(/\r?\n/, 2);
  return platform === "win32"
    ? lines[0] === "@echo off" && lines[1] === `REM ${marker}`
    : lines[0] === "#!/bin/sh" && lines[1] === marker;
}

export function ensureRuntimeNbtShim(options: RuntimeNbtShimOptions = {}): NbtShimResult {
  const projectRoot = options.projectRoot ?? getProjectRoot();
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const pathApi = pathForPlatform(platform);
  const targetPath = pathApi.join(projectRoot, "dist", "nbt-launcher.js");
  const shimPath = pathApi.join(
    getNbtShimDirectory(homeDir, platform, options.localAppData),
    platform === "win32" ? "nbt.cmd" : "nbt",
  );

  if (options.preflight) {
    return { status: "skipped", shimPath, targetPath, reason: "preflight run" };
  }

  return ensureNbtShim({ ...options, projectRoot, homeDir, platform });
}

export function ensureRuntimeCliShims(options: RuntimeNbtShimOptions = {}): RuntimeCliShimResults {
  const projectRoot = options.projectRoot ?? getProjectRoot();
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  if (options.preflight) {
    return {
      niubot: skippedCliShim("niubot", { ...options, projectRoot, homeDir, platform }),
      nbt: skippedCliShim("nbt", { ...options, projectRoot, homeDir, platform }),
    };
  }
  return {
    niubot: options.includeNiubot === false
      ? skippedCliShim("niubot", { ...options, projectRoot, homeDir, platform }, "source runtime")
      : ensureNiubotShim({ ...options, projectRoot, homeDir, platform }),
    nbt: ensureNbtShim({ ...options, projectRoot, homeDir, platform }),
  };
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
    getBundledNiubotBinDir(projectRoot, platform),
    ...(homeDir ? [getNbtShimDirectory(homeDir, platform, env["LOCALAPPDATA"])] : []),
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

function buildNbtShimContent(nodePath: string, targetPath: string): string {
  return [
    "#!/bin/sh",
    NBT_SHIM_MARKER,
    `exec ${shellSingleQuote(nodePath)} ${shellSingleQuote(targetPath)} "$@"`,
    "",
  ].join("\n");
}

function buildNiubotShimContent(nodePath: string, targetPath: string): string {
  return [
    "#!/bin/sh",
    NIUBOT_SHIM_MARKER,
    `exec ${shellSingleQuote(nodePath)} ${shellSingleQuote(targetPath)} "$@"`,
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

export function buildWindowsNiubotShimContent(nodePath: string, targetPath: string): string {
  return [
    "@echo off",
    `REM ${NIUBOT_SHIM_MARKER}`,
    `\"${nodePath.replaceAll('"', '""')}\" \"${targetPath.replaceAll('"', '""')}\" %*`,
    "",
  ].join("\r\n");
}

function skippedCliShim(
  command: "niubot" | "nbt",
  options: NbtShimOptions & { projectRoot: string; homeDir: string; platform: NodeJS.Platform },
  reason = "preflight run",
): NbtShimResult {
  const pathApi = pathForPlatform(options.platform);
  return {
    status: "skipped",
    shimPath: pathApi.join(
      getNbtShimDirectory(options.homeDir, options.platform, options.localAppData),
      options.platform === "win32" ? `${command}.cmd` : command,
    ),
    targetPath: pathApi.join(options.projectRoot, "dist", `${command}-launcher.js`),
    reason,
  };
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

function writeManagedShim(shimPath: string, content: string, platform: NodeJS.Platform): void {
  const temporary = path.join(path.dirname(shimPath), `.${path.basename(shimPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { mode: 0o755, flag: "wx" });
    replaceFileSync(temporary, shimPath);
    if (platform !== "win32") fs.chmodSync(shimPath, 0o755);
  } catch (err) {
    try { fs.unlinkSync(temporary); } catch { /* ignore */ }
    throw err;
  }
}
