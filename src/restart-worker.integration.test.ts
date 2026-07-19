import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectRunningEngine, stopEngine } from "./process-manager.js";
import { ReleaseStore } from "./release-store.js";
import { runRestartWorker } from "./restart-worker.js";
import { readProcessState } from "./process-state.js";
import { readEngineIdentity } from "./local-api/engine-client.js";
import { endpointFromAddress } from "./platform/ipc.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of tempDirs.splice(0)) {
    try { await stopEngine(path.join(directory, "home")); } catch { /* test may fail before launch */ }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("restart worker integration", () => {
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
    fs.writeFileSync(path.join(source, "dist", "index.js"), fakeEngineSource());
    fs.writeFileSync(path.join(source, "dist", "bad.js"), fakeEngineSource(false));
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
      `restart:\n  sourceDirectory: ${JSON.stringify(source)}`,
      "",
    ].join("\n"));
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
      vi.stubEnv(name, "");
    }
    vi.stubEnv("NIUBOT_RESTART_HEALTH_TIMEOUT", "1");

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
    await expect(stopEngine(home)).resolves.toMatchObject({ stopped: true });
  }, 120_000);
});

function fakeEngineSource(healthy = true): string {
  return `import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

if (process.argv.includes("--preflight")) process.exit(0);
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
  setTimeout(() => process.exit(0), 20);
};
engine = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/identity") {
    res.end(JSON.stringify({
      pid: process.pid,
      instanceId: process.env.NIUBOT_INSTANCE_ID,
      home,
      version: "1.0.0",
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
