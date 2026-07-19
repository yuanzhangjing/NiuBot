import { describe, expect, it } from "vitest";
import { buildExecutableInvocation, resolveExecutable } from "./executable.js";

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
});
