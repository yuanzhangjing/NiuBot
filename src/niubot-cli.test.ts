import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { buildNiubotEnv } from "./agent/cli-base.js";
import { ensureNbtShim, ensureRuntimeNbtShim, getBundledNiubotBinDir, prependNiubotBinToPath } from "./niubot-cli.js";

describe("niubot CLI path helpers", () => {
  it("publishes nbt as a stable package binary", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf-8")) as {
      bin?: Record<string, string>;
    };

    expect(pkg.bin?.["nbt"]).toBe("bin/nbt");
  });

  it("resolves the repo-local niubot bin directory", () => {
    expect(getBundledNiubotBinDir()).toBe(
      path.resolve(import.meta.dirname, "..", "bin"),
    );
  });

  it("prepends the repo-local niubot bin directory to PATH", () => {
    const original = "/usr/bin:/bin";

    expect(prependNiubotBinToPath(original, { env: {}, homeDir: "", execPath: "" })).toBe(
      `${getBundledNiubotBinDir()}:${original}`,
    );
  });

  it("does not prepend the repo-local niubot bin directory twice", () => {
    const original = `${getBundledNiubotBinDir()}:/usr/bin:/bin`;

    expect(prependNiubotBinToPath(original, { env: {}, homeDir: "", execPath: "" })).toBe(original);
  });

  it("adds npm global and common user bin directories before the original PATH", () => {
    const projectRoot = "/opt/homebrew/lib/node_modules/@yuanzhangjing/niubot";

    expect(prependNiubotBinToPath("/usr/bin:/bin", {
      projectRoot,
      env: { npm_config_prefix: "/custom/npm" },
      homeDir: "/home/u",
      execPath: "/usr/local/bin/node",
    })).toBe([
      `${projectRoot}/bin`,
      "/opt/homebrew/bin",
      "/custom/npm/bin",
      "/usr/local/bin",
      "/home/u/.local/bin",
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
    const env = buildNiubotEnv({ botName: "NiuBot" });
    expect(env["NIUBOT_BOT_NAME"]).toBe("NiuBot");
  });

  it("creates a managed nbt shim under .local/bin", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-home-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-project-"));
    const targetPath = path.join(projectRoot, "bin", "nbt");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "#!/bin/sh\n");

    const result = ensureNbtShim({ homeDir, projectRoot });
    const shimPath = path.join(homeDir, ".local", "bin", "nbt");

    expect(result.status).toBe("created");
    expect(result.shimPath).toBe(shimPath);
    expect(fs.readFileSync(shimPath, "utf-8")).toContain(`exec '${targetPath}' "$@"`);
  });

  it("does not overwrite an unmanaged nbt file", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-home-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-project-"));
    const targetPath = path.join(projectRoot, "bin", "nbt");
    const shimPath = path.join(homeDir, ".local", "bin", "nbt");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    fs.writeFileSync(targetPath, "#!/bin/sh\n");
    fs.writeFileSync(shimPath, "#!/bin/sh\necho user-owned\n");

    const result = ensureNbtShim({ homeDir, projectRoot });

    expect(result.status).toBe("conflict");
    expect(fs.readFileSync(shimPath, "utf-8")).toBe("#!/bin/sh\necho user-owned\n");
  });

  it("updates a previously managed nbt shim", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-home-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-project-"));
    const targetPath = path.join(projectRoot, "bin", "nbt");
    const shimPath = path.join(homeDir, ".local", "bin", "nbt");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    fs.writeFileSync(targetPath, "#!/bin/sh\n");
    fs.writeFileSync(shimPath, "#!/bin/sh\n# Managed by NiuBot: nbt shim\nexec '/old/nbt' \"$@\"\n");

    const result = ensureNbtShim({ homeDir, projectRoot });

    expect(result.status).toBe("updated");
    expect(fs.readFileSync(shimPath, "utf-8")).toContain(`exec '${targetPath}' "$@"`);
  });

  it("does not update the nbt shim during preflight", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-home-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-shim-project-"));
    const targetPath = path.join(projectRoot, "bin", "nbt");
    const shimPath = path.join(homeDir, ".local", "bin", "nbt");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "#!/bin/sh\n");

    const result = ensureRuntimeNbtShim({ homeDir, projectRoot, preflight: true });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("preflight run");
    expect(fs.existsSync(shimPath)).toBe(false);
  });
});
