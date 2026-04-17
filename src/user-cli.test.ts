import { describe, expect, it } from "vitest";
import { generateConfigTemplate, getSuggestedLiteModel } from "./user-cli.js";

describe("user-cli init model configuration", () => {
  it("suggests built-in lite models per backend", () => {
    expect(getSuggestedLiteModel("claude")).toBe("haiku");
    expect(getSuggestedLiteModel("codex")).toBe("gpt-5.4-mini");
    expect(getSuggestedLiteModel("traecli")).toBe("Gemini-3-Flash-Preview");
    expect(getSuggestedLiteModel("my-agent")).toBeUndefined();
  });

  it("writes chosen model settings into config.yaml", () => {
    const config = generateConfigTemplate("codex", undefined, "NiuBot", "app-id", "app-secret", "gpt-5.4", "gpt-5.4-mini");

    expect(config).toContain('model: "gpt-5.4"');
    expect(config).toContain('liteModel: "gpt-5.4-mini"');
    expect(config).not.toContain('# model: ""');
    expect(config).not.toContain('# liteModel: ""');
  });
});
