import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_BACKEND_LIST, DEFAULT_LITE_MODELS, loadConfig, NIUBOT_HOME, normalizeBackend } from "./config.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadConfig", () => {
  it("rejects unsupported custom backend names", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-config-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "config.yaml");
    fs.writeFileSync(configPath, `
bots:
  - id: NiuBot
    backend: my-agent
    appId: app-id
    appSecret: app-secret
    workingDirectory: ${dir}/workspace
`, "utf-8");

    expect(() => loadConfig(configPath)).toThrow(/unsupported backend 'my-agent'/);
  });

  it("registers cursor as a built-in backend with aliases and lite model", () => {
    expect(BUILTIN_BACKEND_LIST).toContain("cursor");
    expect(normalizeBackend("cursor")).toBe("cursor");
    expect(normalizeBackend("cursor-agent")).toBe("cursor");
    expect(DEFAULT_LITE_MODELS.cursor).toBe("composer-2.5-fast");
  });

  it("registers pi as a built-in backend with aliases and lite model", () => {
    expect(BUILTIN_BACKEND_LIST).toContain("pi");
    expect(normalizeBackend("pi")).toBe("pi");
    expect(normalizeBackend("pi-agent")).toBe("pi");
    expect(normalizeBackend("pi-coding-agent")).toBe("pi");
    expect(DEFAULT_LITE_MODELS.pi).toBe("deepseek-v4-flash");
  });

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

  it("ignores legacy output rewrite settings", () => {
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

    expect(config.bots[0]?.id).toBe("NiuBot");
    expect((config as Record<string, unknown>).outputRewrite).toBeUndefined();
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
