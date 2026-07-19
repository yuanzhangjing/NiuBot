import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { removeFileSync, replaceFileSync } from "./files.js";

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
});
