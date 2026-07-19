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

  it("bounds captured command output", async () => {
    await expect(runCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(10000))"],
      { maxOutputBytes: 100 },
    )).rejects.toThrow(/output exceeded 100 bytes/);
  });

  it.skipIf(process.platform !== "win32")("executes npm-style cmd shims on Windows", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-command-"));
    const directory = path.join(root, "path with spaces");
    fs.mkdirSync(directory);
    const command = path.join(directory, "fixture.cmd");
    fs.writeFileSync(command, "@echo off\r\nnode -e \"process.stdout.write(JSON.stringify(process.argv.slice(1)))\" -- %*\r\n");
    try {
      const values = ["hello world", "a&b", "(group)", "quote\\\"value"];
      const result = await runCommand(command, values, { timeoutMs: 5_000 });
      expect(JSON.parse(result.stdout)).toEqual(values);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
