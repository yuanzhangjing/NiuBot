import { describe, expect, it } from "vitest";
import { buildResponseFooter, formatModelName } from "./footer.js";

describe("footer formatting", () => {
  it("formats GPT model names for display", () => {
    expect(formatModelName("gpt-5.4")).toBe("GPT-5.4");
  });

  it("shows the chosen context size approximation and model name", () => {
    expect(buildResponseFooter({
      sessionId: "abcd1234",
      turnCount: 3,
      contextTokens: 20523,
      compactCount: 2,
      model: "gpt-5.4",
    })).toBe("abcd1234 · #3 · 20.5k · 📦×2 · GPT-5.4");
  });

  it("truncates long agent session IDs to 8 chars", () => {
    expect(buildResponseFooter({
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      turnCount: 3,
    })).toBe("550e8400 · #3");
  });
});
