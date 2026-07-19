import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RestartStateWriter } from "./restart-state.js";

describe("restart state", () => {
  it("keeps restart metadata across phase updates", () => {
    const botDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-restart-state-"));
    try {
      const writer = new RestartStateWriter(botDirectory, "restart-a", "2026-07-19T00:00:00.000Z");
      writer.write("build_candidate", { oldPid: 123, candidateRelease: "release-a" });
      expect(writer.write("preflight_candidate")).toMatchObject({
        id: "restart-a",
        phase: "preflight_candidate",
        oldPid: 123,
        candidateRelease: "release-a",
      });
    } finally {
      fs.rmSync(botDirectory, { recursive: true, force: true });
    }
  });
});
