import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand, runCommandSync } from "./command.js";

describe("runCommand", () => {
  it("executes without a shell and captures output", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('ok')"]);
    expect(result.stdout).toBe("ok");
    expect(result.exitCode).toBe(0);
  });

  it("returns bounded command errors", async () => {
    await expect(runCommand(process.execPath, ["-e", "process.stderr.write('bad');process.exit(2)"]))
      .rejects.toThrow(/Command exited with code 2[\s\S]*bad/);
  });

  it("supports the same executable resolution synchronously", () => {
    const result = runCommandSync(process.execPath, ["-e", "process.stdout.write('sync')"]);
    expect(result.stdout).toBe("sync");
  });

  it("terminates timed-out process groups", async () => {
    await expect(runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 50 }))
      .rejects.toThrow(/timed out/);
  });

  it.skipIf(process.platform !== "win32")("executes npm-style cmd shims on Windows", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-command-"));
    const command = path.join(directory, "fixture.cmd");
    fs.writeFileSync(command, "@echo off\r\necho %~1\r\n");
    const result = await runCommand(command, ["hello world"], { timeoutMs: 5_000 });
    expect(result.stdout.trim()).toBe("hello world");
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
