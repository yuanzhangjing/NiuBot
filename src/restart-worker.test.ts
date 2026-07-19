import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseNpmPackFilename, resolveRestartSourceDirectory } from "./restart-worker.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("restart worker helpers", () => {
  it("parses npm pack JSON without trusting paths", () => {
    expect(parseNpmPackFilename('[{"filename":"yuanzhangjing-niubot-1.2.3.tgz"}]'))
      .toBe("yuanzhangjing-niubot-1.2.3.tgz");
    expect(() => parseNpmPackFilename('[{"filename":"../outside.tgz"}]')).toThrow();
  });

  it("keeps npm releases independent from configured source directories", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-restart-worker-"));
    tempDirs.push(home);
    fs.writeFileSync(path.join(home, "config.yaml"), "restart:\n  sourceDirectory: /dev/source\n");
    expect(resolveRestartSourceDirectory({
      niubotHome: home,
      workerRuntimePath: "/release/package",
      env: { NIUBOT_RUNTIME_MODE: "npm-release", NIUBOT_SOURCE_DIR: "/release/package" },
    })).toBe("/release/package");
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
