#!/usr/bin/env node

import fs from "node:fs";

import {
  ensureCleanWorktree,
  parseReleaseArgs,
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

run("git", ["push", "origin", branch, "--follow-tags"], { dryRun, stdio: "inherit" });

console.log(`Release pushed: ${pkg.name}@${version}`);
console.log("GitHub Actions will publish this version to npm.");
