import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureBotProfileFile } from "./bot-profile.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ensureBotProfileFile", () => {
  it("creates bot_profile.md from legacy persona and instructions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-profile-"));
    tempDirs.push(dir);
    const botProfilePath = path.join(dir, "bot_profile.md");
    const personaPath = path.join(dir, "persona.md");
    const instructionsPath = path.join(dir, "instructions.md");
    fs.writeFileSync(personaPath, "legacy persona", "utf-8");
    fs.writeFileSync(instructionsPath, "legacy instructions", "utf-8");

    ensureBotProfileFile(botProfilePath, { personaPath, instructionsPath });

    const content = fs.readFileSync(botProfilePath, "utf-8");
    expect(content).toContain("# Bot Profile");
    expect(content).toContain("## Persona");
    expect(content).toContain("legacy persona");
    expect(content).toContain("## Instructions");
    expect(content).toContain("legacy instructions");
  });

  it("migrates legacy default files from the workspace root", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-profile-"));
    tempDirs.push(dir);
    const botDir = path.join(dir, "bot");
    const workspaceDir = path.join(dir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const botProfilePath = path.join(botDir, "bot_profile.md");
    fs.writeFileSync(path.join(workspaceDir, "persona.md"), "workspace persona", "utf-8");
    fs.writeFileSync(path.join(workspaceDir, "instructions.md"), "workspace instructions", "utf-8");

    ensureBotProfileFile(botProfilePath, { workspaceDirectory: workspaceDir });

    const content = fs.readFileSync(botProfilePath, "utf-8");
    expect(content).toContain("workspace persona");
    expect(content).toContain("workspace instructions");
  });

  it("does not create an empty effective profile from a default legacy instructions file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-profile-"));
    tempDirs.push(dir);
    const botProfilePath = path.join(dir, "bot_profile.md");
    const instructionsPath = path.join(dir, "instructions.md");
    fs.writeFileSync(instructionsPath, "# Bot Instructions\n\n在这里写这个 bot 的长期职责、做事规则和边界。\n", "utf-8");

    ensureBotProfileFile(botProfilePath, { instructionsPath });

    const content = fs.readFileSync(botProfilePath, "utf-8");
    expect(content).toContain("简洁清晰、有温度");
    expect(content).toContain("平实中文");
    expect(content).not.toContain("在这里写这个 bot 的长期职责");
  });
});
