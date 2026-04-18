#!/usr/bin/env node

import fs from "node:fs";

import {
  ensureCleanWorktree,
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
} else {
  await retry(
    () => {
      const raw = run("npm", ["view", pkg.name, "dist-tags", "--json"]);
      const tags = JSON.parse(raw);
      console.log(`  dist-tags: latest=${tags.latest}`);
      if (tags.latest !== version) {
        throw new Error(`latest is ${tags.latest}, expected ${version}`);
      }
    },
    { timeoutMs: 120_000, delayMs: 5000, shouldRetry: () => true },
  );
}

run("git", ["push", "origin", branch, "--follow-tags"], { dryRun, stdio: "inherit" });
console.log(`Release complete: ${pkg.name}@${version}`);
