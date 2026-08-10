import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  restartCompletion,
  restartPhaseLabel,
  waitForRestartCompletion,
} from "./restart-progress.js";
import { RestartStateWriter } from "./restart-state.js";

describe("restart progress", () => {
  it("classifies successful, rolled-back, and failed terminal states", () => {
    const base = {
      id: "restart-a",
      startedAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:01.000Z",
    };
    expect(restartCompletion({ ...base, phase: "success" })).toBe("success");
    expect(restartCompletion({ ...base, phase: "rollback_success" })).toBe("rolled-back");
    expect(restartCompletion({ ...base, phase: "failed" })).toBe("failed");
    expect(restartCompletion({ ...base, phase: "health_check_candidate" })).toBeUndefined();
  });

  it("reports phase changes and waits for the matching restart", async () => {
    const botDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-restart-progress-"));
    try {
      const other = new RestartStateWriter(botDirectory, "restart-old", "2026-07-29T00:00:00.000Z");
      other.write("success");
      const writer = new RestartStateWriter(botDirectory, "restart-a", "2026-07-30T00:00:00.000Z");
      const phases: string[] = [];
      setTimeout(() => writer.write("build_npm_candidate"), 10);

      const result = await waitForRestartCompletion({
        stateFile: writer.stateFile,
        restartId: "restart-a",
        workerPid: 123,
        pollIntervalMs: 2,
        timeoutMs: 1000,
        processAlive: () => true,
        onPhase: (state) => {
          phases.push(state.phase);
          // 只在观察到中间阶段后写入终态，避免测试依赖系统定时器精度。
          if (state.phase === "build_npm_candidate") writer.write("success");
        },
      });

      expect(result.completion).toBe("success");
      expect(phases).toEqual(["build_npm_candidate", "success"]);
    } finally {
      fs.rmSync(botDirectory, { recursive: true, force: true });
    }
  });

  it("fails when the worker exits without a terminal state", async () => {
    const botDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-restart-progress-exit-"));
    try {
      const writer = new RestartStateWriter(botDirectory, "restart-a", "2026-07-30T00:00:00.000Z");
      writer.write("started");
      await expect(waitForRestartCompletion({
        stateFile: writer.stateFile,
        restartId: "restart-a",
        workerPid: 123,
        pollIntervalMs: 2,
        timeoutMs: 100,
        processAlive: () => false,
      })).rejects.toThrow("exited before recording a final result");
    } finally {
      fs.rmSync(botDirectory, { recursive: true, force: true });
    }
  });

  it("has no default overall timeout while the worker remains alive", async () => {
    vi.useFakeTimers();
    const botDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-restart-progress-long-"));
    try {
      const writer = new RestartStateWriter(botDirectory, "restart-a", "2026-07-30T00:00:00.000Z");
      writer.write("started");
      const waiting = waitForRestartCompletion({
        stateFile: writer.stateFile,
        restartId: "restart-a",
        workerPid: 123,
        pollIntervalMs: 60_000,
        processAlive: () => true,
      });
      setTimeout(() => writer.write("success"), 21 * 60_000);
      await vi.advanceTimersByTimeAsync(21 * 60_000);

      await expect(waiting).resolves.toMatchObject({ completion: "success" });
    } finally {
      vi.useRealTimers();
      fs.rmSync(botDirectory, { recursive: true, force: true });
    }
  });

  it("formats user-facing update phases", () => {
    expect(restartPhaseLabel("build_npm_candidate", "1.2.3")).toBe("Installing 1.2.3");
    expect(restartPhaseLabel("health_check_candidate")).toBe("Checking new version");
  });
});
