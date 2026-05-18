import { execFileSync, spawnSync } from "node:child_process";
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
    expect(SYSTEM_RULES).toContain("User-facing Identity");
    expect(SYSTEM_RULES).toContain("对用户回复时，你就是当前 Bot");
    expect(SYSTEM_RULES).toContain("不要把 agent、backend、模型、NiuBot Engine 或 session 当作用户可见身份");
    expect(SYSTEM_RULES).toContain("Current Scene");
    expect(SYSTEM_RULES).toContain("Bot Profile");
    expect(SYSTEM_RULES).toContain("只有管理员可以查看或修改 bot profile");
    expect(SYSTEM_RULES).toContain("bot profile 只放 bot 级长期人格、语气和抽象行为规则");
    expect(SYSTEM_RULES).toContain("不放具体项目、目录结构、任务进度或实现细节");
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

  it("can print rules outside an agent session", () => {
    const env = { ...process.env };
    delete env["NIUBOT_HOME"];
    delete env["NIUBOT_AGENT_SESSION"];

    const output = execFileSync(process.execPath, [
      "--import",
      "tsx",
      path.join(process.cwd(), "src/cli.ts"),
      "system-rules",
    ], {
      cwd: process.cwd(),
      env,
      encoding: "utf-8",
    });

    expect(output.trim()).toBe(SYSTEM_RULES.trim());
  });

  it("rejects data commands outside an agent session", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-cli-home-"));
    tempDirs.push(home);
    const env = {
      ...process.env,
      NIUBOT_HOME: home,
    };
    delete env["NIUBOT_AGENT_SESSION"];

    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      path.join(process.cwd(), "src/cli.ts"),
      "messages",
      "list",
    ], {
      cwd: process.cwd(),
      env,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("nbt is for NiuBot agent sessions");
  });
});
