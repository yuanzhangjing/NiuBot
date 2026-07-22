import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PREFLIGHT_TIMEOUT_MS,
  parseNpmPackFilename,
  resolvePreflightTimeoutMs,
  resolveRestartSourceDirectory,
} from "./restart-worker.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("restart worker helpers", () => {
  it("uses a Windows-safe configurable preflight timeout", () => {
    expect(DEFAULT_PREFLIGHT_TIMEOUT_MS).toBe(120_000);
    expect(resolvePreflightTimeoutMs({})).toBe(120_000);
    expect(resolvePreflightTimeoutMs({ NIUBOT_RESTART_PREFLIGHT_TIMEOUT: "90" })).toBe(90_000);
    expect(resolvePreflightTimeoutMs({ NIUBOT_RESTART_PREFLIGHT_TIMEOUT: "invalid" })).toBe(120_000);
    expect(resolvePreflightTimeoutMs({ NIUBOT_RESTART_PREFLIGHT_TIMEOUT: "0" })).toBe(120_000);
  });

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
