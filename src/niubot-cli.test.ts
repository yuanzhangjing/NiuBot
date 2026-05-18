import path from "node:path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildNiubotEnv } from "./agent/cli-base.js";
import { getBundledNiubotBinDir, prependNiubotBinToPath } from "./niubot-cli.js";

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

    expect(prependNiubotBinToPath(original)).toBe(
      `${getBundledNiubotBinDir()}:${original}`,
    );
  });

  it("does not prepend the repo-local niubot bin directory twice", () => {
    const original = `${getBundledNiubotBinDir()}:/usr/bin:/bin`;

    expect(prependNiubotBinToPath(original)).toBe(original);
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
});
