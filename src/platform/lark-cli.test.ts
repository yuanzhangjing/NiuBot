import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildLarkDefaultAsArgs,
  buildLarkProfileInitArgs,
  ensureLarkProfile,
  larkAutoInstallEnabled,
  larkCliConfigPath,
  needsLarkDefaultAs,
  needsLarkProfileInit,
  parseLarkCliProfiles,
  readLarkCliProfiles,
  recordLarkInstallAttempt,
  shouldAttemptLarkInstall,
  stripInheritedLarkIdentityEnv,
  type LarkCliRunResult,
  type LarkCliRunner,
} from "./lark-cli.js";

const temporaryDirectories: string[] = [];

function temporaryHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-lark-cli-"));
  temporaryDirectories.push(dir);
  return dir;
}

function writeProfiles(
  homeDir: string,
  apps: Array<{ name: string; appId: string; brand?: string; defaultAs?: string }>,
): void {
  const file = larkCliConfigPath(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ apps }, null, 2));
}

interface RunnerCall {
  file: string;
  args: string[];
  input?: string;
}

function fakeRunner(
  handler: (call: RunnerCall) => LarkCliRunResult,
): { runner: LarkCliRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: LarkCliRunner = (file, args, options) => {
    const call: RunnerCall = { file, args, input: options.input };
    calls.push(call);
    return handler(call);
  };
  return { runner, calls };
}

const ok = (stdout = ""): LarkCliRunResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "boom"): LarkCliRunResult => ({ status: 1, stdout: "", stderr });

const bot = { id: "NiuBot", appId: "cli_aaa", appSecret: "secret-aaa" };

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("lark-cli profile config", () => {
  it("parses apps from the official config shape", () => {
    const profiles = parseLarkCliProfiles(
      JSON.stringify({ apps: [{ name: "NiuBot", appId: "cli_aaa", brand: "lark", defaultAs: "bot", users: [] }] }),
    );
    expect(profiles).toEqual([{ name: "NiuBot", appId: "cli_aaa", brand: "lark", defaultAs: "bot" }]);
  });

  it("tolerates broken or unexpected config content", () => {
    expect(parseLarkCliProfiles("{not json")).toEqual([]);
    expect(parseLarkCliProfiles(JSON.stringify({ apps: "nope" }))).toEqual([]);
    expect(parseLarkCliProfiles(JSON.stringify({ apps: [null, 42, { name: "X", appId: "cli_x" }] }))).toEqual([
      { name: "X", appId: "cli_x", brand: undefined, defaultAs: undefined },
    ]);
  });

  it("reads profiles from the home directory and treats a missing file as empty", () => {
    const homeDir = temporaryHome();
    expect(readLarkCliProfiles(homeDir)).toEqual([]);
    writeProfiles(homeDir, [{ name: "CowBot", appId: "cli_cow" }]);
    expect(readLarkCliProfiles(homeDir)).toEqual([
      { name: "CowBot", appId: "cli_cow", brand: undefined, defaultAs: undefined },
    ]);
  });

  it("requires init only when the profile is missing or its appId changed", () => {
    const existing = [{ name: "NiuBot", appId: "cli_aaa", brand: "lark" }];
    expect(needsLarkProfileInit(existing, bot)).toBe(false);
    expect(needsLarkProfileInit(existing, { ...bot, appId: "cli_bbb" })).toBe(true);
    expect(needsLarkProfileInit([], bot)).toBe(true);
    expect(needsLarkProfileInit(existing, { ...bot, id: "CowBot" })).toBe(true);
  });

  it("pins the profile default identity to bot unless already set", () => {
    expect(needsLarkDefaultAs([{ name: "NiuBot", appId: "cli_aaa" }], bot)).toBe(true);
    expect(needsLarkDefaultAs([{ name: "NiuBot", appId: "cli_aaa", defaultAs: "auto" }], bot)).toBe(true);
    expect(needsLarkDefaultAs([{ name: "NiuBot", appId: "cli_aaa", defaultAs: "bot" }], bot)).toBe(false);
    expect(needsLarkDefaultAs([], bot)).toBe(true);
    expect(buildLarkDefaultAsArgs(bot)).toEqual(["config", "default-as", "bot", "--profile", "NiuBot"]);
  });

  it("builds the non-interactive init command with the secret on stdin", () => {
    const args = buildLarkProfileInitArgs(bot);
    expect(args).toEqual([
      "config",
      "init",
      "--app-id",
      "cli_aaa",
      "--app-secret-stdin",
      "--name",
      "NiuBot",
      "--brand",
      "feishu",
    ]);
    expect(buildLarkProfileInitArgs({ ...bot, brand: "lark" })).toContain("lark");
  });
});

describe("ensureLarkProfile", () => {
  it("keeps an existing profile and pins bot identity", async () => {
    const homeDir = temporaryHome();
    writeProfiles(homeDir, [{ name: "NiuBot", appId: "cli_aaa" }]);
    const { runner, calls } = fakeRunner(() => ok());
    await expect(ensureLarkProfile(bot, { homeDir, runner })).resolves.toBe("present");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["config", "default-as", "bot", "--profile", "NiuBot"]);
  });

  it("does nothing when both the profile and the bot default are already set", async () => {
    const homeDir = temporaryHome();
    writeProfiles(homeDir, [{ name: "NiuBot", appId: "cli_aaa", defaultAs: "bot" }]);
    const { runner, calls } = fakeRunner(() => ok());
    await expect(ensureLarkProfile(bot, { homeDir, runner })).resolves.toBe("present");
    expect(calls).toEqual([]);
  });

  it("runs config init with the secret on stdin, then pins bot identity", async () => {
    const homeDir = temporaryHome();
    const { runner, calls } = fakeRunner((call) => {
      if (call.args[1] === "init") writeProfiles(homeDir, [{ name: "NiuBot", appId: "cli_aaa" }]);
      return ok("OK: Configuration saved");
    });
    await expect(ensureLarkProfile(bot, { homeDir, runner })).resolves.toBe("created");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.file).toBe("lark-cli");
    expect(calls[0]?.args).toContain("--app-secret-stdin");
    expect(calls[0]?.input).toBe("secret-aaa");
    expect(calls[0]?.args.join(" ")).not.toContain("secret-aaa");
    expect(calls[1]?.args).toEqual(["config", "default-as", "bot", "--profile", "NiuBot"]);
  });

  it("reports failed without throwing when the CLI errors", async () => {
    const homeDir = temporaryHome();
    const { runner } = fakeRunner(() => fail("no such command"));
    await expect(ensureLarkProfile(bot, { homeDir, runner })).resolves.toBe("failed");
  });
});

describe("lark install throttle", () => {
  it("allows the first attempt and blocks repeats inside the retry window", () => {
    const homeDir = temporaryHome();
    expect(shouldAttemptLarkInstall(homeDir)).toBe(true);
    recordLarkInstallAttempt(homeDir);
    expect(shouldAttemptLarkInstall(homeDir)).toBe(false);
    expect(shouldAttemptLarkInstall(homeDir, Date.now() + 7 * 60 * 60 * 1000)).toBe(true);
  });
});

describe("stripInheritedLarkIdentityEnv", () => {
  it("removes inherited lark-cli identity variables and reports them", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      LARKSUITE_CLI_PROFILE: "NiuBot",
      LARKSUITE_CLI_DEFAULT_AS: "bot",
      LARKSUITE_CLI_APP_ID: "cli_x",
    };
    const removed = stripInheritedLarkIdentityEnv(env);
    expect(removed.sort()).toEqual(["LARKSUITE_CLI_APP_ID", "LARKSUITE_CLI_DEFAULT_AS", "LARKSUITE_CLI_PROFILE"]);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("leaves unrelated variables alone", () => {
    const env: NodeJS.ProcessEnv = { NIUBOT_BOT_NAME: "NiuBot" };
    expect(stripInheritedLarkIdentityEnv(env)).toEqual([]);
    expect(env["NIUBOT_BOT_NAME"]).toBe("NiuBot");
  });
});

describe("larkAutoInstallEnabled", () => {
  it("defaults to enabled and honors the opt-out values", () => {
    expect(larkAutoInstallEnabled({})).toBe(true);
    expect(larkAutoInstallEnabled({ NIUBOT_LARK_CLI_AUTO_INSTALL: "0" })).toBe(false);
    expect(larkAutoInstallEnabled({ NIUBOT_LARK_CLI_AUTO_INSTALL: "false" })).toBe(false);
    expect(larkAutoInstallEnabled({ NIUBOT_LARK_CLI_AUTO_INSTALL: "off" })).toBe(false);
    expect(larkAutoInstallEnabled({ NIUBOT_LARK_CLI_AUTO_INSTALL: "1" })).toBe(true);
  });
});
