import { describe, expect, it } from "vitest";
import OpencodeBackend from "./opencode.js";

describe("OpencodeBackend error parsing", () => {
  it("keeps the original OpenCode error detail", () => {
    const backend = new OpencodeBackend();
    const session = backend.buildSession({ workingDirectory: "/tmp" });

    const parsed = backend.parseOutput(JSON.stringify({
      type: "error",
      error: {
        data: {
          message: "provider temporarily unavailable",
        },
      },
    }), session);

    expect(parsed.text).toBe("");
    expect(parsed.error).toBe("provider temporarily unavailable");
    expect(parsed.failed).toBe(true);
  });
});
