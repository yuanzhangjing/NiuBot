import { describe, expect, it } from "vitest";
import {
  buildExecutableInvocation,
  commandLookupHint,
  deriveNpmPrefixFromPackageRoot,
  isPackageRootInsideNpmRoot,
  resolveExecutable,
  resolveNpmExecutableForNode,
} from "./executable.js";

describe("resolveExecutable", () => {
  it("resolves POSIX commands from PATH", () => {
    const files = new Set(["/opt/bin/codex"]);
    expect(resolveExecutable("codex", {
      platform: "linux",
      env: { PATH: "/usr/bin:/opt/bin" },
      isExecutable: (candidate) => files.has(candidate),
    })).toBe("/opt/bin/codex");
  });

  it("resolves Windows commands using case-insensitive Path and PATHEXT", () => {
    const files = new Set(["c:\\tools\\claude.cmd"]);
    expect(resolveExecutable("claude", {
      platform: "win32",
      env: { Path: '"C:\\Program Files\\Node";C:\\tools', PATHEXT: ".EXE;.CMD" },
      isExecutable: (candidate) => files.has(candidate.toLowerCase()),
    })).toBe("C:\\tools\\claude.CMD");
  });

  it("routes cmd shims through the configured command interpreter", () => {
    const invocation = buildExecutableInvocation("C:\\Tools\\agent.cmd", ["--version"], {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    });
    expect(invocation.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.args[3]).toContain("agent.cmd");
    expect(invocation.windowsVerbatimArguments).toBe(true);
  });

  it("resolves npm next to the active node runtime", () => {
    expect(resolveNpmExecutableForNode("/opt/homebrew/bin/node", "darwin", () => true)).toBe("/opt/homebrew/bin/npm");
    expect(resolveNpmExecutableForNode("C:\\node\\node.exe", "win32", () => true)).toBe("C:\\node\\npm.cmd");
    expect(resolveNpmExecutableForNode("/missing/bin/node", "darwin", () => false)).toBeUndefined();
  });

  it("derives npm installation prefixes with target-platform path rules", () => {
    expect(deriveNpmPrefixFromPackageRoot("/opt/homebrew/lib/node_modules/@yuanzhangjing/niubot", "darwin")).toBe("/opt/homebrew");
    expect(deriveNpmPrefixFromPackageRoot("/Users/me/.nvs/node/22/lib/node_modules/@yuanzhangjing/niubot", "darwin")).toBe("/Users/me/.nvs/node/22");
    expect(isPackageRootInsideNpmRoot(
      "/opt/homebrew/lib/node_modules/@yuanzhangjing/niubot",
      "/opt/homebrew/lib/node_modules",
      "darwin",
    )).toBe(true);
    expect(isPackageRootInsideNpmRoot(
      "/opt/homebrew/lib/node_modules/@yuanzhangjing/niubot",
      "/Users/me/.nvs/node/22/lib/node_modules",
      "darwin",
    )).toBe(false);
  });

  it("formats command lookup hints for the active shell family", () => {
    expect(commandLookupHint("niubot", "win32")).toBe("Get-Command niubot -All");
    expect(commandLookupHint("niubot", "linux")).toBe("which -a niubot");
  });
});
