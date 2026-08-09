import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { buildNiubotEnv } from "./agent/cli-base.js";
import {
  buildWindowsNbtShimContent,
  buildWindowsNiubotShimContent,
  ensureNbtShim,
  ensureNiubotShim,
  ensureRuntimeCliShims,
  ensureRuntimeNbtShim,
  getBundledNiubotBinDir,
  prependNiubotBinToPath,
} from "./platform/cli-runtime.js";
import { resolveBotEndpoint } from "./platform/ipc.js";

describe("niubot CLI path helpers", () => {
  it("publishes nbt as a stable package binary", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf-8")) as {
      bin?: Record<string, string>;
    };

    expect(pkg.bin?.["nbt"]).toBe("dist/nbt-launcher.js");
    expect(pkg.bin?.["niubot"]).toBe("dist/niubot-launcher.js");
  });

  it("resolves the repo-local niubot bin directory", () => {
    expect(getBundledNiubotBinDir()).toBe(
      path.resolve(import.meta.dirname, "..", "bin"),
    );
  });

  it("prepends the repo-local niubot bin directory to PATH", () => {
    const original = "/usr/bin:/bin";

    expect(prependNiubotBinToPath(original, {
      projectRoot: "/pkg",
      env: {},
      homeDir: "",
      execPath: "",
      platform: "linux",
    })).toBe(
      `/pkg/bin:${original}`,
    );
  });

  it("does not prepend the repo-local niubot bin directory twice", () => {
    const original = "/pkg/bin:/usr/bin:/bin";

    expect(prependNiubotBinToPath(original, {
      projectRoot: "/pkg",
      env: {},
      homeDir: "",
      execPath: "",
      platform: "linux",
    })).toBe(original);
  });

  it("adds npm global and common user bin directories before the original PATH", () => {
    const projectRoot = "/opt/homebrew/lib/node_modules/@yuanzhangjing/niubot";

    expect(prependNiubotBinToPath("/usr/bin:/bin", {
      projectRoot,
      env: { npm_config_prefix: "/custom/npm" },
      homeDir: "/home/u",
      execPath: "/usr/local/bin/node",
      platform: "linux",
    })).toBe([
      `${projectRoot}/bin`,
      "/home/u/.local/bin",
      "/opt/homebrew/bin",
      "/custom/npm/bin",
      "/usr/local/bin",
      "/home/u/.npm-global/bin",
      "/usr/bin",
      "/bin",
    ].join(":"));
  });

  it("injects the repo-local niubot bin directory into agent env", () => {
    const env = buildNiubotEnv({
      workingDirectory: "/tmp/project",
      chatId: "c1",
      userId: "u2",
    });

    expect(env["PATH"]).toContain(getBundledNiubotBinDir());
  });

  it("uses Windows PATH separators and the managed cmd shim directory", () => {
    const value = prependNiubotBinToPath("C:\\Windows;C:\\Tools", {
      projectRoot: "C:\\pkg",
      env: { LOCALAPPDATA: "C:\\Local" },
      homeDir: "C:\\Users\\Zen",
      execPath: "C:\\Node\\node.exe",
      platform: "win32",
    });
    expect(value.split(";")).toContain(path.win32.join("C:\\Local", "NiuBot", "bin"));
    expect(value).toContain("C:\\Windows;C:\\Tools");
  });

  it("passes bot profile path only for admin sessions", () => {
    const adminEnv = buildNiubotEnv({
      botProfilePath: "/tmp/bot_profile.md",
      isAdmin: true,
    });
    const userEnv = buildNiubotEnv({
      botProfilePath: "/tmp/bot_profile.md",
      isAdmin: false,
    });

    expect(adminEnv["NIUBOT_BOT_PROFILE_PATH"]).toBe("/tmp/bot_profile.md");
    expect(userEnv["NIUBOT_BOT_PROFILE_PATH"]).toBeUndefined();
  });

  it("includes NIUBOT_HOME so agent subprocesses connect to the correct service", () => {
    const env = buildNiubotEnv({
      workingDirectory: "/tmp/project",
    });

    expect(env["NIUBOT_HOME"]).toBeTruthy();
    expect(typeof env["NIUBOT_HOME"]).toBe("string");
  });

  it("passes the bot name used by session archive paths", () => {
    const env = buildNiubotEnv({ botName: "NiuBot", dbPath: "/data/custom/bot.db" });
    expect(env["NIUBOT_BOT_NAME"]).toBe("NiuBot");
    expect(env["NIUBOT_API_SOCKET"]).toBe(
      process.platform === "win32"
        ? resolveBotEndpoint(env["NIUBOT_HOME"]!, "NiuBot").address
        : "/data/custom/api.sock",
    );
  });

  it.skipIf(process.platform === "win32")("creates a managed nbt shim under .local/bin", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-home-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-project-"));
    const targetPath = path.join(projectRoot, "dist", "nbt-launcher.js");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "#!/usr/bin/env node\n");

    const result = ensureNbtShim({ homeDir, projectRoot });
    const shimPath = path.join(homeDir, ".local", "bin", "nbt");

    expect(result.status).toBe("created");
    expect(result.shimPath).toBe(shimPath);
    expect(fs.readFileSync(shimPath, "utf-8")).toContain(`'${targetPath}' "$@"`);
    expect(fs.readFileSync(shimPath, "utf-8")).not.toContain("command -v niubot");
  });

  it.skipIf(process.platform === "win32")("creates a managed niubot shim beside nbt", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-home-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-project-"));
    const targetPath = path.join(projectRoot, "dist", "niubot-launcher.js");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "#!/usr/bin/env node\n");

    const result = ensureNiubotShim({ homeDir, projectRoot });
    const shimPath = path.join(homeDir, ".local", "bin", "niubot");

    expect(result.status).toBe("created");
    expect(result.shimPath).toBe(shimPath);
    expect(fs.readFileSync(shimPath, "utf-8")).toContain(`'${targetPath}' "$@"`);
  });

  it.skipIf(process.platform === "win32")("does not overwrite an unmanaged niubot file", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-home-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-project-"));
    fs.mkdirSync(path.join(projectRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "dist", "niubot-launcher.js"), "#!/usr/bin/env node\n");
    const shimPath = path.join(homeDir, ".local", "bin", "niubot");
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    fs.writeFileSync(shimPath, "#!/bin/sh\necho user-owned\n");

    const result = ensureNiubotShim({ homeDir, projectRoot });

    expect(result.status).toBe("conflict");
    expect(fs.readFileSync(shimPath, "utf-8")).toBe("#!/bin/sh\necho user-owned\n");
  });

  it.skipIf(process.platform === "win32")("does not overwrite an unmanaged nbt file", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-home-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-project-"));
    const targetPath = path.join(projectRoot, "dist", "nbt-launcher.js");
    const shimPath = path.join(homeDir, ".local", "bin", "nbt");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    fs.writeFileSync(targetPath, "#!/usr/bin/env node\n");
    fs.writeFileSync(shimPath, "#!/bin/sh\necho user-owned\n");

    const result = ensureNbtShim({ homeDir, projectRoot });

    expect(result.status).toBe("conflict");
    expect(fs.readFileSync(shimPath, "utf-8")).toBe("#!/bin/sh\necho user-owned\n");
  });

  it.skipIf(process.platform === "win32")("does not trust a managed marker outside the shim header", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-home-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-project-"));
    const targetPath = path.join(projectRoot, "dist", "nbt-launcher.js");
    const shimPath = path.join(homeDir, ".local", "bin", "nbt");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    fs.writeFileSync(targetPath, "#!/usr/bin/env node\n");
    const userOwned = "#!/bin/sh\necho user-owned\n# Managed by NiuBot: nbt shim\n";
    fs.writeFileSync(shimPath, userOwned);

    const result = ensureNbtShim({ homeDir, projectRoot });

    expect(result.status).toBe("conflict");
    expect(fs.readFileSync(shimPath, "utf-8")).toBe(userOwned);
  });

  it.skipIf(process.platform === "win32")("updates a previously managed nbt shim", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-home-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-project-"));
    const targetPath = path.join(projectRoot, "dist", "nbt-launcher.js");
    const shimPath = path.join(homeDir, ".local", "bin", "nbt");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    fs.writeFileSync(targetPath, "#!/usr/bin/env node\n");
    fs.writeFileSync(shimPath, "#!/bin/sh\n# Managed by NiuBot: nbt shim\nexec '/old/nbt' \"$@\"\n");

    const result = ensureNbtShim({ homeDir, projectRoot });

    expect(result.status).toBe("updated");
    expect(fs.readFileSync(shimPath, "utf-8")).toContain(`'${targetPath}' "$@"`);
  });

  it("does not update the nbt shim during preflight", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-home-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-project-"));
    const targetPath = path.join(projectRoot, "dist", "nbt-launcher.js");
    const shimPath = path.join(homeDir, ".local", "bin", "nbt");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "#!/usr/bin/env node\n");

    const result = ensureRuntimeNbtShim({ homeDir, projectRoot, preflight: true });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("preflight run");
    expect(fs.existsSync(shimPath)).toBe(false);
  });

  it("does not update either managed CLI shim during preflight", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-home-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-project-"));
    fs.mkdirSync(path.join(projectRoot, "dist"), { recursive: true });
    for (const command of ["niubot", "nbt"]) {
      fs.writeFileSync(path.join(projectRoot, "dist", `${command}-launcher.js`), "#!/usr/bin/env node\n");
    }

    const results = ensureRuntimeCliShims({ homeDir, projectRoot, preflight: true });

    expect(results.niubot.status).toBe("skipped");
    expect(results.nbt.status).toBe("skipped");
    expect(fs.existsSync(path.join(homeDir, ".local", "bin", "niubot"))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, ".local", "bin", "nbt"))).toBe(false);
  });

  it("does not point the user niubot command at a source runtime", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-home-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-project-"));
    fs.mkdirSync(path.join(projectRoot, "dist"), { recursive: true });
    for (const command of ["niubot", "nbt"]) {
      fs.writeFileSync(path.join(projectRoot, "dist", `${command}-launcher.js`), "#!/usr/bin/env node\n");
    }

    const results = ensureRuntimeCliShims({ homeDir, projectRoot, includeNiubot: false });

    expect(results.niubot).toMatchObject({ status: "skipped", reason: "source runtime" });
    expect(results.nbt.status).toBe("created");
    expect(fs.existsSync(results.niubot.shimPath)).toBe(false);
    expect(fs.existsSync(results.nbt.shimPath)).toBe(true);
  });

  it("builds a native Windows command shim without a Unix shell", () => {
    const content = buildWindowsNbtShimContent("C:\\Node\\node.exe", "C:\\pkg\\dist\\cli.js");
    expect(content).toContain("@echo off");
    expect(content).toContain('"C:\\Node\\node.exe"');
    expect(content).not.toContain("#!/bin/sh");
  });

  it("builds a native Windows niubot command shim", () => {
    const content = buildWindowsNiubotShimContent("C:\\Node\\node.exe", "C:\\pkg\\dist\\niubot-launcher.js");
    expect(content).toContain("@echo off");
    expect(content).toContain("C:\\pkg\\dist\\niubot-launcher.js");
    expect(content).not.toContain("#!/bin/sh");
  });

  it.skipIf(process.platform !== "win32")("creates the native Windows command shim on disk", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-home-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-project-"));
    const localAppData = path.join(homeDir, "LocalAppData");
    fs.mkdirSync(path.join(projectRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "dist", "nbt-launcher.js"), "#!/usr/bin/env node\n");

    const result = ensureNbtShim({
      homeDir,
      projectRoot,
      localAppData,
      execPath: "C:\\Node\\node.exe",
      platform: "win32",
    });

    expect(result.status).toBe("created");
    expect(result.shimPath).toBe(path.win32.join(localAppData, "NiuBot", "bin", "nbt.cmd"));
    const content = fs.readFileSync(result.shimPath, "utf-8");
    expect(content).toContain("@echo off");
    expect(content).toContain('"C:\\Node\\node.exe"');
    expect(content).not.toContain("#!/bin/sh");
  });
});
