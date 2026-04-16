import { execFileSync } from "node:child_process";

const VALID_BUMPS = new Set(["patch", "minor", "major"]);

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

export function getCommandErrorText(error) {
  if (error && typeof error === "object") {
    const stderr = typeof error.stderr === "string" ? error.stderr : "";
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    const message = error instanceof Error ? error.message : String(error);
    return [message, stderr, stdout].filter(Boolean).join("\n");
  }
  return String(error);
}

export function isRetryableNpmViewError(error) {
  const message = getCommandErrorText(error);
  return message.includes("No match found for version");
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

export async function retry(fn, { attempts, delayMs, shouldRetry }) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (index === attempts - 1 || !shouldRetry(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
