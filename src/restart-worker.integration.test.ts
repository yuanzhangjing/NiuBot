import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectRunningEngine, launchDetachedEngine, stopEngine } from "./process-manager.js";
import { ReleaseStore } from "./release-store.js";
import { HomeReleaseStore } from "./home-release-store.js";
import { computeTreeDigest, createSharedReleaseManifest, SharedReleaseStore } from "./shared-release-store.js";
import { currentNodeRuntimeRef } from "./release-ref.js";
import { runRestartWorker } from "./restart-worker.js";
import { readProcessState } from "./process-state.js";
import { readEngineIdentity, waitForEngineIdentity } from "./local-api/engine-client.js";
import { endpointFromAddress } from "./platform/ipc.js";
import Database from "better-sqlite3";
import { createRestartDatabaseSnapshot } from "./database/restart-snapshot.js";
import { RecommendedReleaseStore } from "./recommended-release.js";

const tempDirs: string[] = [];
const RESTART_IT_TIMEOUT = process.platform === "win32" ? 90_000 : 30_000;

beforeEach(() => {
  // Agent-launched test runs inherit the live chat and local API route. Keep
  // temporary restart workers from sending their success notices to that chat.
  for (const name of [
    "NIUBOT_CHAT_ID",
    "NIUBOT_API_SOCKET",
    "NIUBOT_RESTART_NOTIFY_CHAT_ID",
  ]) {
    vi.stubEnv(name, "");
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of tempDirs.splice(0)) {
    try { await stopEngine(path.join(directory, "home")); } catch { /* test may fail before launch */ }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("restart worker integration", () => {
  it("activates the production recommendation for a stopped home", async () => {
    const fixture = createRecommendedFixture(true);
    // Older CLIs fall back to this flat file when they cannot query the new
    // Engine identity API. It must change in the same activation transaction.
    fs.writeFileSync(path.join(fixture.home, "niubot.version"), "0.1.90");
    await runTestRestartWorker({
      ...process.env,
      NIUBOT_SHARED_STORE: fixture.sharedStore.rootDirectory,
      NIUBOT_HOME: fixture.home,
      NIUBOT_BOT_NAME: "TestBot",
      NIUBOT_SOURCE_DIR: fixture.currentRuntime,
      NIUBOT_ENV: "production",
      NIUBOT_RESTART_MODE: "recommended",
      NIUBOT_RECOMMENDED_ARTIFACT_ID: fixture.candidate.artifactId,
      NIUBOT_RECOMMENDED_GENERATION: String(fixture.generation),
    });
    const running = await inspectRunningEngine(fixture.home);
    expect(running?.identity.version).toBe("2.0.0");
    expect(fs.readFileSync(path.join(fixture.home, "niubot.version"), "utf8")).toBe("2.0.0");
    expect(fixture.homeStore.readState().current).toEqual(fixture.candidate);
    expect(fixture.homeStore.readState().rejectedRecommendation).toBeUndefined();
  }, RESTART_IT_TIMEOUT);

  it("safely activates an exact Launcher candidate for an empty home", async () => {
    const fixture = createRecommendedFixture(true);
    fixture.homeStore.writeState({ schemaVersion: 2 });
    fixture.homeStore.writeSharedRef({ state: fixture.homeStore.readStateStrict() });
    fs.rmSync(path.join(fixture.sharedStore.rootDirectory, "recommended.json"), { force: true });

    await runTestRestartWorker({
      ...process.env,
      NIUBOT_SHARED_STORE: fixture.sharedStore.rootDirectory,
      NIUBOT_HOME: fixture.home,
      NIUBOT_BOT_NAME: "TestBot",
      NIUBOT_SOURCE_DIR: fixture.currentRuntime,
      NIUBOT_ENV: "production",
      NIUBOT_RESTART_MODE: "candidate",
      NIUBOT_CANDIDATE_ARTIFACT_ID: fixture.candidate.artifactId,
    });

    const running = await inspectRunningEngine(fixture.home);
    expect(running?.identity.version).toBe("2.0.0");
    expect(fixture.homeStore.readState().current).toEqual(fixture.candidate);
    expect(new RecommendedReleaseStore(fixture.sharedStore).read()).toBeUndefined();
  }, RESTART_IT_TIMEOUT);

  it("restores current and remembers a rejected recommendation", async () => {
    const fixture = createRecommendedFixture(false);
    vi.stubEnv("NIUBOT_RESTART_HEALTH_TIMEOUT", "1");
    await runTestRestartWorker({
      ...process.env,
      NIUBOT_SHARED_STORE: fixture.sharedStore.rootDirectory,
      NIUBOT_HOME: fixture.home,
      NIUBOT_BOT_NAME: "TestBot",
      NIUBOT_SOURCE_DIR: fixture.currentRuntime,
      NIUBOT_ENV: "production",
      NIUBOT_RESTART_MODE: "recommended",
      NIUBOT_RECOMMENDED_ARTIFACT_ID: fixture.candidate.artifactId,
      NIUBOT_RECOMMENDED_GENERATION: String(fixture.generation),
    });
    const running = await inspectRunningEngine(fixture.home);
    expect(running?.identity.version).toBe("1.0.0");
    const state = fixture.homeStore.readState();
    expect(state.current).toEqual(fixture.current);
    expect(state.rejectedRecommendation).toMatchObject({
      generation: fixture.generation,
      artifactId: fixture.candidate.artifactId,
    });
  }, RESTART_IT_TIMEOUT);

  it("remembers a recommendation rejected during preflight without stopping the old Engine", async () => {
    const fixture = createRecommendedFixture(true, 23);
    await expect(runTestRestartWorker({
      ...process.env,
      NIUBOT_SHARED_STORE: fixture.sharedStore.rootDirectory,
      NIUBOT_HOME: fixture.home,
      NIUBOT_BOT_NAME: "TestBot",
      NIUBOT_SOURCE_DIR: fixture.currentRuntime,
      NIUBOT_ENV: "production",
      NIUBOT_RESTART_MODE: "recommended",
      NIUBOT_RECOMMENDED_ARTIFACT_ID: fixture.candidate.artifactId,
      NIUBOT_RECOMMENDED_GENERATION: String(fixture.generation),
    })).rejects.toThrow(/preflight/i);
    expect(await inspectRunningEngine(fixture.home)).toBeUndefined();
    expect(fixture.homeStore.readState()).toMatchObject({
      current: fixture.current,
      rejectedRecommendation: {
        generation: fixture.generation,
        artifactId: fixture.candidate.artifactId,
      },
    });
  }, RESTART_IT_TIMEOUT);

  it("refuses to automatically downgrade a newer home", async () => {
    const fixture = createRecommendedFixture(true, 0, "3.0.0");
    await expect(runTestRestartWorker({
      ...process.env,
      NIUBOT_SHARED_STORE: fixture.sharedStore.rootDirectory,
      NIUBOT_HOME: fixture.home,
      NIUBOT_BOT_NAME: "TestBot",
      NIUBOT_SOURCE_DIR: fixture.currentRuntime,
      NIUBOT_ENV: "production",
      NIUBOT_RESTART_MODE: "recommended",
      NIUBOT_RECOMMENDED_ARTIFACT_ID: fixture.candidate.artifactId,
      NIUBOT_RECOMMENDED_GENERATION: String(fixture.generation),
    })).rejects.toThrow(/downgrade/);
    expect(fixture.homeStore.readState().current).toEqual(fixture.current);
  }, RESTART_IT_TIMEOUT);

  it("restores a stopped Engine state inside the worker after verification", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-stopped-restart-"));
    tempDirs.push(root);
    const home = path.join(root, "home");
    const runtime = path.join(root, "runtime");
    fs.mkdirSync(path.join(runtime, "dist"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({
      name: "@yuanzhangjing/niubot",
      version: "3.0.0",
      type: "module",
    }));
    fs.writeFileSync(path.join(runtime, "dist", "index.js"), fakeEngineSource(true, "3.0.0"));
    fs.writeFileSync(path.join(home, "config.yaml"), [
      "bots:",
      "  - id: TestBot",
      "    backend: codex",
      "    appId: test-app",
      "    appSecret: test-secret",
      "",
    ].join("\n"));

    await runTestRestartWorker({
      ...process.env,
      NIUBOT_SHARED_STORE: path.join(root, "shared-store"),
      NIUBOT_HOME: home,
      NIUBOT_BOT_NAME: "TestBot",
      NIUBOT_SOURCE_DIR: runtime,
      NIUBOT_ENV: "production",
      NIUBOT_RESTART_STOP_AFTER_COMPLETION: "1",
    });

    expect(await inspectRunningEngine(home)).toBeUndefined();
    expect(readProcessState(home)).toBeUndefined();
    const restartState = JSON.parse(fs.readFileSync(
      path.join(home, "TestBot", "restart", "state.json"),
      "utf-8",
    )) as { phase: string };
    expect(restartState.phase).toBe("production_success");
  }, RESTART_IT_TIMEOUT);

  it("recovers a dead transaction and its original database snapshot before restarting", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-dead-transaction-"));
    tempDirs.push(root);
    const home = path.join(root, "home");
    const runtime = path.join(home, "TestBot", "releases", "old", "package");
    const databasePath = path.join(home, "TestBot", "niubot.db");
    fs.mkdirSync(path.join(runtime, "dist"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({
      name: "@yuanzhangjing/niubot",
      version: "1.0.0",
      type: "module",
    }));
    fs.writeFileSync(path.join(runtime, "dist", "index.js"), fakeEngineSource(true, "1.0.0"));
    fs.writeFileSync(path.join(home, "config.yaml"), [
      "bots:",
      "  - id: TestBot",
      "    backend: codex",
      "    appId: test-app",
      "    appSecret: test-secret",
      `    dbPath: ${JSON.stringify(databasePath)}`,
      "",
    ].join("\n"));
    const database = new Database(databasePath);
    database.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('before')");
    database.close();
    const snapshot = await createRestartDatabaseSnapshot({
      rootDirectory: path.join(home, "TestBot", "restart", "database-snapshots", "dead-tx"),
      databasePaths: [databasePath],
    });
    const migrated = new Database(databasePath);
    migrated.exec("UPDATE marker SET value='migrated'");
    migrated.close();
    const sharedStore = new SharedReleaseStore(path.join(root, "shared-store"));
    const homeStore = new HomeReleaseStore(home, sharedStore);
    const legacy = { storage: "legacy" as const, runtimePath: runtime, node: currentNodeRuntimeRef() };
    homeStore.writeState({
      schemaVersion: 2,
      current: legacy,
      lastKnownGood: legacy,
      transaction: {
        transactionId: "dead-tx",
        phase: "activating",
        candidate: legacy,
        rollback: { current: legacy, lastKnownGood: legacy },
        ownerPid: 999_999_999,
        databaseSnapshot: snapshot,
      },
    });

    await runTestRestartWorker({
      ...process.env,
      NIUBOT_SHARED_STORE: sharedStore.rootDirectory,
      NIUBOT_HOME: home,
      NIUBOT_BOT_NAME: "TestBot",
      NIUBOT_SOURCE_DIR: runtime,
      NIUBOT_ENV: "production",
    });
    const restored = new Database(databasePath, { readonly: true });
    expect(restored.prepare("SELECT value FROM marker").pluck().get()).toBe("before");
    restored.close();
    expect(homeStore.readState().transaction).toBeUndefined();
  }, RESTART_IT_TIMEOUT);

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
      runtimeMode: "production",
      env: { NIUBOT_ENV: "production" },
    });
    expect(initial.state.runtimePath).toBe(runtime);

    await runTestRestartWorker({
      ...process.env,
      NIUBOT_SHARED_STORE: path.join(root, "shared-store"),
      NIUBOT_HOME: home,
      NIUBOT_BOT_NAME: "TestBot",
      NIUBOT_SOURCE_DIR: runtime,
      NIUBOT_ENV: "production",
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
  }, RESTART_IT_TIMEOUT);

  it("switches a running legacy Engine to the home-selected shared runtime", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-transition-restart-"));
    tempDirs.push(root);
    const home = path.join(root, "home");
    const legacyRuntime = path.join(home, "TestBot", "releases", "legacy", "package");
    const sharedStore = new SharedReleaseStore(path.join(root, "shared-store"));
    const staging = sharedStore.createStagingDirectory("transition");
    const sharedPackage = path.join(staging, "package");
    fs.mkdirSync(path.join(legacyRuntime, "dist"), { recursive: true });
    fs.mkdirSync(path.join(sharedPackage, "dist"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(legacyRuntime, "package.json"), JSON.stringify({ name: "@yuanzhangjing/niubot", version: "1.0.0", type: "module" }));
    fs.writeFileSync(path.join(legacyRuntime, "dist", "index.js"), fakeEngineSource(true, "1.0.0"));
    fs.writeFileSync(path.join(sharedPackage, "package.json"), JSON.stringify({ name: "@yuanzhangjing/niubot", version: "2.0.0", type: "module" }));
    fs.writeFileSync(path.join(sharedPackage, "dist", "index.js"), fakeEngineSource(true, "2.0.0"));
    const artifactId = "transition-shared";
    sharedStore.publishStagedArtifact({
      stagingDirectory: staging,
      manifest: createSharedReleaseManifest({
        artifactId,
        version: "2.0.0",
        sourceKind: "seed",
        sourceDigest: "transition",
        treeDigest: computeTreeDigest(sharedPackage),
        installedAt: new Date().toISOString(),
        installerNodePath: process.execPath,
        nodeVersion: process.version,
        nodeAbi: process.versions.modules,
        platform: process.platform,
        arch: process.arch,
      }),
    });
    const boundNodePath = process.platform === "win32" ? process.execPath : path.join(root, "bound-node");
    if (process.platform !== "win32") fs.symlinkSync(process.execPath, boundNodePath);
    const selected = {
      storage: "shared" as const,
      artifactId,
      node: { ...currentNodeRuntimeRef(), nodePath: boundNodePath },
    };
    new HomeReleaseStore(home, sharedStore).writeState({ schemaVersion: 2, current: selected });
    fs.writeFileSync(path.join(home, "config.yaml"), [
      "bots:",
      "  - id: TestBot",
      "    backend: codex",
      "    appId: test-app",
      "    appSecret: test-secret",
      "",
    ].join("\n"));
    const initial = launchDetachedEngine({
      niubotHome: home,
      engineEntry: path.join(legacyRuntime, "dist", "index.js"),
      runtimePath: legacyRuntime,
      logFile: path.join(home, "logs", "legacy.log"),
      version: "1.0.0",
      runtimeMode: "production",
    });
    await expect(waitForEngineIdentity(initial.endpoint, {
      instanceId: initial.state.instanceId,
      pid: initial.state.pid,
      home,
      runtimePath: legacyRuntime,
    }, 5_000, 50)).resolves.toBeTruthy();
    await runTestRestartWorker({
      ...process.env,
      NIUBOT_SHARED_STORE: sharedStore.rootDirectory,
      NIUBOT_HOME: home,
      NIUBOT_BOT_NAME: "TestBot",
      NIUBOT_SOURCE_DIR: legacyRuntime,
      NIUBOT_ENV: "production",
    });
    const running = await inspectRunningEngine(home);
    expect(running?.identity.version).toBe("2.0.0");
    expect(fs.realpathSync.native(running!.state.runtimePath)).toBe(fs.realpathSync.native(sharedStore.packageDirectory(artifactId)));
    expect(running?.state.nodePath).toBe(boundNodePath);
    const state = new HomeReleaseStore(home, sharedStore).readState();
    expect(state.current).toEqual(selected);
    expect(state).not.toHaveProperty("lastKnownGood");
    expect(state).not.toHaveProperty("previous");
    expect(state.unresolvedLegacy).toEqual([]);
  }, RESTART_IT_TIMEOUT);

  it("builds, switches, checks health, and commits current through the Node implementation", async () => {
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
      files: ["dist", "src", "npm-shrinkwrap.json"],
      scripts: {
        build: "node -e \"process.exit(0)\"",
        "pack:check": "node -e \"process.exit(0)\"",
      },
    }, null, 2)}\n`);
    writeMinimalShrinkwrap(source, "1.0.0");
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
    await runTestRestartWorker({
      ...process.env,
      NIUBOT_SHARED_STORE: path.join(root, "shared-store"),
      NIUBOT_HOME: home,
      NIUBOT_BOT_NAME: "TestBot",
      NIUBOT_SOURCE_DIR: source,
      NIUBOT_RESTART_MODE: "source",
      NIUBOT_AGENT_SESSION: undefined,
    });

    const running = await inspectRunningEngine(home);
    if (!running) {
      const restartLogDirectory = path.join(home, "logs", "restarts");
      const restartLogName = fs.readdirSync(restartLogDirectory).find((name) => name.endsWith(".log"));
      const debug = restartLogName
        ? fs.readFileSync(path.join(restartLogDirectory, restartLogName), "utf-8")
        : "restart debug log missing";
      const state = fs.readFileSync(path.join(home, "TestBot", "restart", "state.json"), "utf-8");
      const processState = readProcessState(home);
      const identity = processState
        ? await readEngineIdentity(endpointFromAddress(processState.processes.engine.endpoint), 1_000)
        : undefined;
      const serviceLogName = fs.readdirSync(path.join(home, "logs")).find((name) => name.startsWith("niubot-"));
      const serviceLog = serviceLogName ? fs.readFileSync(path.join(home, "logs", serviceLogName), "utf-8") : "";
      throw new Error(`candidate is not running\nprocess=${JSON.stringify(processState)}\nidentity=${JSON.stringify(identity)}\n${state}\n${serviceLog}\n${debug}`);
    }
    expect(running?.identity.version).toBe("1.0.0-dev.1");
    expect(running?.state.runtimePath).toContain(path.join("shared-store", "releases", ""));
    const releaseState = new HomeReleaseStore(home, new SharedReleaseStore(path.join(root, "shared-store"))).readState();
    expect(releaseState.current).toBeTruthy();
    expect(releaseState).not.toHaveProperty("lastKnownGood");
    expect(new RecommendedReleaseStore(new SharedReleaseStore(path.join(root, "shared-store"))).read()).toBeUndefined();
    await expect(stopEngine(home)).resolves.toMatchObject({ stopped: true });
  }, 120_000);

  it("rolls back to the last healthy current when the candidate fails health checks", async () => {
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
    writeMinimalShrinkwrap(source, "1.0.0");
    fs.writeFileSync(path.join(source, "src", "placeholder.js"), "export {};\n");
    fs.writeFileSync(path.join(source, "package.json"), `${JSON.stringify({
      name: "@yuanzhangjing/niubot",
      version: "1.0.0",
      type: "module",
      files: ["dist", "src", "npm-shrinkwrap.json"],
      scripts: { build: "node -e \"process.exit(0)\"", "pack:check": "node -e \"process.exit(0)\"" },
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

    await runTestRestartWorker({
      ...process.env,
      NIUBOT_SHARED_STORE: path.join(root, "shared-store"),
      NIUBOT_HOME: home,
      NIUBOT_BOT_NAME: "TestBot",
      NIUBOT_SOURCE_DIR: source,
      NIUBOT_RESTART_MODE: "source",
      NIUBOT_AGENT_SESSION: undefined,
    });
    const packageJson = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf-8"));
    packageJson.scripts.build = "node -e \"require('node:fs').copyFileSync('dist/bad.js','dist/index.js')\"";
    fs.writeFileSync(path.join(source, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);

    await runTestRestartWorker({
      ...process.env,
      NIUBOT_SHARED_STORE: path.join(root, "shared-store"),
      NIUBOT_HOME: home,
      NIUBOT_BOT_NAME: "TestBot",
      NIUBOT_SOURCE_DIR: source,
      NIUBOT_RESTART_MODE: "source",
      NIUBOT_AGENT_SESSION: undefined,
    });

    const running = await inspectRunningEngine(home);
    expect(running?.state.runtimePath).toContain(`${path.sep}releases${path.sep}`);
    const store = new HomeReleaseStore(home, new SharedReleaseStore(path.join(root, "shared-store")));
    const releaseState = store.readState();
    expect(releaseState.current).toMatchObject({ storage: "shared" });
    expect(releaseState).not.toHaveProperty("lastKnownGood");
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
    writeMinimalShrinkwrap(source, "1.0.0");
    fs.writeFileSync(path.join(source, "src", "placeholder.js"), "export {};\n");
    fs.writeFileSync(path.join(source, "package.json"), `${JSON.stringify({
      name: "@yuanzhangjing/niubot",
      version: "1.0.0",
      type: "module",
      files: ["dist", "src", "npm-shrinkwrap.json"],
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

    await expect(runTestRestartWorker({
      ...process.env,
      NIUBOT_SHARED_STORE: path.join(root, "shared-store"),
      NIUBOT_HOME: home,
      NIUBOT_BOT_NAME: "TestBot",
      NIUBOT_SOURCE_DIR: source,
      NIUBOT_RESTART_MODE: "source",
      NIUBOT_AGENT_SESSION: undefined,
    })).rejects.toThrow(/exited with code 42/);

    const running = await inspectRunningEngine(home);
    expect(running?.state.pid).toBe(initial.state.pid);
    expect(fs.realpathSync.native(running!.state.runtimePath)).toBe(fs.realpathSync.native(oldRuntime));
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
    writeMinimalShrinkwrap(source, "1.0.0");
    fs.writeFileSync(path.join(source, "src", "placeholder.js"), "export {};\n");
    fs.writeFileSync(path.join(source, "package.json"), `${JSON.stringify({
      name: "@yuanzhangjing/niubot",
      version: "1.0.0",
      type: "module",
      files: ["dist", "src", "npm-shrinkwrap.json"],
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

    await expect(runTestRestartWorker({
      ...process.env,
      NIUBOT_SHARED_STORE: path.join(root, "shared-store"),
      NIUBOT_HOME: home,
      NIUBOT_BOT_NAME: "TestBot",
      NIUBOT_SOURCE_DIR: source,
      NIUBOT_RESTART_MODE: "source",
      NIUBOT_AGENT_SESSION: undefined,
    })).rejects.toThrow();
    const running = await inspectRunningEngine(home);
    expect(fs.realpathSync.native(running!.state.runtimePath)).toBe(fs.realpathSync.native(oldRuntime));
    expect(new ReleaseStore(botDirectory).readState().current).toBe("old");
  }, 120_000);

  it("reuses a predownloaded package tarball instead of running npm pack", async () => {
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
      files: ["dist", "src", "npm-shrinkwrap.json"],
      scripts: { build: "node -e \"process.exit(0)\"", "pack:check": "node -e \"process.exit(0)\"" },
    }, null, 2)}\n`);
    writeMinimalShrinkwrap(source, "9.9.9");
    fs.writeFileSync(path.join(source, "src", "placeholder.js"), "export {};\n");
    fs.writeFileSync(path.join(source, "dist", "index.js"), fakeEngineSource(true, "9.9.9"));
    fs.writeFileSync(path.join(home, "config.yaml"), [
      "bots:",
      "  - id: TestBot",
      "    backend: codex",
      "    appId: test-app",
      "    appSecret: test-secret",
      `restart:\n  sourceDirectory: ${JSON.stringify(source)}`,
      "",
    ].join("\n"));

    // 预下载：在 bot 的 packages 目录预置目标版本 tgz（模拟 auto-upgrade predownloadPackage）
    const botDirectory = path.join(home, "TestBot");
    const packagesDir = path.join(botDirectory, "packages");
    fs.mkdirSync(packagesDir, { recursive: true });
    const archivePath = path.join(packagesDir, "yuanzhangjing-niubot-9.9.9.tgz");
    // 构造一个最小合法 tgz：tar 解出 package/（含 package.json 和 dist/index.js）
    const staging = path.join(root, "staging");
    const pkgRoot = path.join(staging, "package");
    fs.mkdirSync(path.join(pkgRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, "package.json"), `${JSON.stringify({
      name: "@yuanzhangjing/niubot",
      version: "9.9.9",
      type: "module",
    })}\n`);
    fs.writeFileSync(path.join(pkgRoot, "dist", "index.js"), fakeEngineSource(true, "9.9.9"));
    writeMinimalShrinkwrap(pkgRoot, "9.9.9");
    await new Promise<void>((resolve, reject) => {
      const { execFile } = require("node:child_process") as typeof import("node:child_process");
      execFile("tar", ["-czf", archivePath, "-C", staging, "package"], (err) => err ? reject(err) : resolve());
    });
    fs.rmSync(staging, { recursive: true, force: true });

    // 9.9.9 在 npm registry 不存在：如果 worker 没复用本地 tgz，npm pack 会失败；
    // 复用则跳过 pack 直接解压本地包，流程成功。
    await runTestRestartWorker({
      ...process.env,
      NIUBOT_SHARED_STORE: path.join(root, "shared-store"),
      NIUBOT_HOME: home,
      NIUBOT_BOT_NAME: "TestBot",
      NIUBOT_SOURCE_DIR: source,
      NIUBOT_RESTART_MODE: "npm-update",
      NIUBOT_UPDATE_VERSION: "9.9.9",
      NIUBOT_ENV: "production",
      NIUBOT_AUTO_UPDATE: "1",
      NIUBOT_AGENT_SESSION: undefined,
    });

    const running = await inspectRunningEngine(home);
    expect(running?.identity.version).toBe("9.9.9");
    // 自动升级标记写入 state.json 且跨 phase 保留（成功阶段仍为 true）
    const state = JSON.parse(fs.readFileSync(
      path.join(home, "TestBot", "restart", "state.json"), "utf-8",
    )) as { phase: string; autoUpdate?: boolean };
    expect(state.phase).toBe("success");
    expect(state.autoUpdate).toBe(true);
  }, 120_000);
});

function createRecommendedFixture(candidateHealthy: boolean, preflightExitCode = 0, currentVersion = "1.0.0") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-recommended-worker-"));
  tempDirs.push(root);
  const home = path.join(root, "home");
  const currentRuntime = path.join(home, "TestBot", "releases", "current", "package");
  fs.mkdirSync(path.join(currentRuntime, "dist"), { recursive: true });
  fs.writeFileSync(path.join(currentRuntime, "package.json"), JSON.stringify({
    name: "@yuanzhangjing/niubot", version: currentVersion, type: "module",
  }));
  fs.writeFileSync(path.join(currentRuntime, "dist", "index.js"), fakeEngineSource(true, currentVersion));
  fs.writeFileSync(path.join(home, "config.yaml"), [
    "bots:",
    "  - id: TestBot",
    "    backend: codex",
    "    appId: test-app",
    "    appSecret: test-secret",
    "",
  ].join("\n"));

  const sharedStore = new SharedReleaseStore(path.join(root, "shared"));
  const staging = sharedStore.createStagingDirectory("recommended");
  const packageDirectory = path.join(staging, "package");
  fs.mkdirSync(path.join(packageDirectory, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({
    name: "@yuanzhangjing/niubot", version: "2.0.0", type: "module",
  }));
  fs.writeFileSync(path.join(packageDirectory, "dist", "index.js"), fakeEngineSource(candidateHealthy, "2.0.0", false, preflightExitCode));
  const artifactId = candidateHealthy ? "recommended-good" : "recommended-bad";
  sharedStore.publishStagedArtifact({
    stagingDirectory: staging,
    manifest: createSharedReleaseManifest({
      artifactId, version: "2.0.0", sourceKind: "npm", sourceDigest: artifactId,
      treeDigest: computeTreeDigest(packageDirectory), installedAt: new Date().toISOString(),
      installerNodePath: process.execPath, nodeVersion: process.version,
      nodeAbi: process.versions.modules, platform: process.platform, arch: process.arch,
    }),
  });
  const node = currentNodeRuntimeRef();
  const current = { storage: "legacy" as const, runtimePath: currentRuntime, node };
  const candidate = { storage: "shared" as const, artifactId, node };
  const homeStore = new HomeReleaseStore(home, sharedStore);
  homeStore.writeState({ schemaVersion: 2, current });
  homeStore.writeSharedRef({ state: homeStore.readStateStrict() });
  const recommendation = new RecommendedReleaseStore(sharedStore).promote(candidate);
  return { home, currentRuntime, sharedStore, homeStore, current, candidate, generation: recommendation.generation };
}

function writeMinimalShrinkwrap(packageRoot: string, version: string): void {
  fs.writeFileSync(path.join(packageRoot, "npm-shrinkwrap.json"), `${JSON.stringify({
    name: "@yuanzhangjing/niubot",
    version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "@yuanzhangjing/niubot", version },
    },
  }, null, 2)}\n`);
}

function runTestRestartWorker(env: NodeJS.ProcessEnv): Promise<void> {
  return runRestartWorker(env, { verifySharedPackage: () => undefined });
}

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
let runtimeVersion = "${version}";
try { runtimeVersion = JSON.parse(fs.readFileSync(path.join(runtimePath, "package.json"), "utf-8")).version || runtimeVersion; } catch {}
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
      version: runtimeVersion,
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
