import { describe, expect, it, vi } from "vitest";
import { OutputRewriter, type OutputRewriteConfig } from "./output-rewrite.js";

function enabledConfig(overrides: Partial<OutputRewriteConfig> = {}): OutputRewriteConfig {
  return {
    enabled: true,
    applyToBackends: ["codex"],
    provider: "anthropic-compatible",
    apiKeyEnv: "TEST_DEEPSEEK_KEY",
    baseURL: "https://api.deepseek.com/anthropic",
    model: "deepseek-v4-flash",
    timeoutMs: 15_000,
    ...overrides,
  };
}

describe("OutputRewriter", () => {
  it("returns the original text when rewriting is disabled", async () => {
    const createClient = vi.fn();
    const rewriter = new OutputRewriter({
      config: { enabled: false },
      env: {},
      createClient,
    });

    await expect(rewriter.rewrite({
      backendType: "codex",
      text: "original",
    })).resolves.toBe("original");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("only rewrites configured backends", async () => {
    const createClient = vi.fn();
    const rewriter = new OutputRewriter({
      config: enabledConfig(),
      env: { TEST_DEEPSEEK_KEY: "sk-test" },
      createClient,
    });

    await expect(rewriter.rewrite({
      backendType: "claude",
      text: "original",
    })).resolves.toBe("original");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("uses anthropic-compatible messages and keeps only text blocks", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "rewritten" },
      ],
    });
    const createClient = vi.fn(() => ({ messages: { create } }));
    const rewriter = new OutputRewriter({
      config: enabledConfig(),
      env: { TEST_DEEPSEEK_KEY: "sk-test" },
      createClient,
    });

    await expect(rewriter.rewrite({
      backendType: "codex",
      originalPrompt: "用户要查天气",
      text: "北京天气晴。",
    })).resolves.toBe("rewritten");

    expect(createClient).toHaveBeenCalledWith({
      apiKey: "sk-test",
      baseURL: "https://api.deepseek.com/anthropic",
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: "deepseek-v4-flash",
      temperature: 0.2,
      max_tokens: 4096,
      system: expect.stringContaining("你是回复改写器，不是对话助手。"),
      messages: [{
        role: "user",
        content: [
          "用户原始请求：",
          "<<<",
          "用户要查天气",
          ">>>",
          "",
          "原始回复：",
          "<<<",
          "北京天气晴。",
          ">>>",
        ].join("\n"),
      }],
    }), expect.objectContaining({
      timeout: 15_000,
    }));
  });

  it("uses the configured api key before reading apiKeyEnv", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "rewritten" }],
    });
    const createClient = vi.fn(() => ({ messages: { create } }));
    const rewriter = new OutputRewriter({
      config: enabledConfig({ apiKey: "sk-inline", apiKeyEnv: "TEST_DEEPSEEK_KEY" }),
      env: { TEST_DEEPSEEK_KEY: "sk-env" },
      createClient,
    });

    await expect(rewriter.rewrite({
      backendType: "codex",
      text: "original",
    })).resolves.toBe("rewritten");

    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "sk-inline",
    }));
  });

  it("falls back to the original text when the provider fails", async () => {
    const createClient = vi.fn(() => ({
      messages: {
        create: vi.fn().mockRejectedValue(new Error("provider failed")),
      },
    }));
    const rewriter = new OutputRewriter({
      config: enabledConfig(),
      env: { TEST_DEEPSEEK_KEY: "sk-test" },
      createClient,
    });

    await expect(rewriter.rewrite({
      backendType: "codex",
      text: "original",
    })).resolves.toBe("original");
  });

  it("falls back to the original text when the api key is missing", async () => {
    const createClient = vi.fn();
    const rewriter = new OutputRewriter({
      config: enabledConfig(),
      env: {},
      createClient,
    });

    await expect(rewriter.rewrite({
      backendType: "codex",
      text: "original",
    })).resolves.toBe("original");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("only enables text logging when explicitly configured", () => {
    expect(new OutputRewriter({ config: enabledConfig() }).shouldLogText()).toBe(false);
    expect(new OutputRewriter({ config: enabledConfig({ logText: true }) }).shouldLogText()).toBe(true);
  });
});
