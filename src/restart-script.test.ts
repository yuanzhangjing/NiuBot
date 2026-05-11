import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

describe("restart.sh", () => {
  test("does not use pkill -f for fallback service cleanup", () => {
    const script = readFileSync(path.resolve(__dirname, "../restart.sh"), "utf-8");

    expect(script).not.toMatch(/\bpkill\b[^\n]*\s-f\s/);
  });

  test("scoped fallback cleanup to the current script directory", () => {
    const script = readFileSync(path.resolve(__dirname, "../restart.sh"), "utf-8");

    expect(script).toContain("SCRIPT_DIR_REAL=");
    expect(script).toContain("process_cwd");
    expect(script).toContain('[ "$cwd" = "$SCRIPT_DIR_REAL" ]');
  });
});
