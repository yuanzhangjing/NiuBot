import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSharedRuntimeRoot } from "./shared-runtime.js";

describe("shared runtime path", () => {
  it("uses the per-user Unix store", () => {
    expect(resolveSharedRuntimeRoot({
      env: {},
      homeDir: "/Users/tester",
      platform: "darwin",
    })).toBe("/Users/tester/.local/niubot");
  });

  it("uses LOCALAPPDATA on Windows", () => {
    expect(resolveSharedRuntimeRoot({
      env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
      homeDir: "C:\\Users\\tester",
      platform: "win32",
    })).toBe("C:\\Users\\tester\\AppData\\Local\\NiuBot");
  });

  it("supports an explicit isolated store override", () => {
    const expected = path.resolve("tmp", "shared-store");
    expect(resolveSharedRuntimeRoot({
      env: { NIUBOT_SHARED_STORE: path.join("tmp", "shared-store") },
      platform: process.platform,
    })).toBe(expected);
  });
});
