import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dumpAgentStdout,
  getAgentStdoutLogFilePath,
  isAgentStdoutDumpEnabled,
} from "./agent-stdout-log.js";

describe("agent-stdout-log", () => {
  const tempHome = join(tmpdir(), `niubot-agent-stdout-test-${process.pid}`);

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("is disabled by default", () => {
    delete process.env.NIUBOT_DEBUG_AGENT_STDOUT;
    expect(isAgentStdoutDumpEnabled()).toBe(false);
    expect(dumpAgentStdout({
      backend: "cursor",
      reason: "complete",
      cmd: "cursor-agent",
      args: ["-p"],
      stdout: "ok",
      durationMs: 1,
    })).toBeUndefined();
  });

  it("accepts common truthy env values", () => {
    for (const value of ["1", "true", "yes", "on"]) {
      vi.stubEnv("NIUBOT_DEBUG_AGENT_STDOUT", value);
      expect(isAgentStdoutDumpEnabled()).toBe(true);
      vi.unstubAllEnvs();
    }
  });

  it("appends stdout dump to daily agent stdout log", () => {
    vi.stubEnv("NIUBOT_HOME", tempHome);
    vi.stubEnv("NIUBOT_DEBUG_AGENT_STDOUT", "1");
    mkdirSync(join(tempHome, "logs"), { recursive: true });

    const logPath = dumpAgentStdout({
      backend: "cursor",
      sessionId: "cursor_test",
      reason: "complete",
      cmd: "cursor-agent",
      args: ["--yolo", "-p"],
      cwd: "/tmp/workspace",
      stdinLength: 5,
      stdinPreview: "hello",
      stdout: '{"type":"result","result":"ok"}',
      durationMs: 1234,
      linesCollected: 2,
    });

    expect(logPath).toBe(getAgentStdoutLogFilePath(tempHome));
    const content = readFileSync(logPath!, "utf8");
    expect(content).toContain("backend=cursor");
    expect(content).toContain('sessionId=cursor_test');
    expect(content).toContain("reason=complete");
    expect(content).toContain('{"type":"result","result":"ok"}');
    expect(content).toContain("stdoutLength=");
  });
});
