import { execFileSync } from "node:child_process";

const VALID_BUMPS = new Set(["patch", "minor", "major"]);
const NPM_REGISTRY = "https://registry.npmjs.org/";

export function parseReleaseArgs(argv) {
  let bump = "patch";
  let dryRun = false;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (VALID_BUMPS.has(arg)) {
      bump = arg;
      continue;
    }
    throw new Error(`Invalid release type: ${arg}. Expected patch, minor, or major.`);
  }

  return { bump, dryRun };
}

export function ensureCleanWorktree(statusOutput) {
  if (statusOutput.trim().length > 0) {
    throw new Error("Git worktree is not clean. Commit or stash your changes before releasing.");
  }
}

export function npmPublishArgs() {
  return ["publish", "--access", "public", "--registry", NPM_REGISTRY];
}

export function run(command, args, options = {}) {
  const printable = [command, ...args].join(" ");
  console.log(`$ ${printable}`);
  if (options.dryRun) return "";
  return execFileSync(command, args, {
    stdio: options.stdio ?? "pipe",
    encoding: options.encoding ?? "utf8",
  });
}
