import { closeSync, mkdtempSync, openSync, realpathSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  isProcessAlive,
  queryProcessFileDescriptorPath,
  queryProcessWorkingDirectory,
  terminateSpawnedProcessTree,
  waitForProcessExit,
  waitForProcessStartMarker,
} from "./process.js";

const tempDirectories: string[] = [];
const childPids: number[] = [];

afterEach(async () => {
  for (const pid of childPids.splice(0)) {
    terminateSpawnedProcessTree(pid, true);
    await waitForProcessExit(pid, 1_000);
  }
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("process platform helpers", () => {
  test("reads a stable OS-owned marker for a live process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    const first = waitForProcessStartMarker(process.pid);
    const second = waitForProcessStartMarker(process.pid);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  test("does not invent a marker for an invalid PID", () => {
    expect(waitForProcessStartMarker(-1, process.platform, 1, 1)).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("process metadata", () => {
  test("reads a legacy process working directory and stdout file", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "niubot-process-metadata-"));
    tempDirectories.push(directory);
    const logFile = path.join(directory, "engine.log");
    const logFd = openSync(logFile, "a");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: directory,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    closeSync(logFd);
    if (!child.pid) throw new Error("test process did not start");
    childPids.push(child.pid);
    child.unref();

    expect(realpathSync(queryProcessWorkingDirectory(child.pid)!)).toBe(realpathSync(directory));
    expect(realpathSync(queryProcessFileDescriptorPath(child.pid, 1)!)).toBe(realpathSync(logFile));
  });
});
