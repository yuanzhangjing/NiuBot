import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  ensureCleanWorktree,
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

describe("trusted publishing release flow", () => {
  it("publishes from GitHub Actions with an OIDC token", () => {
    const workflow = parse(
      readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8"),
    ) as {
      permissions: Record<string, string>;
      jobs: { publish: { steps: Array<{ name?: string; run?: string; uses?: string }> } };
    };

    expect(workflow.permissions["id-token"]).toBe("write");
    expect(workflow.jobs.publish.steps).toContainEqual({
      name: "Publish",
      run: "npm publish --access public --registry https://registry.npmjs.org",
    });
    expect(JSON.stringify(workflow)).not.toContain("NPM_TOKEN");
  });

  it("does not publish from the local release script", () => {
    const releaseScript = readFileSync(new URL("../scripts/release.mjs", import.meta.url), "utf8");

    expect(releaseScript).not.toContain("npmPublishArgs");
    expect(releaseScript).not.toContain("[\"publish\"");
    expect(releaseScript).toContain("git\", [\"push\"");
  });
});
