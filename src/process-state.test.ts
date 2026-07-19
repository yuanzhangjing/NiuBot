import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearProcessState, getProcessStatePath, readProcessState, writeProcessState, type EngineProcessState } from "./process-state.js";

const tempDirs: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-state-"));
  tempDirs.push(home);
  return home;
}

function engine(instanceId = "instance-a"): EngineProcessState {
  return {
    pid: 123,
    instanceId,
    startedAt: "2026-07-19T00:00:00.000Z",
    endpoint: "/tmp/engine.sock",
    endpointKind: "unix-socket",
    controlToken: "secret",
    version: "1.2.3",
    runtimePath: "/opt/niubot",
    nodePath: "/usr/bin/node",
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("process state", () => {
  it("writes and reads a validated atomic state file", () => {
    const home = makeHome();
    writeProcessState(home, engine());
    expect(readProcessState(home)?.processes.engine).toEqual(engine());
    if (process.platform !== "win32") {
      expect(fs.statSync(getProcessStatePath(home)).mode & 0o777).toBe(0o600);
    }
    expect(fs.readdirSync(path.dirname(getProcessStatePath(home))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not clear state owned by a newer process", () => {
    const home = makeHome();
    writeProcessState(home, engine("new-instance"));
    expect(clearProcessState(home, "old-instance")).toBe(false);
    expect(readProcessState(home)?.processes.engine.instanceId).toBe("new-instance");
    expect(clearProcessState(home, "new-instance")).toBe(true);
  });

  it("ignores malformed state", () => {
    const home = makeHome();
    fs.mkdirSync(path.dirname(getProcessStatePath(home)), { recursive: true });
    fs.writeFileSync(getProcessStatePath(home), '{"schemaVersion":1,"processes":{}}');
    expect(readProcessState(home)).toBeUndefined();
  });
});
