import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

type PathBuildOptions = {
  projectRoot?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  execPath?: string;
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
};

type RuntimeNbtShimOptions = NbtShimOptions & {
  preflight?: boolean;
};

const NBT_SHIM_MARKER = "# Managed by NiuBot: nbt shim";

export function getProjectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function getBundledNiubotBinDir(projectRoot = getProjectRoot()): string {
  return path.join(projectRoot, "bin");
}

export function getBundledNbtPath(projectRoot = getProjectRoot()): string {
  return path.join(getBundledNiubotBinDir(projectRoot), "nbt");
}

export function ensureNbtShim(options: NbtShimOptions = {}): NbtShimResult {
  const projectRoot = options.projectRoot ?? getProjectRoot();
  const homeDir = options.homeDir ?? os.homedir();
  const targetPath = getBundledNbtPath(projectRoot);
  const shimPath = path.join(homeDir, ".local", "bin", "nbt");

  if (!homeDir) {
    return { status: "skipped", shimPath, targetPath, reason: "home directory is empty" };
  }
  if (!fs.existsSync(targetPath)) {
    return { status: "skipped", shimPath, targetPath, reason: "bundled nbt not found" };
  }

  const desired = buildNbtShimContent(targetPath);
  fs.mkdirSync(path.dirname(shimPath), { recursive: true });

  if (fs.existsSync(shimPath)) {
    const existing = fs.readFileSync(shimPath, "utf-8");
    if (existing === desired) {
      return { status: "unchanged", shimPath, targetPath };
    }
    if (!existing.includes(NBT_SHIM_MARKER)) {
      return { status: "conflict", shimPath, targetPath, reason: "existing nbt is not managed by NiuBot" };
    }
    fs.writeFileSync(shimPath, desired, { mode: 0o755 });
    fs.chmodSync(shimPath, 0o755);
    return { status: "updated", shimPath, targetPath };
  }

  fs.writeFileSync(shimPath, desired, { mode: 0o755 });
  fs.chmodSync(shimPath, 0o755);
  return { status: "created", shimPath, targetPath };
}

export function ensureRuntimeNbtShim(options: RuntimeNbtShimOptions = {}): NbtShimResult {
  const projectRoot = options.projectRoot ?? getProjectRoot();
  const homeDir = options.homeDir ?? os.homedir();
  const targetPath = getBundledNbtPath(projectRoot);
  const shimPath = path.join(homeDir, ".local", "bin", "nbt");

  if (options.preflight) {
    return { status: "skipped", shimPath, targetPath, reason: "preflight run" };
  }

  return ensureNbtShim({ projectRoot, homeDir });
}

export function prependNiubotBinToPath(
  currentPath = process.env["PATH"] ?? "",
  options: PathBuildOptions = {},
): string {
  const projectRoot = options.projectRoot ?? getProjectRoot();
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const execPath = options.execPath ?? process.execPath;

  return uniquePathEntries([
    getBundledNiubotBinDir(projectRoot),
    ...getNpmGlobalBinCandidates({ projectRoot, env, homeDir, execPath }),
    ...currentPath.split(path.delimiter),
  ]).join(path.delimiter);
}

function getNpmGlobalBinCandidates(options: Required<PathBuildOptions>): string[] {
  const candidates: string[] = [];
  const globalNodeModulesMarker = `${path.sep}lib${path.sep}node_modules${path.sep}`;
  const globalNodeModulesIndex = options.projectRoot.indexOf(globalNodeModulesMarker);
  if (globalNodeModulesIndex >= 0) {
    candidates.push(path.join(options.projectRoot.slice(0, globalNodeModulesIndex), "bin"));
  }

  const npmPrefix = options.env["npm_config_prefix"] ?? options.env["NPM_CONFIG_PREFIX"];
  if (npmPrefix) candidates.push(path.join(npmPrefix, "bin"));

  if (options.execPath) candidates.push(path.dirname(options.execPath));
  if (options.homeDir) {
    candidates.push(path.join(options.homeDir, ".local", "bin"));
    candidates.push(path.join(options.homeDir, ".npm-global", "bin"));
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

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
