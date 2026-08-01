import fs from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  buildExecutableInvocation,
  commandLookupHint,
  deriveNpmPrefixFromPackageRoot,
  isPackageRootInsideNpmRoot,
  resolveExecutable,
  resolveNpmExecutableForNode,
  withNodeRuntimeOnPath,
} from "./executable.js";

const tempDirs: string[] = [];

function writeTempShim(fileName: string, content: string, subDir = path.join("node_modules", ".bin")): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "executable-shim-"));
  tempDirs.push(dir);
  const shimPath = path.join(dir, subDir, fileName);
  fs.mkdirSync(path.dirname(shimPath), { recursive: true });
  writeFileSync(shimPath, content, "utf8");
  return shimPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

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

  it("bypasses cmd for npm JS shims: spawns node + cli.js directly (multiline args survive)", () => {
    // 老式 find_dp0 结构
    const shim = writeTempShim("claude.cmd", `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\claude\\cli.js" %*
`);
    const multiline = "line1\nline2\nline3";
    const invocation = buildExecutableInvocation(shim, ["--append-system-prompt", multiline, "--resume", "abc"], {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    });
    // 绕过 cmd：直接 node + cli.js（路径按 win32 风格解析）
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args[0]).toBe(path.win32.join(path.win32.dirname(shim), "..", "claude", "cli.js"));
    expect(invocation.args.slice(1)).toEqual(["--append-system-prompt", multiline, "--resume", "abc"]);
    expect(invocation.windowsVerbatimArguments).toBeUndefined();
  });

  it("bypasses cmd for inline %~dp0 shims (yarn v1 style, no trailing percent)", () => {
    // cmd 的 %~dp0 语法没有结尾百分号；yarn/老 npm 内联式 shim 直接内联调用行
    const shim = writeTempShim("yarn.cmd", `@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe" "%~dp0\\..\\yarn\\bin\\yarn.js" %*
) ELSE (
  @SETLOCAL
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node "%~dp0\\..\\yarn\\bin\\yarn.js" %*
)
`);
    const invocation = buildExecutableInvocation(shim, ["add", "pkg"], { platform: "win32" });
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args[0]).toBe(path.win32.join(path.win32.dirname(shim), "..", "yarn", "bin", "yarn.js"));
    expect(invocation.args.slice(1)).toEqual(["add", "pkg"]);
  });

  it("bypasses cmd for globally installed npm CLIs (no node_modules/.bin prefix)", () => {
    // npm 全局安装：shim 直接在全局 bin 目录（%APPDATA%\\npm\\claude.cmd）
    const shim = writeTempShim("claude.cmd", `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\@anthropic-ai\\claude-code\\cli.js" %*
`, "");
    const invocation = buildExecutableInvocation(shim, ["--append-system-prompt", "a\nb"], { platform: "win32" });
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args[0]).toBe(path.win32.join(path.win32.dirname(shim), "..", "@anthropic-ai", "claude-code", "cli.js"));
    expect(invocation.args.slice(1)).toEqual(["--append-system-prompt", "a\nb"]);
  });

  it("ignores comment and loader references (only call lines with %* are entries)", () => {
    const shim = writeTempShim("claude.cmd", `@ECHO off
REM "%dp0%\\..\\pkg\\cleanup.js"
SETLOCAL
"%_prog%" "%dp0%\\..\\claude\\cli.js" --require "%dp0%\\..\\claude\\preload.js" %*
`);
    const invocation = buildExecutableInvocation(shim, ["--flag"], { platform: "win32" });
    expect(invocation.command).toBe(process.execPath);
    // 注释行和 --require 加载器不被当入口
    expect(invocation.args[0]).toBe(path.win32.join(path.win32.dirname(shim), "..", "claude", "cli.js"));
    expect(invocation.args.slice(1)).toEqual(["--flag"]);
  });

  it("handles double backslashes in shim entries (no drive-root mis-resolution)", () => {
    const shim = writeTempShim("claude.cmd", `@ECHO off
SETLOCAL
"%_prog%" "%dp0%\\\\..\\\\claude\\\\cli.js" %*
`);
    const invocation = buildExecutableInvocation(shim, ["--flag"], { platform: "win32" });
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args[0]).toBe(path.win32.join(path.win32.dirname(shim), "..", "claude", "cli.js"));
  });

  it("bypasses cmd for native .exe npm shims (spawns the exe directly)", () => {
    const shim = writeTempShim("native-tool.cmd", `@ECHO off
SETLOCAL
IF EXIST "%dp0%\\native-tool.exe" (
  "%dp0%\\native-tool.exe" %*
) ELSE (
  ECHO native-tool.exe not found
  EXIT /b 1
)
`);
    const invocation = buildExecutableInvocation(shim, ["--flag"], { platform: "win32" });
    expect(invocation.command).toBe(path.win32.join(path.win32.dirname(shim), "native-tool.exe"));
    expect(invocation.args).toEqual(["--flag"]);
  });

  it("keeps cmd routing for non-npm shims (e.g. system tools)", () => {
    // 不在 node_modules/.bin 下 → 保持 cmd 包装
    const invocation = buildExecutableInvocation("C:\\Tools\\helper.cmd", ["--flag"], {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    });
    expect(invocation.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  });

  it("keeps cmd routing for npm shims that cannot be resolved (no entry reference)", () => {
    const shim = writeTempShim("weird.cmd", "@ECHO off\r\nECHO nothing useful\r\n");
    const invocation = buildExecutableInvocation(shim, ["--flag"], { platform: "win32" });
    expect(invocation.command).toMatch(/cmd\.exe$/i);
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
