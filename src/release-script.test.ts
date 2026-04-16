import { describe, expect, it } from "vitest";

import {
  ensureCleanWorktree,
  isRetryableNpmViewError,
  parseReleaseArgs,
} from "../scripts/release-lib.mjs";

describe("parseReleaseArgs", () => {
  it("accepts patch as the default bump", () => {
    expect(parseReleaseArgs([])).toEqual({ bump: "patch", dryRun: false });
  });

  it("accepts explicit bump values", () => {
    expect(parseReleaseArgs(["minor"])).toEqual({ bump: "minor", dryRun: false });
    expect(parseReleaseArgs(["major", "--dry-run"])).toEqual({ bump: "major", dryRun: true });
  });

  it("rejects unknown bump values", () => {
    expect(() => parseReleaseArgs(["foo"])).toThrow("Invalid release type");
  });
});

describe("ensureCleanWorktree", () => {
  it("accepts an empty git status", () => {
    expect(() => ensureCleanWorktree("")).not.toThrow();
    expect(() => ensureCleanWorktree("   \n")).not.toThrow();
  });

  it("rejects a dirty git status", () => {
    expect(() => ensureCleanWorktree(" M README.md\n")).toThrow("Git worktree is not clean");
  });
});

describe("isRetryableNpmViewError", () => {
  it("treats npm registry lag as retryable", () => {
    const error = new Error("npm error 404 No match found for version 0.1.14");
    expect(isRetryableNpmViewError(error)).toBe(true);
  });

  it("does not hide unrelated errors", () => {
    const error = new Error("npm error code E401");
    expect(isRetryableNpmViewError(error)).toBe(false);
  });
});
