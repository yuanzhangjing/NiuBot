import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildNiubotEnv } from "./agent/cli-base.js";
import { getBundledNiubotBinDir, prependNiubotBinToPath } from "./niubot-cli.js";

describe("niubot CLI path helpers", () => {
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
});
