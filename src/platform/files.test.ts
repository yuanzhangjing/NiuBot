import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recoverFileReplacementSync, removeFileSync, replaceFileSync } from "./files.js";

describe("cross-platform file operations", () => {
  it("atomically replaces and removes a state file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-files-"));
    const source = path.join(directory, "state.tmp");
    const destination = path.join(directory, "state.json");
    fs.writeFileSync(source, "new");
    fs.writeFileSync(destination, "old");
    replaceFileSync(source, destination);
    expect(fs.readFileSync(destination, "utf-8")).toBe("new");
    expect(removeFileSync(destination)).toBe(true);
    expect(removeFileSync(destination)).toBe(false);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("uses the recoverable Windows replacement path for an existing file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-files-win-"));
    const source = path.join(directory, "state.tmp");
    const destination = path.join(directory, "state.json");
    fs.writeFileSync(source, "new");
    fs.writeFileSync(destination, "old");
    replaceFileSync(source, destination, 5, "win32");
    expect(fs.readFileSync(destination, "utf-8")).toBe("new");
    expect(fs.readdirSync(directory)).toEqual(["state.json"]);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("restores the destination after interruption between Windows renames", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-files-recover-"));
    const destination = path.join(directory, "state.json");
    const backup = `${destination}.replace-backup`;
    fs.writeFileSync(destination, "old");
    fs.renameSync(destination, backup);
    recoverFileReplacementSync(destination);
    expect(fs.readFileSync(destination, "utf-8")).toBe("old");
    expect(fs.existsSync(backup)).toBe(false);
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
