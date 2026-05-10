import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadConfig", () => {
  it("does not assign a workspace project context path by default", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-config-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "config.yaml");
    fs.writeFileSync(configPath, `
bots:
  - id: NiuBot
    appId: app-id
    appSecret: app-secret
    workingDirectory: ${dir}/workspace
`, "utf-8");

    const config = loadConfig(configPath);

    expect(config.bots[0]?.personaPath).toBe(path.join(dir, "workspace", "persona.md"));
    expect(config.bots[0]?.instructionsPath).toBe(path.join(dir, "workspace", "instructions.md"));
    expect(config.bots[0]?.projectContextPath).toBeUndefined();
  });

  it("keeps explicit context paths for existing custom configs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-config-"));
    tempDirs.push(dir);
    const personaPath = path.join(dir, "persona.md");
    const instructionsPath = path.join(dir, "instructions.md");
    const projectContextPath = path.join(dir, "project.md");
    const configPath = path.join(dir, "config.yaml");
    fs.writeFileSync(configPath, `
bots:
  - id: NiuBot
    appId: app-id
    appSecret: app-secret
    workingDirectory: ${dir}/workspace
    personaPath: ${personaPath}
    instructionsPath: ${instructionsPath}
    projectContextPath: ${projectContextPath}
`, "utf-8");

    const config = loadConfig(configPath);

    expect(config.bots[0]?.personaPath).toBe(personaPath);
    expect(config.bots[0]?.instructionsPath).toBe(instructionsPath);
    expect(config.bots[0]?.projectContextPath).toBe(projectContextPath);
  });
});
