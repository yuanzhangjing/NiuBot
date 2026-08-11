import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runNpmPostinstall } from "./npm-postinstall.js";

const temporaryDirectories: string[] = [];

function fixture(): { root: string; projectRoot: string; homeDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-postinstall-"));
  temporaryDirectories.push(root);
  const projectRoot = path.join(root, "package");
  const homeDir = path.join(root, "home");
  fs.mkdirSync(path.join(projectRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "dist", "niubot-launcher.js"), "");
  fs.writeFileSync(path.join(projectRoot, "dist", "nbt-launcher.js"), "");
  return { root, projectRoot, homeDir };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("npm postinstall", () => {
  it("does nothing for a local dependency install", () => {
    const { projectRoot, homeDir } = fixture();
    expect(runNpmPostinstall({ projectRoot, homeDir, env: {}, platform: "darwin" })).toEqual({
      status: "skipped",
      reason: "not a global npm install",
    });
    expect(fs.existsSync(path.join(homeDir, ".local", "bin", "niubot"))).toBe(false);
  });

  it("creates and refreshes marker-owned launchers for a global install", () => {
    const { root, projectRoot, homeDir } = fixture();
    const first = runNpmPostinstall({
      projectRoot,
      homeDir,
      execPath: "/runtime/node",
      env: { npm_config_global: "true" },
      platform: "darwin",
    });
    expect(first.status).toBe("completed");
    const shimPath = path.join(homeDir, ".local", "bin", "niubot");
    expect(fs.readFileSync(shimPath, "utf8")).toContain(path.posix.join(projectRoot, "dist", "niubot-launcher.js"));

    const newerRoot = path.join(root, "new-package");
    fs.mkdirSync(path.join(newerRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(newerRoot, "dist", "niubot-launcher.js"), "");
    fs.writeFileSync(path.join(newerRoot, "dist", "nbt-launcher.js"), "");
    const refreshed = runNpmPostinstall({
      projectRoot: newerRoot,
      homeDir,
      execPath: "/runtime/node",
      env: { npm_config_global: "true" },
      platform: "darwin",
    });
    expect(refreshed).toMatchObject({
      status: "completed",
      shims: { niubot: { status: "updated" }, nbt: { status: "updated" } },
    });
    expect(fs.readFileSync(shimPath, "utf8")).toContain(path.posix.join(newerRoot, "dist", "niubot-launcher.js"));
  });

  it("does not overwrite a user-owned command", () => {
    const { projectRoot, homeDir } = fixture();
    const shimPath = path.join(homeDir, ".local", "bin", "niubot");
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    fs.writeFileSync(shimPath, "#!/bin/sh\necho user-owned\n");
    const result = runNpmPostinstall({
      projectRoot,
      homeDir,
      env: { npm_config_global: "true" },
      platform: "darwin",
    });
    expect(result).toMatchObject({ status: "completed", shims: { niubot: { status: "conflict" } } });
    expect(fs.readFileSync(shimPath, "utf8")).toBe("#!/bin/sh\necho user-owned\n");
  });
});
