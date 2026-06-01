import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

type PathBuildOptions = {
  projectRoot?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  execPath?: string;
};

export function getProjectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function getBundledNiubotBinDir(projectRoot = getProjectRoot()): string {
  return path.join(projectRoot, "bin");
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
