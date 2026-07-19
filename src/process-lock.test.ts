import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireProcessLock } from "./process-lock.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("process lock", () => {
  it("rejects another owner while the lock process is alive", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-lock-"));
    tempDirs.push(directory);
    const lockFile = path.join(directory, "run", "operation.lock");
    const release = acquireProcessLock(lockFile, "Operation");
    expect(() => acquireProcessLock(lockFile, "Operation")).toThrow(/already running/);
    release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("replaces a stale lock", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-lock-"));
    tempDirs.push(directory);
    const lockFile = path.join(directory, "operation.lock");
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: 2_147_483_647,
      processStartMarker: "stale",
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    const release = acquireProcessLock(lockFile, "Operation");
    release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("honors a live legacy PID-only restart lock", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-lock-"));
    tempDirs.push(directory);
    const lockFile = path.join(directory, "restart.lock");
    fs.writeFileSync(lockFile, `${process.pid}\n`);
    expect(() => acquireProcessLock(lockFile, "Restart")).toThrow(/already running/);
  });
});
