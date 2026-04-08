import { describe, expect, it } from "vitest";
import { buildResponseFooter, formatModelName } from "./footer.js";

describe("footer formatting", () => {
  it("formats GPT model names for display", () => {
    expect(formatModelName("gpt-5.4")).toBe("GPT-5.4");
  });

  it("shows the chosen context size approximation and model name", () => {
    expect(buildResponseFooter({
      sessionKey: "session_abcd1234",
      turnCount: 3,
      contextTokens: 20523,
      compactCount: 2,
      model: "gpt-5.4",
    })).toBe("abcd1234 · #3 · 20.5k · compact×2 · GPT-5.4");
  });
});
