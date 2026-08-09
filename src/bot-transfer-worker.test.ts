import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { exportBotBundle, moveBot } from "./bot-transfer.js";
import type { BotTransferWorkerRequest } from "./bot-transfer-launcher.js";
import { recoverStaleBotTransferLifecycles, runBotTransferWorker } from "./bot-transfer-worker.js";
import { initDatabase } from "./database/schema.js";
import { acquireProcessLock } from "./process-lock.js";
import type { RunningEngine, LaunchedEngine, LaunchEngineOptions } from "./process-manager.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Bot transfer lifecycle worker", () => {
  it("does not stop an Engine while another lifecycle operation owns the shared lock", async () => {
    const fixture = await createImportFixture();
    const lifecycle = fakeLifecycle(new Set([fixture.target]));
    const release = acquireProcessLock(
      path.join(fixture.target, "run", "engine-lifecycle.lock"),
      "test Engine lifecycle",
    );
    try {
      await expect(runBotTransferWorker(fixture.requestFile, {
        ...lifecycle.dependencies,
        health: async () => true,
        delay: async () => undefined,
      })).rejects.toThrow(/already (held|running)/);
      expect(lifecycle.stopped).toEqual([]);
    } finally {
      release();
    }
  });

  it("stops a running target, imports, starts it, and removes the secret request", async () => {
    const fixture = await createImportFixture();
    const lifecycle = fakeLifecycle(new Set([fixture.target]));
    await runBotTransferWorker(fixture.requestFile, {
      ...lifecycle.dependencies,
      health: async () => true,
      delay: async () => undefined,
    });

    expect(lifecycle.stopped).toEqual([fixture.target]);
    expect(lifecycle.started).toEqual([fixture.target]);
    expect(readBotIds(fixture.target)).toEqual(["Existing", "Mover"]);
    expect(fs.existsSync(fixture.requestFile)).toBe(false);
    expect(readPhase(fixture.requestFile)).toBe("success");
  });

  it("rolls an import back and restores the original running target when health fails", async () => {
    const fixture = await createImportFixture();
    const originalConfig = fs.readFileSync(path.join(fixture.target, "config.yaml"), "utf-8");
    const lifecycle = fakeLifecycle(new Set([fixture.target]));
    let healthCalls = 0;
    await expect(runBotTransferWorker(fixture.requestFile, {
      ...lifecycle.dependencies,
      health: async () => ++healthCalls > 1,
      delay: async () => undefined,
    })).rejects.toThrow(/health check failed/);

    expect(lifecycle.started).toEqual([fixture.target, fixture.target]);
    expect(fs.readFileSync(path.join(fixture.target, "config.yaml"), "utf-8")).toBe(originalConfig);
    expect(fs.existsSync(path.join(fixture.target, "Mover"))).toBe(false);
    expect(readPhase(fixture.requestFile)).toBe("failed-rolled-back");
  });

  it("moves one Bot, starts the target, and leaves an empty source stopped", async () => {
    const fixture = await createMoveFixture();
    const lifecycle = fakeLifecycle(new Set([fixture.source]));
    await runBotTransferWorker(fixture.requestFile, {
      ...lifecycle.dependencies,
      health: async () => true,
      delay: async () => undefined,
    });

    expect(lifecycle.stopped.sort()).toEqual([fixture.source, fixture.target].sort());
    expect(lifecycle.started).toEqual([fixture.target]);
    expect(readBotIds(fixture.source)).toEqual([]);
    expect(readBotIds(fixture.target)).toEqual(["Existing", "Mover"]);
    expect(readPhase(fixture.requestFile)).toBe("success");
  });

  it("rolls a move back and restores both originally running Engines", async () => {
    const fixture = await createMoveFixture();
    const sourceConfig = fs.readFileSync(path.join(fixture.source, "config.yaml"), "utf-8");
    const targetConfig = fs.readFileSync(path.join(fixture.target, "config.yaml"), "utf-8");
    const lifecycle = fakeLifecycle(new Set([fixture.source, fixture.target]));
    let healthCalls = 0;
    await expect(runBotTransferWorker(fixture.requestFile, {
      ...lifecycle.dependencies,
      health: async () => ++healthCalls > 1,
      delay: async () => undefined,
    })).rejects.toThrow(/target Engine health check failed/);

    expect(fs.readFileSync(path.join(fixture.source, "config.yaml"), "utf-8")).toBe(sourceConfig);
    expect(fs.readFileSync(path.join(fixture.target, "config.yaml"), "utf-8")).toBe(targetConfig);
    expect(fs.existsSync(path.join(fixture.source, "Mover", "niubot.db"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.target, "Mover"))).toBe(false);
    expect(lifecycle.started).toEqual([fixture.target, fixture.source, fixture.target]);
    expect(readPhase(fixture.requestFile)).toBe("failed-rolled-back");
  });

  it("takes over a crashed move, rolls data back, and restores both Engines", async () => {
    const fixture = await createMoveFixture();
    const sourceConfig = fs.readFileSync(path.join(fixture.source, "config.yaml"), "utf-8");
    const targetConfig = fs.readFileSync(path.join(fixture.target, "config.yaml"), "utf-8");
    const request = JSON.parse(fs.readFileSync(fixture.requestFile, "utf-8")) as BotTransferWorkerRequest;
    const moved = await moveBot({
      sourceHome: fixture.source,
      targetHome: fixture.target,
      botId: "Mover",
      apply: true,
      sourceVersion: "1",
      transactionId: request.id,
    });
    const stateFile = path.join(path.dirname(fixture.requestFile), "state.json");
    fs.writeFileSync(stateFile, JSON.stringify({
      schemaVersion: 1,
      id: request.id,
      kind: "move",
      phase: "starting",
      homes: [fixture.source, fixture.target],
      before: [
        { home: fixture.source, wasRunning: true, runtime: runtimeTarget(fixture.root) },
        { home: fixture.target, wasRunning: true, runtime: runtimeTarget(fixture.root) },
      ],
      result: moved,
    }), { mode: 0o600 });
    for (const home of [fixture.source, fixture.target]) {
      const active = path.join(home, "run", "bot-transfer-active");
      fs.mkdirSync(active, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(active, `${request.id}.json`), JSON.stringify({
        schemaVersion: 1,
        id: request.id,
        pid: 999_999_999,
        processStartMarker: "dead",
        primaryHome: fixture.target,
        stateFile,
      }), { mode: 0o600 });
    }
    const lifecycle = fakeLifecycle(new Set());
    const recovered = await recoverStaleBotTransferLifecycles(fixture.source, {
      ...lifecycle.dependencies,
      health: async () => true,
    });

    expect(recovered).toBe(1);
    expect(fs.readFileSync(path.join(fixture.source, "config.yaml"), "utf-8")).toBe(sourceConfig);
    expect(fs.readFileSync(path.join(fixture.target, "config.yaml"), "utf-8")).toBe(targetConfig);
    expect(lifecycle.started.sort()).toEqual([fixture.source, fixture.target].sort());
    expect(fs.existsSync(fixture.requestFile)).toBe(false);
    expect(fs.existsSync(path.join(fixture.target, "Mover"))).toBe(false);
    expect(fs.existsSync(path.join(fixture.source, "Mover", "niubot.db"))).toBe(true);
  });

  it("cleans up an early crashed job without stopping an Engine", async () => {
    const fixture = await createImportFixture();
    const request = JSON.parse(fs.readFileSync(fixture.requestFile, "utf-8")) as BotTransferWorkerRequest;
    const stateFile = path.join(path.dirname(fixture.requestFile), "state.json");
    fs.writeFileSync(stateFile, JSON.stringify({
      schemaVersion: 1,
      id: request.id,
      kind: "import",
      phase: "preflight",
      homes: [fixture.target],
    }), { mode: 0o600 });
    const active = path.join(fixture.target, "run", "bot-transfer-active");
    fs.mkdirSync(active, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(active, `${request.id}.json`), JSON.stringify({
      schemaVersion: 1,
      id: request.id,
      status: "running",
      pid: 999_999_999,
      processStartMarker: "dead",
      primaryHome: fixture.target,
      stateFile,
    }), { mode: 0o600 });
    const lifecycle = fakeLifecycle(new Set([fixture.target]));

    expect(await recoverStaleBotTransferLifecycles(fixture.target, lifecycle.dependencies)).toBe(1);
    expect(lifecycle.stopped).toEqual([]);
    expect(lifecycle.started).toEqual([]);
    expect(fs.existsSync(fixture.requestFile)).toBe(false);
    expect(fs.existsSync(active)).toBe(false);
  });

  it("recovers dead workers that exited before creating their first state", async () => {
    for (const status of ["running", "launching"] as const) {
      const fixture = await createImportFixture();
      const request = JSON.parse(fs.readFileSync(fixture.requestFile, "utf-8")) as BotTransferWorkerRequest;
      const stateFile = path.join(path.dirname(fixture.requestFile), "state.json");
      const active = path.join(fixture.target, "run", "bot-transfer-active");
      fs.mkdirSync(active, { recursive: true, mode: 0o700 });
      const markerFile = path.join(active, `${request.id}.json`);
      fs.writeFileSync(markerFile, JSON.stringify({
        schemaVersion: 1,
        id: request.id,
        status,
        pid: 999_999_999,
        processStartMarker: "dead",
        primaryHome: fixture.target,
        stateFile,
      }), { mode: 0o600 });
      if (status === "launching") {
        const expired = new Date(Date.now() - 31_000);
        fs.utimesSync(markerFile, expired, expired);
      }
      const lifecycle = fakeLifecycle(new Set([fixture.target]));

      expect(await recoverStaleBotTransferLifecycles(fixture.target, lifecycle.dependencies)).toBe(1);
      expect(lifecycle.stopped).toEqual([]);
      expect(lifecycle.started).toEqual([]);
      expect(fs.existsSync(fixture.requestFile)).toBe(false);
      expect(fs.existsSync(active)).toBe(false);
    }
  });
});

async function createImportFixture() {
  const root = temporaryRoot("niubot-transfer-worker-import-");
  createFakeRuntime(root);
  const source = createHome(path.join(root, "source"), "Mover");
  const target = createHome(path.join(root, "target"), "Existing");
  const bundle = path.join(root, "Mover.nbot");
  await exportBotBundle({ home: source, botId: "Mover", outputPath: bundle, sourceVersion: "1" });
  const request: BotTransferWorkerRequest = {
    schemaVersion: 1,
    id: randomUUID(),
    kind: "import",
    createdAt: new Date().toISOString(),
    home: target,
    bundlePath: bundle,
    appId: "new-id",
    appSecret: "new-secret",
    runtime: runtimeTarget(root),
  };
  return { root, source, target, requestFile: writeRequest(target, request) };
}

async function createMoveFixture() {
  const root = temporaryRoot("niubot-transfer-worker-move-");
  createFakeRuntime(root);
  const source = createHome(path.join(root, "source"), "Mover");
  const target = createHome(path.join(root, "target"), "Existing");
  const request: BotTransferWorkerRequest = {
    schemaVersion: 1,
    id: randomUUID(),
    kind: "move",
    createdAt: new Date().toISOString(),
    sourceHome: source,
    targetHome: target,
    botId: "Mover",
    sourceVersion: "1",
    runtime: runtimeTarget(root),
  };
  return { root, source, target, requestFile: writeRequest(target, request) };
}

function fakeLifecycle(initiallyRunning: Set<string>) {
  const stopped: string[] = [];
  const started: string[] = [];
  const inspect = async (home: string): Promise<RunningEngine | undefined> => {
    if (!initiallyRunning.has(home)) return undefined;
    const state = fakeState(home);
    return { state, identity: {
      pid: state.pid,
      instanceId: state.instanceId,
      home,
      version: state.version,
      runtimePath: state.runtimePath,
      startedAt: state.startedAt,
    } };
  };
  return {
    stopped,
    started,
    dependencies: {
      inspect,
      stop: async (home: string) => {
        stopped.push(home);
        initiallyRunning.delete(home);
        return { stopped: true, pid: 1234 };
      },
      launch: (options: LaunchEngineOptions) => {
        started.push(options.niubotHome);
        return fakeLaunch(options.niubotHome);
      },
    },
  };
}

function fakeLaunch(home: string): LaunchedEngine {
  return {
    state: fakeState(home),
    endpoint: { kind: "unix-socket", address: path.join(home, "run", "engine.sock") },
  };
}

function fakeState(home: string) {
  return {
    pid: 1234,
    instanceId: `instance-${path.basename(home)}`,
    startedAt: new Date().toISOString(),
    endpoint: path.join(home, "run", "engine.sock"),
    endpointKind: "unix-socket" as const,
    controlToken: "token",
    version: "1.0.0",
    runtimePath: path.dirname(home),
    nodePath: process.execPath,
  };
}

function runtimeTarget(root: string) {
  return { runtimePath: root, nodePath: process.execPath, version: "1.0.0", runtimeMode: "dev" };
}

function createFakeRuntime(root: string): void {
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "index.js"), "// fixture Engine entry\n");
}

function writeRequest(home: string, request: BotTransferWorkerRequest): string {
  const directory = path.join(home, "run", "bot-transfer-jobs", request.id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const requestFile = path.join(directory, "request.json");
  fs.writeFileSync(requestFile, JSON.stringify(request), { mode: 0o600 });
  return requestFile;
}

function readPhase(requestFile: string): string {
  return JSON.parse(fs.readFileSync(path.join(path.dirname(requestFile), "state.json"), "utf-8")).phase;
}

function createHome(home: string, botId: string): string {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.yaml"), yaml.stringify({
    bots: [{ id: botId, backend: "codex", appId: `${botId}-id`, appSecret: `${botId}-secret` }],
  }), { mode: 0o600 });
  const botDirectory = path.join(home, botId);
  fs.mkdirSync(botDirectory);
  initDatabase(path.join(botDirectory, "niubot.db")).close();
  fs.writeFileSync(path.join(botDirectory, "bot_profile.md"), `# ${botId}\n`, { mode: 0o600 });
  return home;
}

function readBotIds(home: string): string[] {
  return yaml.parse(fs.readFileSync(path.join(home, "config.yaml"), "utf-8")).bots.map((bot: { id: string }) => bot.id);
}

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
