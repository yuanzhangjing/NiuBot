import { describe, expect, it } from "vitest";
import OpencodeBackend, { resolveOpencodeDatabasePath } from "./opencode.js";

describe("OpenCode database path", () => {
  it("uses the path reported by the OpenCode CLI", () => {
    expect(resolveOpencodeDatabasePath({
      platform: "win32",
      home: "C:\\Users\\Zen",
      queryPath: () => "C:\\Users\\Zen\\AppData\\Local\\opencode\\opencode.db\r\n",
    })).toBe("C:\\Users\\Zen\\AppData\\Local\\opencode\\opencode.db");
  });

  it("falls back to platform data directories for older OpenCode versions", () => {
    expect(resolveOpencodeDatabasePath({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Local" },
      home: "C:\\Users\\Zen",
      queryPath: () => { throw new Error("unsupported command"); },
    })).toBe("C:\\Local\\opencode\\opencode.db");
    expect(resolveOpencodeDatabasePath({
      platform: "linux",
      env: { XDG_DATA_HOME: "/data" },
      home: "/home/zen",
      queryPath: () => "",
    })).toBe("/data/opencode/opencode.db");
  });
});

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
