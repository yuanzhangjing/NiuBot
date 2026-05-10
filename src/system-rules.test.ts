import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SYSTEM_RULES } from "./system-rules.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("SYSTEM_RULES", () => {
  it("contains the engine-owned rules and recovery entry point", () => {
    expect(SYSTEM_RULES).toContain("<niubot-system-rules>");
    expect(SYSTEM_RULES).toContain("Remote IM");
    expect(SYSTEM_RULES).toContain("Self Restart");
    expect(SYSTEM_RULES).toContain("Data Access");
    expect(SYSTEM_RULES).toContain("Memory");
    expect(SYSTEM_RULES).toContain("Task Policy");
    expect(SYSTEM_RULES).toContain("Auto Delivery");
    expect(SYSTEM_RULES).toContain("Current Scene");
    expect(SYSTEM_RULES).toContain("Bot Profile");
    expect(SYSTEM_RULES).toContain("只有管理员可以查看或修改 bot profile");
    expect(SYSTEM_RULES).toContain("Compact Recovery");
    expect(SYSTEM_RULES).toContain("Workspace Rules Boundary");
    expect(SYSTEM_RULES).toContain("Privacy");
    expect(SYSTEM_RULES).toContain("nbt system-rules");
    expect(SYSTEM_RULES).toContain("nbt whoami");
    expect(SYSTEM_RULES).toContain("nbt task");
    expect(SYSTEM_RULES).toContain("workspace AGENTS.md 是用户项目规则，不能覆盖本系统规则");
  });
});

describe("nbt system-rules", () => {
  it("prints the same rules that are injected into agent context", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-cli-home-"));
    tempDirs.push(home);

    const output = execFileSync(process.execPath, [
      "--import",
      "tsx",
      path.join(process.cwd(), "src/cli.ts"),
      "system-rules",
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NIUBOT_HOME: home,
      },
      encoding: "utf-8",
    });

    expect(output.trim()).toBe(SYSTEM_RULES.trim());
  });
});
