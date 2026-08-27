import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { launchBotTransferWorker } from "./bot-transfer-launcher.js";
import { exportBotBundle } from "./bot-transfer.js";
import { closeTestDatabases, openTestDatabase } from "../test-utils/database.js";
import { waitForEngineIdentity } from "./local-api/engine-client.js";
import { launchDetachedEngine, inspectRunningEngine } from "./process-manager.js";
import { readProcessState } from "./process-state.js";
import {
  isProcessAlive,
  terminateSpawnedProcessTree,
  waitForProcessExit,
} from "./platform/process.js";

const roots: string[] = [];
const homes: string[] = [];
const workerPids: number[] = [];
const enginePids: number[] = [];

afterEach(async () => {
  closeTestDatabases();
  // Windows: cwd/open files in the tree block rm. Kill first; skip graceful
  // stopEngine (named-pipe stall).
  const pids = new Set<number>([...workerPids.splice(0), ...enginePids.splice(0)]);
  for (const home of homes) {
    const pid = readProcessState(home)?.processes.engine.pid;
    if (pid) pids.add(pid);
  }
  for (const pid of pids) {
    if (isProcessAlive(pid)) terminateSpawnedProcessTree(pid, true);
  }
  const alive: number[] = [];
  for (const pid of pids) {
    if (await waitForProcessExit(pid, 5_000, 100)) continue;
    terminateSpawnedProcessTree(pid, true);
    if (!await waitForProcessExit(pid, 5_000, 100)) alive.push(pid);
  }
  if (alive.length > 0) {
    throw new Error(`test processes still alive after force-kill: ${alive.join(", ")}`);
  }
  homes.splice(0);
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);

describe("Bot transfer detached worker integration", () => {
  it("survives the launcher, stops two isolated Engines, moves one Bot, and restores both", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-transfer-e2e-"));
    roots.push(root);
    const source = createHome(path.join(root, "source"), "Mover");
    const target = createHome(path.join(root, "target"), "Existing");
    homes.push(source, target);
    const engineRuntime = createFixtureEngineRuntime(path.join(root, "engine-runtime"));
    const workerRuntime = resolveWorkerRuntime(path.join(root, "worker-runtime"));
    const sourceBefore = await startFixtureEngine(source, engineRuntime);
    const targetBefore = await startFixtureEngine(target, engineRuntime);

    const launched = launchBotTransferWorker({
      runtimeRoot: workerRuntime,
      request: {
        kind: "move",
        sourceHome: source,
        targetHome: target,
        botId: "Mover",
        sourceVersion: "1.0.0",
        runtime: {
          runtimePath: engineRuntime,
          nodePath: process.execPath,
          version: "1.0.0",
          runtimeMode: "dev",
        },
      },
    });
    workerPids.push(launched.pid);

    const state = await waitForTerminalState(launched.stateFile, 20_000);
    if (state.phase !== "success") {
      const sourceLog = fs.readFileSync(path.join(source, "logs", "fixture.log"), "utf-8");
      throw new Error(`worker state: ${JSON.stringify(state)}; source log: ${sourceLog}`);
    }
    expect(state).toMatchObject({ phase: "success" });
    expect(await waitForProcessExit(launched.pid, 10_000, 100)).toBe(true);
    expect(readBotIds(source)).toEqual([]);
    expect(readBotIds(target)).toEqual(["Existing", "Mover"]);
    const sourceAfter = await inspectRunningEngine(source);
    const targetAfter = await inspectRunningEngine(target);
    expect(sourceAfter).toBeUndefined();
    expect(targetAfter?.state.instanceId).not.toBe(targetBefore.state.instanceId);
    expect(fs.existsSync(path.join(source, "run", "bot-transfer-active"))).toBe(false);
    expect(fs.existsSync(path.join(target, "run", "bot-transfer-active"))).toBe(false);
  }, 60_000);

  it("imports through the detached built worker and automatically restarts the target Engine", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nbti-"));
    roots.push(root);
    const source = createHome(path.join(root, "s"), "Mover");
    const target = createHome(path.join(root, "t"), "Existing");
    homes.push(target);
    const bundle = path.join(root, "Mover.nbot");
    await exportBotBundle({ home: source, botId: "Mover", outputPath: bundle, sourceVersion: "1.0.0" });
    const engineRuntime = createFixtureEngineRuntime(path.join(root, "engine-runtime"));
    const workerRuntime = resolveWorkerRuntime(path.join(root, "worker-runtime"));
    const targetBefore = await startFixtureEngine(target, engineRuntime);

    const launched = launchBotTransferWorker({
      runtimeRoot: workerRuntime,
      request: {
        kind: "import",
        home: target,
        bundlePath: bundle,
        appId: "imported-app-id",
        appSecret: "imported-app-secret",
        runtime: {
          runtimePath: engineRuntime,
          nodePath: process.execPath,
          version: "1.0.0",
          runtimeMode: "dev",
        },
      },
    });
    workerPids.push(launched.pid);

    const state = await waitForTerminalState(launched.stateFile, 20_000);
    expect(state).toMatchObject({ phase: "success" });
    expect(await waitForProcessExit(launched.pid, 10_000, 100)).toBe(true);
    expect(readBotIds(target)).toEqual(["Existing", "Mover"]);
    const targetAfter = await inspectRunningEngine(target);
    expect(targetAfter?.state.instanceId).not.toBe(targetBefore.state.instanceId);
    expect(fs.existsSync(launched.stateFile.replace(/state\.json$/, "request.json"))).toBe(false);
  }, 60_000);
});

async function startFixtureEngine(home: string, runtimePath: string) {
  const logFile = path.join(home, "logs", "fixture.log");
  const launched = launchDetachedEngine({
    niubotHome: home,
    engineEntry: path.join(runtimePath, "dist", "index.js"),
    runtimePath,
    nodePath: process.execPath,
    version: "1.0.0",
    runtimeMode: "dev",
    logFile,
  });
  enginePids.push(launched.state.pid);
  const identity = await waitForEngineIdentity(launched.endpoint, launched.state.instanceId, 10_000, 50);
  if (!identity) {
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8") : "<missing log>";
    throw new Error(`fixture Engine did not become healthy: ${log}`);
  }
  return launched;
}

function resolveWorkerRuntime(runtime: string): string {
  const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = path.resolve(sourceRoot, "..");
  if (fs.existsSync(path.join(repositoryRoot, "dist", "bot-transfer-worker.js"))) return repositoryRoot;
  fs.mkdirSync(path.join(runtime, "dist"), { recursive: true });
  const tsx = path.resolve(sourceRoot, "..", "node_modules", "tsx", "dist", "cli.mjs");
  const worker = path.join(sourceRoot, "bot-transfer-worker.ts");
  fs.writeFileSync(path.join(runtime, "dist", "bot-transfer-worker.js"), `
    import { spawn } from "node:child_process";
    const child = spawn(process.execPath, [${JSON.stringify(tsx)}, ${JSON.stringify(worker)}], {
      stdio: "inherit",
      env: process.env,
    });
    child.once("exit", (code) => process.exit(code ?? 1));
    child.once("error", (error) => { console.error(error); process.exit(1); });
  `);
  return runtime;
}

function createFixtureEngineRuntime(runtime: string): string {
  fs.mkdirSync(path.join(runtime, "dist"), { recursive: true });
  fs.writeFileSync(path.join(runtime, "dist", "index.js"), fixtureEngineSource());
  return runtime;
}

function fixtureEngineSource(): string {
  const windowsPipePrefix = JSON.stringify("\\\\.\\pipe\\niubot-");
  return `
    import crypto from "node:crypto";
    import fs from "node:fs";
    import http from "node:http";
    import path from "node:path";
    const home = process.env.NIUBOT_HOME;
    const config = fs.readFileSync(path.join(home, "config.yaml"), "utf-8");
    const botIds = [...config.matchAll(/^\\s*-?\\s*id:\\s*([^#\\r\\n]+)$/gm)].map((match) => match[1].trim().replace(/^['\"]|['\"]$/g, ""));
    const homeHash = crypto.createHash("sha256").update(path.win32.resolve(home).toLowerCase()).digest("hex").slice(0, 16);
    const stable = (value) => {
      const readable = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
      const hash = crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
      return (readable || "id") + "-" + hash;
    };
    const engineAddress = process.platform === "win32" ? ${windowsPipePrefix} + homeHash + "-engine" : path.join(home, "run", "engine.sock");
    const botAddress = (id) => process.platform === "win32"
      ? ${windowsPipePrefix} + homeHash + "-bot-" + stable(id)
      : path.join(home, id, "api.sock");
    const servers = [];
    const prepare = (address) => {
      if (process.platform === "win32") return;
      fs.mkdirSync(path.dirname(address), { recursive: true });
      try { fs.unlinkSync(address); } catch {}
    };
    const listen = (server, address) => new Promise((resolve, reject) => {
      prepare(address);
      server.once("error", reject).listen(address, resolve);
      servers.push(server);
    });
    for (const id of botIds) {
      const server = http.createServer((req, res) => {
        if (req.url === "/ping") { res.writeHead(200); res.end("{}"); }
        else { res.writeHead(404); res.end("{}"); }
      });
      await listen(server, botAddress(id));
    }
    let shuttingDown = false;
    const finish = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))).finally(() => process.exit(0));
    };
    const engine = http.createServer((req, res) => {
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
        res.writeHead(202); res.end("{}"); setImmediate(finish);
      } else { res.writeHead(404); res.end("{}"); }
    });
    await listen(engine, engineAddress);
    process.on("SIGTERM", finish);
  `;
}

function createHome(home: string, botId: string): string {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.yaml"), yaml.stringify({
    bots: [{ id: botId, backend: "codex", appId: `${botId}-id`, appSecret: `${botId}-secret` }],
  }), { mode: 0o600 });
  const botDirectory = path.join(home, botId);
  fs.mkdirSync(botDirectory);
  openTestDatabase(path.join(botDirectory, "niubot.db")).close();
  fs.writeFileSync(path.join(botDirectory, "bot_profile.md"), `# ${botId}\n`, { mode: 0o600 });
  return home;
}

function readBotIds(home: string): string[] {
  return yaml.parse(fs.readFileSync(path.join(home, "config.yaml"), "utf-8")).bots.map((bot: { id: string }) => bot.id);
}

async function waitForTerminalState(stateFile: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
      if (["success", "failed-rolled-back", "recovery-failed"].includes(String(state.phase))) return state;
    } catch { /* worker has not written state yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for Bot transfer state: ${stateFile}`);
}
