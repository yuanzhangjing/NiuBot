import { describe, expect, it } from "vitest";
import {
  buildExecutableInvocation,
  commandLookupHint,
  deriveNpmPrefixFromPackageRoot,
  isPackageRootInsideNpmRoot,
  resolveExecutable,
  resolveNpmExecutableForNode,
  withNodeRuntimeOnPath,
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
    const invocation = buildExecutableInvocation("C:\\Program Files\\Tools\\agent.cmd", ["hello world", "a&b"], {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    });
    expect(invocation.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.args[3]).toContain("agent.cmd");
    expect(invocation.args[3]).toMatch(/^".*"$/);
    expect(invocation.args[3]).toContain("^&");
    expect(invocation.windowsVerbatimArguments).toBe(true);
  });

  it("resolves npm next to the active node runtime", () => {
    expect(resolveNpmExecutableForNode("/opt/homebrew/bin/node", "darwin", () => true)).toBe("/opt/homebrew/bin/npm");
    expect(resolveNpmExecutableForNode("C:\\node\\node.exe", "win32", () => true)).toBe("C:\\node\\npm.cmd");
    expect(resolveNpmExecutableForNode("/missing/bin/node", "darwin", () => false)).toBeUndefined();
  });

  it("puts the owning Windows Node runtime first without duplicate Path keys", () => {
    const env = withNodeRuntimeOnPath(
      "C:\\Tools\\node-v22\\node.exe",
      {
        Path: "C:\\Users\\Admin\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs;C:\\TOOLS\\NODE-V22",
        PATH: "C:\\stale",
        TEMP: "C:\\Temp",
      },
      "win32",
    );

    expect(env["Path"]).toBe(
      "C:\\Tools\\node-v22;C:\\Users\\Admin\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs",
    );
    expect(env["PATH"]).toBeUndefined();
    expect(env["TEMP"]).toBe("C:\\Temp");
  });

  it("puts the owning POSIX Node runtime first", () => {
    const env = withNodeRuntimeOnPath(
      "/opt/niubot/node/bin/node",
      { PATH: "/usr/local/bin:/opt/niubot/node/bin:/usr/bin", Path: "case-sensitive-value" },
      "linux",
    );

    expect(env["PATH"]).toBe("/opt/niubot/node/bin:/usr/local/bin:/usr/bin");
    expect(env["Path"]).toBe("case-sensitive-value");
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
