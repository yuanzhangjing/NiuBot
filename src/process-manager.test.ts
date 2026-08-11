import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { EngineControlServer, type EngineIdentity } from "./local-api/engine-server.js";
import { resolveEngineEndpoint } from "./platform/ipc.js";
import { queryProcessStartMarker, terminateSpawnedProcessTree, waitForProcessExit } from "./platform/process.js";
import { inspectRunningEngine, launchDetachedEngine, stopEngine } from "./process-manager.js";
import { readProcessState, writeProcessState, type EngineProcessState } from "./process-state.js";

const tempDirs: string[] = [];
const servers: EngineControlServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("process manager", () => {
  it("runs the final pre-launch check while holding the start lock", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-process-manager-check-"));
    tempDirs.push(home);
    const startLock = path.join(home, "run", "engine-start.lock");
    expect(() => launchDetachedEngine({
      niubotHome: home,
      engineEntry: path.join(home, "missing.js"),
      runtimePath: home,
      logFile: path.join(home, "engine.log"),
      version: "1.0.0",
      beforeLaunch: () => {
        expect(fs.existsSync(startLock)).toBe(true);
        throw new Error("pending transfer");
      },
    })).toThrow(/pending transfer/);
    expect(fs.existsSync(startLock)).toBe(false);
  });

  it("serializes starts and rejects a second Engine for the same home", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-process-manager-"));
    tempDirs.push(home);
    const runtime = path.join(home, "runtime");
    const entry = path.join(runtime, "dist", "index.js");
    const logFile = path.join(home, "logs", "engine.log");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "setInterval(() => {}, 1000);\n");
    const options = {
      niubotHome: home,
      engineEntry: entry,
      runtimePath: runtime,
      logFile,
      version: "1.0.0",
    };
    fs.writeFileSync(path.join(home, "niubot.version"), "0.1.90");

    const launched = launchDetachedEngine(options);
    expect(fs.readFileSync(path.join(home, "niubot.version"), "utf8")).toBe("1.0.0");
    expect(() => launchDetachedEngine(options)).toThrow(/already running or starting/);
    await expect(stopEngine(home)).resolves.toEqual({ stopped: true, pid: launched.state.pid });
  });

  it("does not fail Engine launch when the legacy version snapshot is unwritable", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-process-manager-version-"));
    tempDirs.push(home);
    const runtime = path.join(home, "runtime");
    const entry = path.join(runtime, "dist", "index.js");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "setInterval(() => {}, 1000);\n");
    fs.mkdirSync(path.join(home, "niubot.version"));

    const launched = launchDetachedEngine({
      niubotHome: home,
      engineEntry: entry,
      runtimePath: runtime,
      logFile: path.join(home, "engine.log"),
      version: "2.0.0",
    });

    expect(readProcessState(home)?.processes.engine.version).toBe("2.0.0");
    await expect(stopEngine(home)).resolves.toEqual({ stopped: true, pid: launched.state.pid });
  });

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

  it.skipIf(process.platform !== "win32")("does not kill the detached recovery worker when force-stopping its parent Engine", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-process-manager-worker-"));
    tempDirs.push(home);
    const childPidFile = path.join(home, "worker.pid");
    const engineScript = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(worker.pid));`,
      "worker.unref();",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const engine = spawn(process.execPath, ["-e", engineScript], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    if (!engine.pid) throw new Error("test Engine did not start");
    engine.unref();
    let workerPid: number | undefined;
    try {
      const deadline = Date.now() + 5_000;
      while (!workerPid && Date.now() < deadline) {
        try { workerPid = Number(fs.readFileSync(childPidFile, "utf-8")); } catch { /* wait for child */ }
        if (!workerPid) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!workerPid) throw new Error("test recovery worker did not start");
      const marker = queryProcessStartMarker(engine.pid);
      if (!marker) throw new Error("test Engine creation marker is unavailable");
      const endpoint = resolveEngineEndpoint(home);
      writeProcessState(home, {
        pid: engine.pid,
        instanceId: "disconnected-engine-with-worker",
        startedAt: new Date().toISOString(),
        platformStartMarker: marker,
        endpoint: endpoint.address,
        endpointKind: endpoint.kind,
        controlToken: "token",
        version: "1.0.0",
        runtimePath: home,
        nodePath: process.execPath,
      });

      await expect(stopEngine(home, { preserveDescendants: true })).resolves.toEqual({ stopped: true, pid: engine.pid });
      expect(await waitForProcessExit(engine.pid, 1_000)).toBe(true);
      expect(queryProcessStartMarker(workerPid)).toBeTruthy();
    } finally {
      if (workerPid) {
        terminateSpawnedProcessTree(workerPid, true);
        await waitForProcessExit(workerPid, 1_000);
      }
      terminateSpawnedProcessTree(engine.pid, true);
      await waitForProcessExit(engine.pid, 1_000);
    }
  });

  it.skipIf(process.platform === "win32")("verifies the home and command before stopping a legacy PID", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "niubot legacy home "));
    tempDirs.push(home);
    const runtime = path.join(home, "legacy-runtime");
    const entry = path.join(runtime, "dist", "index.js");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "setInterval(() => {}, 1000);\n");
    const child = spawn(process.execPath, [entry], {
      cwd: runtime,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, NIUBOT_HOME: home },
    });
    if (!child.pid) throw new Error("test child did not start");
    child.unref();
    fs.writeFileSync(path.join(home, "niubot.pid"), String(child.pid));

    await expect(stopEngine(home)).resolves.toEqual({ stopped: true, pid: child.pid });
    expect(await waitForProcessExit(child.pid, 1_000)).toBe(true);
  });

  it("refuses to stop an unrelated process referenced by a legacy PID file", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-process-manager-"));
    tempDirs.push(home);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("test child did not start");
    child.unref();
    fs.writeFileSync(path.join(home, "niubot.pid"), String(child.pid));

    await expect(stopEngine(home)).rejects.toThrow(/cannot be verified/);
    expect(queryProcessStartMarker(child.pid)).toBeTruthy();
    terminateSpawnedProcessTree(child.pid, true);
    await waitForProcessExit(child.pid, 1_000);
  });
});
