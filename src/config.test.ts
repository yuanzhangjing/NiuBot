import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, NIUBOT_HOME } from "./config.js";

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

    expect(config.bots[0]?.botProfilePath).toBe(path.join(NIUBOT_HOME, "NiuBot", "bot_profile.md"));
    expect(config.bots[0]?.personaPath).toBeUndefined();
    expect(config.bots[0]?.instructionsPath).toBeUndefined();
    expect(config.bots[0]?.projectContextPath).toBeUndefined();
  });

  it("keeps explicit context paths for existing custom configs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-config-"));
    tempDirs.push(dir);
    const personaPath = path.join(dir, "persona.md");
    const instructionsPath = path.join(dir, "instructions.md");
    const botProfilePath = path.join(dir, "bot_profile.md");
    const projectContextPath = path.join(dir, "project.md");
    const configPath = path.join(dir, "config.yaml");
    fs.writeFileSync(configPath, `
bots:
  - id: NiuBot
    appId: app-id
    appSecret: app-secret
    workingDirectory: ${dir}/workspace
    botProfilePath: ${botProfilePath}
    personaPath: ${personaPath}
    instructionsPath: ${instructionsPath}
    projectContextPath: ${projectContextPath}
`, "utf-8");

    const config = loadConfig(configPath);

    expect(config.bots[0]?.botProfilePath).toBe(botProfilePath);
    expect(config.bots[0]?.personaPath).toBe(personaPath);
    expect(config.bots[0]?.instructionsPath).toBe(instructionsPath);
    expect(config.bots[0]?.projectContextPath).toBe(projectContextPath);
  });

  it("loads optional output rewrite settings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-config-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "config.yaml");
    fs.writeFileSync(configPath, `
bots:
  - id: NiuBot
    appId: app-id
    appSecret: app-secret
    workingDirectory: ${dir}/workspace
outputRewrite:
  enabled: true
  applyToBackends:
    - codex
  provider: anthropic-compatible
  baseURL: https://api.deepseek.com/anthropic
  apiKeyEnv: ANTHROPIC_API_KEY
  model: deepseek-v4-flash
  timeoutMs: 15000
  apiKey: dummy
  logText: true
  marker_enable: false
  marker:
    enabled: true
    text: "📝 <font color='grey'>rewritten by deepseek-v4-flash</font>"
`, "utf-8");

    const config = loadConfig(configPath);

    expect(config.outputRewrite).toEqual({
      enabled: true,
      applyToBackends: ["codex"],
      provider: "anthropic-compatible",
      baseURL: "https://api.deepseek.com/anthropic",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      model: "deepseek-v4-flash",
      timeoutMs: 15000,
      apiKey: "dummy",
      logText: true,
      maxTokens: undefined,
      prompt: undefined,
      marker: {
        enabled: false,
        text: "📝 <font color='grey'>rewritten by deepseek-v4-flash</font>",
      },
    });
  });

  it("loads optional restart source directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-config-"));
    tempDirs.push(dir);
    const sourceDir = path.join(dir, "source");
    const configPath = path.join(dir, "config.yaml");
    fs.writeFileSync(configPath, `
bots:
  - id: NiuBot
    appId: app-id
    appSecret: app-secret
    workingDirectory: ${dir}/workspace
restart:
  sourceDirectory: ${sourceDir}
`, "utf-8");

    const config = loadConfig(configPath);

    expect(config.restart).toEqual({
      sourceDirectory: sourceDir,
    });
  });
});
