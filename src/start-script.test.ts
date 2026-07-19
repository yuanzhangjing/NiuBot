import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("start.sh compatibility entry", () => {
  it("delegates lifecycle management to the Node user CLI", () => {
    const script = readFileSync(path.resolve(import.meta.dirname, "../start.sh"), "utf-8");
    expect(script).toContain("dist/user-cli.js");
    expect(script).not.toContain("nohup");
    expect(script).not.toContain("curl");
    expect(script).not.toContain("kill -");
  });
});
