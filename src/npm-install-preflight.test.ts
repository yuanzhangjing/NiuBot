import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  preflightGlobalNpmInstall,
  resolveGlobalPackageRoot,
} from "./npm-install-preflight.js";
import type { CommandResult } from "./platform/command.js";

describe("global npm install preflight", () => {
  it("derives package roots using target-platform npm layouts", () => {
    expect(resolveGlobalPackageRoot(
      "C:\\Users\\Admin\\AppData\\Local\\NiuBotRuntime\\node-v22",
      "@yuanzhangjing/niubot",
      "win32",
    )).toBe(
      "C:\\Users\\Admin\\AppData\\Local\\NiuBotRuntime\\node-v22\\node_modules\\@yuanzhangjing\\niubot",
    );
    expect(resolveGlobalPackageRoot("/opt/niubot", "@yuanzhangjing/niubot", "linux"))
      .toBe("/opt/niubot/lib/node_modules/@yuanzhangjing/niubot");
  });

  it("verifies an isolated candidate before returning", () => {
    const calls: Array<{ command: string; args: string[]; path?: string }> = [];
    const run = (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }): CommandResult => {
      calls.push({ command, args, path: options?.env?.["PATH"] });
      if (command === "/runtime/bin/npm") {
        const prefix = args[args.indexOf("--prefix") + 1]!;
        const packageRoot = resolveGlobalPackageRoot(prefix, "@yuanzhangjing/niubot", process.platform);
        fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
        fs.mkdirSync(path.join(packageRoot, "node_modules", "better-sqlite3"), { recursive: true });
        fs.writeFileSync(
          path.join(packageRoot, "package.json"),
          JSON.stringify({ name: "@yuanzhangjing/niubot", version: "1.2.3" }),
        );
      }
      const stdout = args.at(-1) === "version" ? "niubot v1.2.3\n" : "";
      return { command, args, stdout, stderr: "", exitCode: 0 };
    };

    preflightGlobalNpmInstall({
      npmCommand: "/runtime/bin/npm",
      nodePath: "/runtime/bin/node",
      packageName: "@yuanzhangjing/niubot",
      packageSpec: "@yuanzhangjing/niubot@1.2.3",
      expectedVersion: "1.2.3",
      cwd: "/work",
      env: { PATH: "/runtime/bin:/usr/bin" },
      timeoutMs: 60_000,
      run,
    });

    expect(calls).toHaveLength(3);
    expect(calls[0]?.args).toContain("--prefix");
    expect(calls[1]?.args.at(-1)).toBe("version");
    expect(calls[2]?.args.join(" ")).toContain("new Database(':memory:')");
    expect(calls.every((call) => call.path === "/runtime/bin:/usr/bin")).toBe(true);
  });

  it("rejects a candidate whose installed version differs", () => {
    let temporaryRoot: string | undefined;
    const run = (command: string, args: string[]): CommandResult => {
      if (command === "/runtime/bin/npm") {
        const prefix = args[args.indexOf("--prefix") + 1]!;
        temporaryRoot = path.dirname(prefix);
        const packageRoot = resolveGlobalPackageRoot(prefix, "@yuanzhangjing/niubot", process.platform);
        fs.mkdirSync(packageRoot, { recursive: true });
        fs.writeFileSync(
          path.join(packageRoot, "package.json"),
          JSON.stringify({ name: "@yuanzhangjing/niubot", version: "9.9.9" }),
        );
      }
      return { command, args, stdout: "", stderr: "", exitCode: 0 };
    };

    expect(() => preflightGlobalNpmInstall({
      npmCommand: "/runtime/bin/npm",
      nodePath: "/runtime/bin/node",
      packageName: "@yuanzhangjing/niubot",
      packageSpec: "@yuanzhangjing/niubot@1.2.3",
      expectedVersion: "1.2.3",
      cwd: "/work",
      env: { PATH: "/runtime/bin:/usr/bin" },
      timeoutMs: 60_000,
      run,
    })).toThrow(/candidate package mismatch/);
    expect(temporaryRoot).toBeDefined();
    expect(fs.existsSync(temporaryRoot!)).toBe(false);
  });
});
