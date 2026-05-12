import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

describe("restart.sh", () => {
  const readScript = () => readFileSync(path.resolve(__dirname, "../restart.sh"), "utf-8");

  test("does not use pkill -f for fallback service cleanup", () => {
    const script = readScript();

    expect(script).not.toMatch(/\bpkill\b[^\n]*\s-f\s/);
  });

  test("scoped fallback cleanup to the current script directory", () => {
    const script = readScript();

    expect(script).toContain("SCRIPT_DIR_REAL=");
    expect(script).toContain("process_cwd");
    expect(script).toContain('[ "$cwd" = "$SCRIPT_DIR_REAL" ]');
  });

  test("uses release directories and last-known-good instead of dist.bak rollback", () => {
    const script = readScript();

    expect(script).toContain("RELEASES_DIR=");
    expect(script).toContain("CURRENT_LINK=");
    expect(script).toContain("PREVIOUS_LINK=");
    expect(script).toContain("LKG_LINK=");
    expect(script).toContain("last-known-good");
    expect(script).not.toContain("dist.bak");
  });

  test("updates last-known-good only after candidate health check passes", () => {
    const script = readScript();
    const healthSuccessIndex = script.indexOf("candidate health check passed");
    const lkgUpdateIndex = script.indexOf("last-known-good updated");

    expect(healthSuccessIndex).toBeGreaterThan(-1);
    expect(lkgUpdateIndex).toBeGreaterThan(healthSuccessIndex);
  });

  test("passes the current bot name to the detached restart script", () => {
    const pipeline = readFileSync(path.resolve(__dirname, "core/pipeline.ts"), "utf-8");

    expect(pipeline).toContain("NIUBOT_BOT_NAME: this.botIdentity.name");
  });
});
