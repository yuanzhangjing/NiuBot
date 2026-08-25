import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PREFLIGHT_TIMEOUT_MS,
  buildRestartNotificationBody,
  buildRestartRuntimeEnvironment,
  buildInstallArgs,
  isNpmInstalledPath,
  npmPackFilenameForPackage,
  parseNpmPackFilename,
  resolvePreflightTimeoutMs,
  resolveRestartSourceDirectory,
  resolveRuntimeEnvironment,
} from "./restart-worker.js";
import { withNodeRuntimeOnPath } from "./platform/executable.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("restart worker helpers", () => {
  it("keeps restart notifications anchored to the original reply", () => {
    expect(buildRestartNotificationBody({ wakeReplyTo: "om-root" }, "重启成功。")).toEqual({
      text: "重启成功。",
      reply_to_msg_id: "om-root",
    });
    expect(buildRestartNotificationBody({}, "重启成功。")).toEqual({
      text: "重启成功。",
      reply_to_msg_id: undefined,
    });
  });

  it("uses a Windows-safe configurable preflight timeout", () => {
    expect(DEFAULT_PREFLIGHT_TIMEOUT_MS).toBe(120_000);
    expect(resolvePreflightTimeoutMs({})).toBe(120_000);
    expect(resolvePreflightTimeoutMs({ NIUBOT_RESTART_PREFLIGHT_TIMEOUT: "90" })).toBe(90_000);
    expect(resolvePreflightTimeoutMs({ NIUBOT_RESTART_PREFLIGHT_TIMEOUT: "invalid" })).toBe(120_000);
    expect(resolvePreflightTimeoutMs({ NIUBOT_RESTART_PREFLIGHT_TIMEOUT: "0" })).toBe(120_000);
  });

  it("preserves the inherited Windows PATH when selecting the candidate Node runtime", () => {
    const inherited = {
      Path: "C:\\Users\\Admin\\AppData\\Roaming\\npm;C:\\Windows\\System32",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      NIUBOT_UPDATE_VERSION: "0.2.16",
      NIUBOT_CONTROL_TOKEN: "old-engine-secret",
    };
    const runtimeEnv = buildRestartRuntimeEnvironment("C:\\src\\niubot", "production", inherited);
    const preflightEnv = withNodeRuntimeOnPath(
      "C:\\Users\\Admin\\AppData\\Local\\Programs\\node-v24\\node.exe",
      runtimeEnv,
      "win32",
    );

    expect(preflightEnv["Path"]).toBe([
      "C:\\Users\\Admin\\AppData\\Local\\Programs\\node-v24",
      "C:\\Users\\Admin\\AppData\\Roaming\\npm",
      "C:\\Windows\\System32",
    ].join(";"));
    expect(preflightEnv["PATHEXT"]).toBe(inherited.PATHEXT);
    expect(preflightEnv["NIUBOT_SOURCE_DIR"]).toBe("C:\\src\\niubot");
    expect(preflightEnv["NIUBOT_ENV"]).toBe("production");
    expect(preflightEnv["NIUBOT_UPDATE_VERSION"]).toBeUndefined();
    expect(preflightEnv["NIUBOT_CONTROL_TOKEN"]).toBeUndefined();
  });

  it("preserves custom POSIX tool directories when selecting the candidate Node runtime", () => {
    const runtimeEnv = buildRestartRuntimeEnvironment("/srv/niubot", "production", {
      PATH: "/opt/homebrew/bin:/home/test/.asdf/shims:/usr/bin",
      CODEX_HOME: "/home/test/.codex",
    });
    const preflightEnv = withNodeRuntimeOnPath(
      "/home/test/.local/niubot/node/bin/node",
      runtimeEnv,
      "linux",
    );

    expect(preflightEnv["PATH"]).toBe([
      "/home/test/.local/niubot/node/bin",
      "/opt/homebrew/bin",
      "/home/test/.asdf/shims",
      "/usr/bin",
    ].join(":"));
    expect(preflightEnv["CODEX_HOME"]).toBe("/home/test/.codex");
  });

  it("parses npm pack JSON without trusting paths", () => {
    expect(parseNpmPackFilename('[{"filename":"yuanzhangjing-niubot-1.2.3.tgz"}]'))
      .toBe("yuanzhangjing-niubot-1.2.3.tgz");
    expect(() => parseNpmPackFilename('[{"filename":"../outside.tgz"}]')).toThrow();
  });

  it("derives npm pack filename for package specs", () => {
    expect(npmPackFilenameForPackage("@yuanzhangjing/niubot@1.2.3")).toBe("yuanzhangjing-niubot-1.2.3.tgz");
    expect(npmPackFilenameForPackage("@yuanzhangjing/niubot@0.2.1-beta.1")).toBe("yuanzhangjing-niubot-0.2.1-beta.1.tgz");
    expect(npmPackFilenameForPackage("@yuanzhangjing/niubot")).toBeUndefined();
  });

  it("builds install args with prefer-offline only for dev/local restarts", () => {
    expect(buildInstallArgs(false)).toEqual(["install", "--omit=dev", "--no-audit", "--no-fund"]);
    expect(buildInstallArgs()).toEqual(["install", "--omit=dev", "--no-audit", "--no-fund"]);
    expect(buildInstallArgs(true)).toEqual([
      "install", "--omit=dev", "--no-audit", "--no-fund", "--prefer-offline",
    ]);
  });

  it("resolves runtime environment: explicit NIUBOT_ENV wins", () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-env-"));
    tempDirs.push(source);
    expect(resolveRuntimeEnvironment({ NIUBOT_ENV: "production" }, source)).toBe("production");
    expect(resolveRuntimeEnvironment({ NIUBOT_ENV: "dev" }, source)).toBe("dev");
    expect(resolveRuntimeEnvironment({ NIUBOT_ENV: "production", NIUBOT_RUNTIME_MODE: "npm-release" }, source))
      .toBe("production");
  });

  it("resolves runtime environment: npm-installed path means production (manual npm install + start)", () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-env-"));
    tempDirs.push(source);
    const npmRuntime = path.join(source, "global", "node_modules", "@yuanzhangjing", "niubot");
    // 手动 npm install -g + start：运行路径在 node_modules 下，无 npm-release 标记，无 src/
    expect(resolveRuntimeEnvironment({}, source, npmRuntime))
      .toBe("production");
    // 旧 npm 安装路径是迁移提示，不能被环境变量伪装成 DEV。
    expect(resolveRuntimeEnvironment(
      { NIUBOT_ENV: "dev" }, source, npmRuntime,
    )).toBe("production");
  });

  it("uses the artifact version before every legacy environment hint", () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-env-source-"));
    const productionRuntime = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-env-production-"));
    const devRuntime = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-env-dev-"));
    tempDirs.push(source, productionRuntime, devRuntime);
    fs.mkdirSync(path.join(source, "src"));
    fs.writeFileSync(path.join(productionRuntime, "package.json"), JSON.stringify({ name: "@yuanzhangjing/niubot", version: "1.2.3" }));
    fs.writeFileSync(path.join(devRuntime, "package.json"), JSON.stringify({ name: "@yuanzhangjing/niubot", version: "1.2.3-dev.7" }));

    expect(resolveRuntimeEnvironment({ NIUBOT_ENV: "dev" }, source, productionRuntime)).toBe("production");
    expect(resolveRuntimeEnvironment({ NIUBOT_ENV: "production" }, source, devRuntime)).toBe("dev");
  });

  it("resolves runtime environment: npm-release source means production", () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-env-"));
    tempDirs.push(source);
    expect(resolveRuntimeEnvironment({ NIUBOT_RUNTIME_MODE: "npm-release" }, source)).toBe("production");
  });

  it("resolves runtime environment: source checkout with src/ means dev", () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-env-"));
    fs.mkdirSync(path.join(source, "src"), { recursive: true });
    tempDirs.push(source);
    expect(resolveRuntimeEnvironment({}, source)).toBe("dev");
    expect(resolveRuntimeEnvironment({ NIUBOT_RUNTIME_MODE: "npm-release" }, source)).toBe("production");
  });

  it("resolves runtime environment: defaults to production when ambiguous", () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-env-"));
    tempDirs.push(source);
    // npm-installed without upgrade marker, no src/ checkout → conservative production
    expect(resolveRuntimeEnvironment({}, source)).toBe("production");
    expect(resolveRuntimeEnvironment({ NIUBOT_SOURCE_DIR: "/some/package" }, source)).toBe("production");
  });

  it("detects npm installed paths by node_modules segment", () => {
    expect(isNpmInstalledPath("/opt/homebrew/lib/node_modules/@yuanzhangjing/niubot")).toBe(true);
    expect(isNpmInstalledPath("/Users/x/.niubot/NiuBot/releases/20260807-1/package")).toBe(false);
    expect(isNpmInstalledPath("C:\\Users\\x\\node_modules\\@scope\\pkg")).toBe(true);
    expect(isNpmInstalledPath("")).toBe(false);
  });

  it("keeps npm releases independent from configured source directories", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-restart-worker-"));
    tempDirs.push(home);
    fs.writeFileSync(path.join(home, "config.yaml"), "restart:\n  sourceDirectory: /dev/source\n");
    expect(resolveRestartSourceDirectory({
      niubotHome: home,
      workerRuntimePath: "/cli/package",
      env: { NIUBOT_RUNTIME_MODE: "npm-release", NIUBOT_SOURCE_DIR: "/active/package" },
    })).toBe(path.resolve("/active/package"));
  });

  it("uses configured sourceDirectory in source mode", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-restart-worker-"));
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-source-"));
    tempDirs.push(home, source);
    fs.writeFileSync(path.join(home, "config.yaml"), `restart:\n  sourceDirectory: ${source}\n`);
    expect(resolveRestartSourceDirectory({
      niubotHome: home,
      workerRuntimePath: "/release/package",
      env: { NIUBOT_SOURCE_DIR: "/old/release" },
    })).toBe(source);
  });
});
