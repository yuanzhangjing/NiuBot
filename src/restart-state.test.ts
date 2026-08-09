import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { markAutoUpdateReported, readRestartState, RestartStateWriter } from "./restart-state.js";

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
      expect(readRestartState(writer.stateFile, "restart-a")?.phase).toBe("preflight_candidate");
      expect(readRestartState(writer.stateFile, "another-restart")).toBeUndefined();
    } finally {
      fs.rmSync(botDirectory, { recursive: true, force: true });
    }
  });

  it("keeps autoUpdate flag across phase updates for auto-upgrade workers", () => {
    const botDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-restart-state-"));
    try {
      const writer = new RestartStateWriter(botDirectory, "restart-auto", "2026-07-19T00:00:00.000Z", true);
      writer.write("started");
      writer.write("preflight_candidate");
      const final = writer.write("success");
      // autoUpdate 在构造时固定，后续 write 不丢失（修复：旧实现每次 write 覆盖为 undefined）
      expect(final.autoUpdate).toBe(true);
      expect(readRestartState(writer.stateFile, "restart-auto")?.autoUpdate).toBe(true);

      // 手动升级 worker：autoUpdate 默认 false，不误报
      const manual = new RestartStateWriter(botDirectory, "restart-manual", "2026-07-19T00:00:00.000Z");
      manual.write("started");
      manual.write("success");
      expect(readRestartState(manual.stateFile, "restart-manual")?.autoUpdate).toBe(false);
    } finally {
      fs.rmSync(botDirectory, { recursive: true, force: true });
    }
  });

  it("persists the auto-update report marker across state reads", () => {
    const botDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-restart-state-"));
    try {
      const writer = new RestartStateWriter(botDirectory, "restart-auto", "2026-07-19T00:00:00.000Z", true);
      writer.write("success");

      expect(markAutoUpdateReported(writer.stateFile, "restart-auto")).toBe(true);
      expect(readRestartState(writer.stateFile, "restart-auto")?.autoUpdateReportedAt).toBeTruthy();
      expect(markAutoUpdateReported(writer.stateFile, "restart-auto")).toBe(true);
      expect(markAutoUpdateReported(writer.stateFile, "another-restart")).toBe(false);
    } finally {
      fs.rmSync(botDirectory, { recursive: true, force: true });
    }
  });
});
