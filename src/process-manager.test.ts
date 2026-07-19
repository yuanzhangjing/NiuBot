import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { EngineControlServer, type EngineIdentity } from "./local-api/engine-server.js";
import { resolveEngineEndpoint } from "./platform/ipc.js";
import { queryProcessStartMarker, waitForProcessExit } from "./platform/process.js";
import { inspectRunningEngine, stopEngine } from "./process-manager.js";
import { readProcessState, writeProcessState, type EngineProcessState } from "./process-state.js";

const tempDirs: string[] = [];
const servers: EngineControlServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("process manager", () => {
  it("identifies and stops an engine through its control endpoint", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-process-manager-"));
    tempDirs.push(home);
    const endpoint = resolveEngineEndpoint(home);
    const runtimePath = path.resolve(home, "runtime");
    const identity: EngineIdentity = {
      pid: process.pid,
      instanceId: "instance-a",
      home,
      version: "1.0.0",
      runtimePath,
      startedAt: "2026-07-19T00:00:00.000Z",
    };
    let server!: EngineControlServer;
    server = new EngineControlServer(endpoint, identity, "token-a", () => server.stop());
    servers.push(server);
    await server.start();
    const state: EngineProcessState = {
      ...identity,
      endpoint: endpoint.address,
      endpointKind: endpoint.kind,
      controlToken: "token-a",
      nodePath: process.execPath,
    };
    writeProcessState(home, state);

    expect((await inspectRunningEngine(home))?.identity).toEqual(identity);
    await expect(stopEngine(home)).resolves.toEqual({ stopped: true, pid: process.pid });
    expect(readProcessState(home)).toBeUndefined();
  });

  it("does not trust a state file whose identity does not match", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-process-manager-"));
    tempDirs.push(home);
    const endpoint = resolveEngineEndpoint(home);
    const identity: EngineIdentity = {
      pid: process.pid,
      instanceId: "live-instance",
      home,
      version: "1.0.0",
      runtimePath: path.resolve(home, "runtime"),
      startedAt: "2026-07-19T00:00:00.000Z",
    };
    const server = new EngineControlServer(endpoint, identity, "live-token", () => {});
    servers.push(server);
    await server.start();
    writeProcessState(home, {
      ...identity,
      instanceId: "stale-instance",
      endpoint: endpoint.address,
      endpointKind: endpoint.kind,
      controlToken: "stale-token",
      nodePath: process.execPath,
    });

    expect(await inspectRunningEngine(home)).toBeUndefined();
  });

  it("uses the OS process creation marker before force-stopping a disconnected engine", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-process-manager-"));
    tempDirs.push(home);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("test child did not start");
    child.unref();
    const marker = queryProcessStartMarker(child.pid);
    if (!marker) throw new Error("test child creation marker is unavailable");
    const endpoint = resolveEngineEndpoint(home);
    writeProcessState(home, {
      pid: child.pid,
      instanceId: "disconnected-instance",
      startedAt: new Date().toISOString(),
      platformStartMarker: marker,
      endpoint: endpoint.address,
      endpointKind: endpoint.kind,
      controlToken: "token",
      version: "1.0.0",
      runtimePath: home,
      nodePath: process.execPath,
    });

    await expect(stopEngine(home)).resolves.toEqual({ stopped: true, pid: child.pid });
    expect(await waitForProcessExit(child.pid, 1_000)).toBe(true);
  });
});
