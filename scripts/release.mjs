#!/usr/bin/env node

import fs from "node:fs";

import {
  ensureCleanWorktree,
  isRetryableNpmViewError,
  parseReleaseArgs,
  retry,
  run,
} from "./release-lib.mjs";

const { bump, dryRun } = parseReleaseArgs(process.argv.slice(2));

const status = run("git", ["status", "--porcelain"], { dryRun });
ensureCleanWorktree(status);

const branch = run("git", ["branch", "--show-current"], { dryRun }).trim() || "<current-branch>";

run("npm", ["run", "release:check"], { dryRun, stdio: "inherit" });
run("npm", ["version", bump], { dryRun, stdio: "inherit" });

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = pkg.version;

run("npm", ["publish", "--access", "public"], { dryRun, stdio: "inherit" });
if (dryRun) {
  run("npm", ["view", pkg.name, "dist-tags", "--json"], { dryRun, stdio: "inherit" });
  run("npm", ["view", `${pkg.name}@${version}`, "version"], { dryRun, stdio: "inherit" });
} else {
  await retry(
    () => {
      const tags = run("npm", ["view", pkg.name, "dist-tags", "--json"]);
      process.stdout.write(tags);
      const resolved = run("npm", ["view", `${pkg.name}@${version}`, "version"]);
      process.stdout.write(resolved);
      return resolved;
    },
    { timeoutMs: 120_000, delayMs: 5000, shouldRetry: isRetryableNpmViewError },
  );
}

run("git", ["push", "origin", branch, "--follow-tags"], { dryRun, stdio: "inherit" });
console.log(`Release complete: ${pkg.name}@${version}`);
