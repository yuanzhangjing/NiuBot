import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectRunningEngine, launchDetachedEngine, stopEngine } from "./process-manager.js";
import { ReleaseStore } from "./release-store.js";
import { runRestartWorker } from "./restart-worker.js";
import { readProcessState } from "./process-state.js";
import { readEngineIdentity, waitForEngineIdentity } from "./local-api/engine-client.js";
import { endpointFromAddress } from "./platform/ipc.js";
import Database from "better-sqlite3";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of tempDirs.splice(0)) {
    try { await stopEngine(path.join(directory, "home")); } catch { /* test may fail before launch */ }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("restart worker integration", () => {
  it("uses the active runtime as the production restart target, not the worker package", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-production-restart-"));
    tempDirs.push(root);
    const home = path.join(root, "home");
    const runtime = path.join(root, "active-runtime");
    fs.mkdirSync(path.join(runtime, "dist"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(runtime, "package.json"), `${JSON.stringify({
      name: "@yuanzhangjing/niubot",
      version: "9.8.7",
      type: "module",
    })}\n`);
    fs.writeFileSync(path.join(runtime, "dist", "index.js"), fakeEngineSource(true, "9.8.7"));
    fs.writeFileSync(path.join(home, "config.yaml"), [
      "bots:",
      "  - id: TestBot",
      "    backend: codex",
      "    appId: test-app",
      "    appSecret: test-secret",
      "",
    ].join("\n"));
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
      vi.stubEnv(name, "");
    }
    const initial = launchDetachedEngine({
      niubotHome: home,
      engineEntry: path.join(runtime, "dist", "index.js"),
      runtimePath: runtime,
      logFile: path.join(home, "logs", "initial.log"),
      version: "9.8.7",
      runtimeMode: "npm-release",
      env: { NIUBOT_RUNTIME_MODE: "npm-release" },
    });
    expect(initial.state.runtimePath).toBe(runtime);

    await runRestartWorker({
      ...process.env,
      NIUBOT_HOME: home,
      NIUBOT_BOT_NAME: "TestBot",
      NIUBOT_SOURCE_DIR: runtime,
      NIUBOT_RUNTIME_MODE: "npm-release",
      NIUBOT_AGENT_SESSION: undefined,
    });

    const running = await inspectRunningEngine(home);
    expect(running?.identity.version).toBe("9.8.7");
    expect(running?.state.version).toBe("9.8.7");
    expect(running?.state.runtimePath).toBe(runtime);
    const restartState = JSON.parse(fs.readFileSync(
      path.join(home, "TestBot", "restart", "state.json"),
      "utf-8",
    )) as { phase: string };
    expect(restartState.phase).toBe("production_success");
    await expect(stopEngine(home)).resolves.toMatchObject({ stopped: true });
  }, 30_000);

  it("builds, switches, checks health, and commits LKG through the Node implementation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-restart-integration-"));
    tempDirs.push(root);
    const home = path.join(root, "home");
    const source = path.join(root, "source");
    fs.mkdirSync(path.join(source, "dist"), { recursive: true });
    fs.mkdirSync(path.join(source, "src"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });

    fs.writeFileSync(path.join(source, "package.json"), `${JSON.stringify({
      name: "@yuanzhangjing/niubot",
      version: "1.0.0",
      type: "module",
      files: ["dist", "src"],
      scripts: {
        build: "node -e \"process.exit(0)\"",
        "pack:check": "node -e \"process.exit(0)\"",
      },
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(source, "src", "placeholder.js"), "export {};\n");
    fs.writeFileSync(path.join(source, "dist", "index.js"), fakeEngineSource());
    fs.writeFileSync(path.join(home, "config.yaml"), [
      "bots:",
      "  - id: TestBot",
      "    backend: codex",
      "    appId: test-app",
      "    appSecret: test-secret",
      `restart:\n  sourceDirectory: ${JSON.stringify(source)}`,
      "",
    ].join("\n"));

    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
      vi.stubEnv(name, "");
    }
    await runRestartWorker({
      ...process.env,
      NIUBOT_HOME: home,
      NIUBOT_BOT_NAME: "TestBot",
      NIUBOT_SOURCE_DIR: source,
      NIUBOT_AGENT_SESSION: undefined,
    });

    const running = await inspectRunningEngine(home);
    if (!running) {
      const debug = fs.readFileSync(path.join(home, "logs", "restart-debug.log"), "utf-8");
      const state = fs.readFileSync(path.join(home, "TestBot", "restart", "state.json"), "utf-8");
      const processState = readProcessState(home);
      const identity = processState
        ? await readEngineIdentity(endpointFromAddress(processState.processes.engine.endpoint), 1_000)
        : undefined;
      const serviceLogName = fs.readdirSync(path.join(home, "logs")).find((name) => name.startsWith("niubot-"));
      const serviceLog = serviceLogName ? fs.readFileSync(path.join(home, "logs", serviceLogName), "utf-8") : "";
      throw new Error(`candidate is not running\nprocess=${JSON.stringify(processState)}\nidentity=${JSON.stringify(identity)}\n${state}\n${serviceLog}\n${debug}`);
    }
    expect(running?.identity.version).toBe("1.0.0");
    expect(running?.state.runtimePath).toContain(path.join("releases", ""));
    const releaseState = new ReleaseStore(path.join(home, "TestBot")).readState();
    expect(releaseState.current).toBeTruthy();
    expect(releaseState.lastKnownGood).toBe(releaseState.current);
    await expect(stopEngine(home)).resolves.toMatchObject({ stopped: true });
  }, 120_000);

  it("rolls back to the bootstrap LKG when the candidate fails health checks", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-restart-rollback-"));
    tempDirs.push(root);
    const home = path.join(root, "home");
    const source = path.join(root, "source");
    fs.mkdirSync(path.join(source, "dist"), { recursive: true });
    fs.mkdirSync(path.join(source, "src"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const databasePath = path.join(home, "TestBot", "niubot.db");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new Database(databasePath);
    database.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('before')");
    database.close();
    const databaseDuringPreflightPath = path.join(root, "during-preflight.db");
    const databaseDuringPreflight = new Database(databaseDuringPreflightPath);
    databaseDuringPreflight.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('during-preflight')");
    databaseDuringPreflight.close();
    fs.writeFileSync(path.join(source, "dist", "index.js"), fakeEngineSource());
    fs.writeFileSync(path.join(source, "dist", "bad.js"), fakeEngineSource(false, "1.0.0", true));
    fs.writeFileSync(path.join(source, "src", "placeholder.js"), "export {};\n");
    fs.writeFileSync(path.join(source, "package.json"), `${JSON.stringify({
      name: "@yuanzhangjing/niubot",
      version: "1.0.0",
      type: "module",
      files: ["dist", "src"],
      scripts: {
        build: "node -e \"require('node:fs').copyFileSync('dist/bad.js','dist/index.js')\"",
        "pack:check": "node -e \"process.exit(0)\"",
      },
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(home, "config.yaml"), [
      "bots:",
      "  - id: TestBot",
      "    backend: codex",
      "    appId: test-app",
      "    appSecret: test-secret",
      `    dbPath: ${JSON.stringify(databasePath)}`,
      `restart:\n  sourceDirectory: ${JSON.stringify(source)}`,
      "",
    ].join("\n"));
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
      vi.stubEnv(name, "");
    }
    vi.stubEnv("NIUBOT_RESTART_HEALTH_TIMEOUT", "1");
    vi.stubEnv("NIUBOT_TEST_DATABASE_PATH", databasePath);
    vi.stubEnv("NIUBOT_TEST_PREFLIGHT_DATABASE_SOURCE", databaseDuringPreflightPath);

    await runRestartWorker({
      ...process.env,
      NIUBOT_HOME: home,
      NIUBOT_BOT_NAME: "TestBot",
      NIUBOT_SOURCE_DIR: source,
      NIUBOT_AGENT_SESSION: undefined,
    });

    const running = await inspectRunningEngine(home);
    expect(running?.state.runtimePath).toContain(`${path.sep}bootstrap-`);
    const store = new ReleaseStore(path.join(home, "TestBot"));
    const releaseState = store.readState();
    expect(releaseState.current).toBe(releaseState.lastKnownGood);
    expect(releaseState.current).toMatch(/^bootstrap-/);
    const restartState = JSON.parse(fs.readFileSync(
      path.join(home, "TestBot", "restart", "state.json"),
      "utf-8",
    )) as { phase: string };
    expect(restartState.phase).toBe("rollback_success");
    const restored = new Database(databasePath, { readonly: true });
    expect(restored.prepare("SELECT value FROM marker").pluck().get()).toBe("during-preflight");
    restored.close();
    await expect(stopEngine(home)).resolves.toMatchObject({ stopped: true });
  }, 120_000);

  it("keeps the old service and live database untouched when candidate preflight fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nbt-pf-"));
    tempDirs.push(root);
    const home = path.join(root, "home");
    const source = path.join(root, "source");
    const oldRuntime = path.join(root, "old-runtime");
    const databasePath = path.join(home, "TestBot", "niubot.db");
    fs.mkdirSync(path.join(source, "dist"), { recursive: true });
    fs.mkdirSync(path.join(source, "src"), { recursive: true });
    fs.mkdirSync(path.join(oldRuntime, "dist"), { recursive: true });
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new Database(databasePath);
    database.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('before')");
    database.close();
    fs.writeFileSync(path.join(oldRuntime, "package.json"), `${JSON.stringify({
      name: "@yuanzhangjing/niubot",
      version: "0.9.0",
      type: "module",
    })}\n`);
    fs.writeFileSync(path.join(oldRuntime, "dist", "index.js"), fakeEngineSource(true, "0.9.0"));
    fs.writeFileSync(path.join(source, "dist", "index.js"), fakeEngineSource(true, "1.0.0", true, 42));
    fs.writeFileSync(path.join(source, "src", "placeholder.js"), "export {};\n");
    fs.writeFileSync(path.join(source, "package.json"), `${JSON.stringify({
      name: "@yuanzhangjing/niubot",
      version: "1.0.0",
      type: "module",
      files: ["dist", "src"],
      scripts: {
        build: "node -e \"process.exit(0)\"",
        "pack:check": "node -e \"process.exit(0)\"",
      },
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(home, "config.yaml"), [
      "bots:",
      "  - id: TestBot",
      "    backend: codex",
      "    appId: test-app",
      "    appSecret: test-secret",
      `    dbPath: ${JSON.stringify(databasePath)}`,
      `restart:\n  sourceDirectory: ${JSON.stringify(source)}`,
      "",
    ].join("\n"));
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
      vi.stubEnv(name, "");
    }
    vi.stubEnv("NIUBOT_TEST_DATABASE_PATH", databasePath);
    const initial = launchDetachedEngine({
      niubotHome: home,
      engineEntry: path.join(oldRuntime, "dist", "index.js"),
      runtimePath: oldRuntime,
      logFile: path.join(home, "logs", "old.log"),
      version: "0.9.0",
    });
    await expect(waitForEngineIdentity(initial.endpoint, {
      instanceId: initial.state.instanceId,
      pid: initial.state.pid,
      home,
      runtimePath: oldRuntime,
    }, 5_000, 50)).resolves.toBeTruthy();

    await expect(runRestartWorker({
      ...process.env,
      NIUBOT_HOME: home,
      NIUBOT_BOT_NAME: "TestBot",
      NIUBOT_SOURCE_DIR: source,
      NIUBOT_AGENT_SESSION: undefined,
    })).rejects.toThrow(/exited with code 42/);

    const running = await inspectRunningEngine(home);
    expect(running?.state.pid).toBe(initial.state.pid);
    expect(running?.state.runtimePath).toBe(oldRuntime);
    const live = new Database(databasePath, { readonly: true });
    expect(live.prepare("SELECT value FROM marker").pluck().get()).toBe("before");
    live.close();
    expect(fs.existsSync(path.join(home, "TestBot", "restart", "database-snapshots")))
      .toBe(true);
    expect(fs.readdirSync(path.join(home, "TestBot", "restart", "database-snapshots")))
      .toHaveLength(0);
  }, 120_000);

  it("restarts the old runtime when the final rollback snapshot cannot be created", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nbt-snap-fail-"));
    tempDirs.push(root);
    const home = path.join(root, "home");
    const source = path.join(root, "source");
    const botDirectory = path.join(home, "TestBot");
    const snapshotDirectory = path.join(botDirectory, "restart", "database-snapshots");
    const databasePath = path.join(botDirectory, "niubot.db");
    const store = new ReleaseStore(botDirectory);
    const oldRuntime = store.packageDirectory("old");
    fs.mkdirSync(path.join(source, "dist"), { recursive: true });
    fs.mkdirSync(path.join(source, "src"), { recursive: true });
    fs.mkdirSync(path.join(oldRuntime, "dist"), { recursive: true });
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new Database(databasePath);
    database.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('before')");
    database.close();
    const oldPackage = { name: "@yuanzhangjing/niubot", version: "0.9.0", type: "module" };
    fs.writeFileSync(path.join(oldRuntime, "package.json"), `${JSON.stringify(oldPackage)}\n`);
    fs.writeFileSync(path.join(oldRuntime, "dist", "index.js"), fakeEngineSource(true, "0.9.0", false, 0, true));
    store.writeState({ schemaVersion: 1, current: "old", lastKnownGood: "old" });
    fs.writeFileSync(path.join(source, "dist", "index.js"), fakeEngineSource());
    fs.writeFileSync(path.join(source, "src", "placeholder.js"), "export {};\n");
    fs.writeFileSync(path.join(source, "package.json"), `${JSON.stringify({
      name: "@yuanzhangjing/niubot",
      version: "1.0.0",
      type: "module",
      files: ["dist", "src"],
      scripts: { build: "node -e \"process.exit(0)\"", "pack:check": "node -e \"process.exit(0)\"" },
    })}\n`);
    fs.writeFileSync(path.join(home, "config.yaml"), [
      "bots:",
      "  - id: TestBot",
      "    backend: codex",
      "    appId: test-app",
      "    appSecret: test-secret",
      `    dbPath: ${JSON.stringify(databasePath)}`,
      `restart:\n  sourceDirectory: ${JSON.stringify(source)}`,
      "",
    ].join("\n"));
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
      vi.stubEnv(name, "");
    }
    vi.stubEnv("NIUBOT_TEST_BLOCK_SNAPSHOT_DIRECTORY", snapshotDirectory);
    const initial = launchDetachedEngine({
      niubotHome: home,
      engineEntry: path.join(oldRuntime, "dist", "index.js"),
      runtimePath: oldRuntime,
      logFile: path.join(home, "logs", "old.log"),
      version: "0.9.0",
    });
    await expect(waitForEngineIdentity(initial.endpoint, {
      instanceId: initial.state.instanceId,
      pid: initial.state.pid,
      home,
      runtimePath: oldRuntime,
    }, 5_000, 50)).resolves.toBeTruthy();

    await expect(runRestartWorker({
      ...process.env,
      NIUBOT_HOME: home,
      NIUBOT_BOT_NAME: "TestBot",
      NIUBOT_SOURCE_DIR: source,
      NIUBOT_AGENT_SESSION: undefined,
    })).rejects.toThrow();
    const running = await inspectRunningEngine(home);
    expect(running?.state.runtimePath).toBe(oldRuntime);
    expect(new ReleaseStore(botDirectory).readState().current).toBe("old");
  }, 120_000);
});

function fakeEngineSource(
  healthy = true,
  version = "1.0.0",
  mutateDatabase = false,
  preflightExitCode = 0,
  blockSnapshotDirectory = false,
): string {
  return `import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

if (process.argv.includes("--preflight")) {
  const manifestPath = process.env.NIUBOT_PREFLIGHT_DATABASE_MANIFEST;
  if (!manifestPath) process.exit(41);
  ${mutateDatabase ? `const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  fs.writeFileSync(manifest.mappings[0].preflightPath, "preflight-only");
  if (process.env.NIUBOT_TEST_PREFLIGHT_DATABASE_SOURCE && process.env.NIUBOT_TEST_DATABASE_PATH) {
    fs.copyFileSync(process.env.NIUBOT_TEST_PREFLIGHT_DATABASE_SOURCE, process.env.NIUBOT_TEST_DATABASE_PATH);
  }` : ""}
  process.exit(${preflightExitCode});
}
${mutateDatabase ? `if (process.env.NIUBOT_TEST_DATABASE_PATH) {
  fs.writeFileSync(process.env.NIUBOT_TEST_DATABASE_PATH, "candidate-migration");
}` : ""}
const home = process.env.NIUBOT_HOME;
const runtimePath = process.cwd();
const named = (role) => {
  const hash = crypto.createHash("sha256").update(path.win32.resolve(home).toLowerCase()).digest("hex").slice(0, 16);
  return "\\\\\\\\.\\\\pipe\\\\niubot-" + hash + "-" + role;
};
const stableSegment = (value) => {
  const readable = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  const hash = crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
  return (readable || "id") + "-" + hash;
};
const engineEndpoint = process.platform === "win32" ? named("engine") : path.join(home, "run", "engine.sock");
const botEndpoint = process.platform === "win32" ? named("bot-" + stableSegment("TestBot")) : path.join(home, "TestBot", "api.sock");
for (const endpoint of [engineEndpoint, botEndpoint]) {
  if (process.platform !== "win32") {
    fs.mkdirSync(path.dirname(endpoint), { recursive: true });
    try { fs.unlinkSync(endpoint); } catch {}
  }
}
let engine;
let bot;
const finish = () => {
  engine?.close();
  bot?.close();
  ${blockSnapshotDirectory ? `if (process.env.NIUBOT_TEST_BLOCK_SNAPSHOT_DIRECTORY) {
    fs.rmSync(process.env.NIUBOT_TEST_BLOCK_SNAPSHOT_DIRECTORY, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(process.env.NIUBOT_TEST_BLOCK_SNAPSHOT_DIRECTORY), { recursive: true });
    fs.writeFileSync(process.env.NIUBOT_TEST_BLOCK_SNAPSHOT_DIRECTORY, "blocked");
  }` : ""}
  setTimeout(() => process.exit(0), 20);
};
engine = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/identity") {
    res.end(JSON.stringify({
      pid: process.pid,
      instanceId: process.env.NIUBOT_INSTANCE_ID,
      home,
      version: "${version}",
      runtimePath,
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
bot = http.createServer((_req, res) => {
  res.writeHead(${healthy ? 200 : 503});
  res.end(JSON.stringify({ status: "${healthy ? "ok" : "failed"}" }));
});
await new Promise((resolve, reject) => engine.once("error", reject).listen(engineEndpoint, resolve));
await new Promise((resolve, reject) => bot.once("error", reject).listen(botEndpoint, resolve));
process.on("SIGTERM", finish);
`;
}
