import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitForEngineIdentity } from "./local-api/engine-client.js";
import { inspectRunningEngine, launchDetachedEngine, stopEngine } from "./process-manager.js";
import { waitForProcessExit } from "./platform/process.js";

const homes: string[] = [];
const runtimes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    try { await stopEngine(home); } catch { /* already stopped */ }
    fs.rmSync(home, { recursive: true, force: true });
  }
  for (const runtime of runtimes.splice(0)) fs.rmSync(runtime, { recursive: true, force: true });
});

describe("process manager integration", () => {
  it("keeps two NIUBOT_HOME instances isolated", async () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-engine-fixture-"));
    runtimes.push(runtime);
    const entry = path.join(runtime, "engine.mjs");
    fs.writeFileSync(entry, fixtureEngineSource());
    const firstHome = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-home-a-"));
    const secondHome = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-home-b-"));
    homes.push(firstHome, secondHome);

    const first = launchDetachedEngine({
      niubotHome: firstHome,
      engineEntry: entry,
      runtimePath: runtime,
      logFile: path.join(firstHome, "logs", "engine.log"),
      version: "1.0.0",
    });
    const second = launchDetachedEngine({
      niubotHome: secondHome,
      engineEntry: entry,
      runtimePath: runtime,
      logFile: path.join(secondHome, "logs", "engine.log"),
      version: "1.0.0",
    });

    expect(first.endpoint.address).not.toBe(second.endpoint.address);
    expect(await waitForEngineIdentity(first.endpoint, first.state.instanceId, 10_000, 100)).toBeTruthy();
    expect(await waitForEngineIdentity(second.endpoint, second.state.instanceId, 10_000, 100)).toBeTruthy();
    expect((await inspectRunningEngine(firstHome))?.state.pid).toBe(first.state.pid);
    expect((await inspectRunningEngine(secondHome))?.state.pid).toBe(second.state.pid);

    await stopEngine(firstHome);
    expect(await inspectRunningEngine(firstHome)).toBeUndefined();
    expect((await inspectRunningEngine(secondHome))?.state.pid).toBe(second.state.pid);
    await stopEngine(secondHome);
  }, 60_000);

  it("does not orphan an engine that closes IPC before its process exits", async () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-engine-fixture-"));
    runtimes.push(runtime);
    const entry = path.join(runtime, "engine.mjs");
    fs.writeFileSync(entry, fixtureEngineSource(true));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-home-orphan-"));
    homes.push(home);

    const launched = launchDetachedEngine({
      niubotHome: home,
      engineEntry: entry,
      runtimePath: runtime,
      logFile: path.join(home, "logs", "engine.log"),
      version: "1.0.0",
    });
    expect(await waitForEngineIdentity(launched.endpoint, launched.state.instanceId, 10_000, 100)).toBeTruthy();

    await expect(stopEngine(home)).resolves.toEqual({ stopped: true, pid: launched.state.pid });
    expect(await waitForProcessExit(launched.state.pid, 1_000)).toBe(true);
  }, 60_000);
});

function fixtureEngineSource(stayAliveAfterShutdown = false): string {
  return `import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
const home = process.env.NIUBOT_HOME;
const hash = crypto.createHash("sha256").update(path.win32.resolve(home).toLowerCase()).digest("hex").slice(0, 16);
const endpoint = process.platform === "win32"
  ? "\\\\\\\\.\\\\pipe\\\\niubot-" + hash + "-engine"
  : path.join(home, "run", "engine.sock");
if (process.platform !== "win32") {
  fs.mkdirSync(path.dirname(endpoint), { recursive: true });
  try { fs.unlinkSync(endpoint); } catch {}
}
let server;
const finish = () => {
  server.close();
  ${stayAliveAfterShutdown ? "setInterval(() => {}, 1000);" : "setTimeout(() => process.exit(0), 20);"}
};
server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/identity") {
    res.end(JSON.stringify({
      pid: process.pid,
      instanceId: process.env.NIUBOT_INSTANCE_ID,
      home,
      version: "1.0.0",
      runtimePath: process.cwd(),
      startedAt: process.env.NIUBOT_STARTED_AT,
    }));
  } else if (req.method === "POST" && req.url === "/shutdown" && req.headers["x-niubot-control-token"] === process.env.NIUBOT_CONTROL_TOKEN) {
    res.writeHead(202);
    res.end("{}");
    setImmediate(finish);
  } else {
    res.writeHead(404);
    res.end("{}");
  }
});
await new Promise((resolve, reject) => server.once("error", reject).listen(endpoint, resolve));
process.on("SIGTERM", finish);
`;
}
