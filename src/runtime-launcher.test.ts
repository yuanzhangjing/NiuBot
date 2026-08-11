import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeReleaseStore } from "./home-release-store.js";
import { importInstalledProductionPackage, parseLauncherHome, runRuntimeLauncher } from "./runtime-launcher.js";
import { SharedReleaseStore } from "./shared-release-store.js";
import { currentNodeRuntimeRef, type ReleaseRef } from "./release-ref.js";
import { RecommendedReleaseStore } from "./recommended-release.js";
import { SharedReleaseInstaller } from "./shared-release-installer.js";

const tempDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-launcher-"));
  tempDirectories.push(root);
  return root;
}

function createSeed(root: string, version = "1.0.0", name = "seed", label?: string): string {
  const seed = path.join(root, name);
  fs.mkdirSync(path.join(seed, "dist"), { recursive: true });
  fs.mkdirSync(path.join(seed, "node_modules"));
  fs.writeFileSync(path.join(seed, "package.json"), JSON.stringify({
    name: "@yuanzhangjing/niubot",
    version,
    type: "module",
  }));
  for (const entry of ["user-cli.js", "cli.js"]) {
    fs.writeFileSync(path.join(seed, "dist", entry), [
      "import fs from 'node:fs';",
      `fs.writeFileSync(process.env.NIUBOT_TEST_LAUNCH_MARKER, JSON.stringify({ args: process.argv.slice(2), home: process.env.NIUBOT_HOME${label ? `, label: ${JSON.stringify(label)}, runtimeEnvironment: process.env.NIUBOT_ENV, sourceFirstStart: process.env.NIUBOT_SOURCE_FIRST_START, candidateArtifactId: process.env.NIUBOT_LAUNCH_CANDIDATE_ARTIFACT_ID` : ""} }));`,
      "",
    ].join("\n"));
  }
  return seed;
}

async function bootstrapFixture(options: {
  homeStore: HomeReleaseStore;
  installedPackageRoot: string;
  env: NodeJS.ProcessEnv;
  verify?: (packageDirectory: string, version: string) => void | Promise<void>;
}) {
  const ref = await importInstalledProductionPackage({
    homeStore: options.homeStore,
    packageRoot: options.installedPackageRoot,
    env: options.env,
    verify: options.verify,
  });
  const state = options.homeStore.commitInitialHealthy(ref);
  options.homeStore.writeSharedRef({ state });
  new RecommendedReleaseStore(options.homeStore.sharedStore).promote(ref);
  return state;
}

async function installDevFixture(homeStore: HomeReleaseStore, packageRoot: string) {
  const installed = await new SharedReleaseInstaller(homeStore.sharedStore).importInstalledTree({
    sourceDirectory: packageRoot,
    sourceKind: "legacy",
    nodePath: process.execPath,
    nodeVersion: process.version,
    nodeAbi: process.versions.modules,
    cwd: packageRoot,
    env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
    verify: () => undefined,
  });
  const ref = { storage: "shared" as const, artifactId: installed.artifactId, node: currentNodeRuntimeRef() };
  const state = homeStore.commitInitialHealthy(ref);
  homeStore.writeSharedRef({ state });
  return ref;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("runtime launcher", () => {
  it("resolves --home and removes it from nbt arguments", () => {
    const parsed = parseLauncherHome(["task", "list", "--home", "./custom"], {});
    expect(parsed.home).toBe(path.resolve("custom"));
    expect(parsed.forwardedArgs).toEqual(["task", "list"]);
  });

  it("imports an installed production package without binding the home", async () => {
    const root = temporaryRoot();
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    const shared = new SharedReleaseStore(path.join(root, "shared"));
    const store = new HomeReleaseStore(home, shared);
    const ref = await importInstalledProductionPackage({
      homeStore: store,
      packageRoot: createSeed(root),
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
      verify: () => undefined,
    });
    expect(ref).toMatchObject({ storage: "shared" });
    expect(store.readState().current).toBeUndefined();
    expect(shared.readAllHomeRefs()).toHaveLength(0);
  });

  it("does not write home state while importing an installed package", async () => {
    const root = temporaryRoot();
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    const shared = new SharedReleaseStore(path.join(root, "shared"));
    const store = new HomeReleaseStore(home, shared);
    const writeState = vi.spyOn(store, "writeState");
    await expect(importInstalledProductionPackage({
      homeStore: store,
      packageRoot: createSeed(root),
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
      verify: () => undefined,
    })).resolves.toMatchObject({ storage: "shared" });
    expect(writeState).not.toHaveBeenCalled();
    expect(shared.readHomeRef(store.homeId)).toBeUndefined();
  });

  it("routes update through a newer globally installed package without committing before health", async () => {
    const root = temporaryRoot();
    const home = path.join(root, "home");
    const marker = path.join(root, "takeover.json");
    fs.mkdirSync(home);
    const shared = new SharedReleaseStore(path.join(root, "shared"));
    const store = new HomeReleaseStore(home, shared);
    const oldCurrent: ReleaseRef = {
      storage: "legacy",
      runtimePath: createSeed(home, "0.1.121", path.join("LegacyBot", "releases", "old", "package"), "old"),
      node: currentNodeRuntimeRef(),
    };
    store.writeState({ schemaVersion: 2, current: oldCurrent });

    const code = await runRuntimeLauncher({
      command: "niubot",
      argv: ["update", "--home", home],
      installedPackageRoot: createSeed(root, "0.2.17", "global-latest", "new"),
      bootstrapVerify: () => undefined,
      env: {
        NIUBOT_HOME: home,
        NIUBOT_SHARED_STORE: shared.rootDirectory,
        NIUBOT_TEST_LAUNCH_MARKER: marker,
        NIUBOT_ALLOW_ROOT_STORE: "1",
      },
    });

    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(marker, "utf-8"))).toMatchObject({
      label: "new",
      args: ["update", "--home", home],
      runtimeEnvironment: "production",
    });
    expect(JSON.parse(fs.readFileSync(marker, "utf-8")).candidateArtifactId).toEqual(expect.any(String));
    expect(store.readState().current).toEqual(oldCurrent);
  });

  it("uses the packaged production CLI as the all-Home update control plane when entered through DEV", async () => {
    const root = temporaryRoot();
    const home = path.join(root, "dev-home");
    const marker = path.join(root, "dev-control-plane.json");
    fs.mkdirSync(home);
    const shared = new SharedReleaseStore(path.join(root, "shared"));
    const store = new HomeReleaseStore(home, shared);
    const devRef = await installDevFixture(store, createSeed(root, "0.2.20", "dev-runtime", "dev"));
    const devManifest = shared.readManifest(devRef.artifactId)!;
    fs.writeFileSync(shared.manifestFile(devRef.artifactId), `${JSON.stringify({ ...devManifest, sourceKind: "source" }, null, 2)}\n`);

    const code = await runRuntimeLauncher({
      command: "niubot",
      argv: ["update"],
      installedPackageRoot: createSeed(root, "0.2.19", "global-production", "production-control"),
      bootstrapVerify: () => undefined,
      env: {
        NIUBOT_HOME: home,
        NIUBOT_SHARED_STORE: shared.rootDirectory,
        NIUBOT_TEST_LAUNCH_MARKER: marker,
        NIUBOT_ALLOW_ROOT_STORE: "1",
      },
    });

    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(marker, "utf-8"))).toMatchObject({
      label: "production-control",
      args: ["update"],
      runtimeEnvironment: "production",
      candidateArtifactId: "",
    });
    expect(store.readState().current).toEqual(devRef);
  });

  it("does not use an older globally installed package to downgrade update", async () => {
    const root = temporaryRoot();
    const home = path.join(root, "home");
    const marker = path.join(root, "no-downgrade.json");
    fs.mkdirSync(home);
    const shared = new SharedReleaseStore(path.join(root, "shared"));
    await bootstrapFixture({
      homeStore: new HomeReleaseStore(home, shared),
      installedPackageRoot: createSeed(root, "0.2.17", "current-newer", "current"),
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
      verify: () => undefined,
    });

    const code = await runRuntimeLauncher({
      command: "niubot",
      argv: ["update", "--home", home],
      installedPackageRoot: createSeed(root, "0.2.16", "global-older", "older"),
      env: {
        NIUBOT_SHARED_STORE: shared.rootDirectory,
        NIUBOT_TEST_LAUNCH_MARKER: marker,
        NIUBOT_ALLOW_ROOT_STORE: "1",
      },
    });

    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(marker, "utf-8"))).toMatchObject({ label: "current" });
  });

  it("launches the shared CLI selected by the home state", async () => {
    const root = temporaryRoot();
    const home = path.join(root, "home");
    const marker = path.join(root, "launched.json");
    fs.mkdirSync(home);
    const code = await runRuntimeLauncher({
      command: "nbt",
      argv: ["task", "list", "--home", home],
      installedPackageRoot: createSeed(root),
      bootstrapVerify: () => undefined,
      env: {
        NIUBOT_SHARED_STORE: path.join(root, "shared"),
        NIUBOT_TEST_LAUNCH_MARKER: marker,
        NIUBOT_ALLOW_ROOT_STORE: "1",
      },
    });
    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(marker, "utf-8"))).toEqual({
      args: ["task", "list"],
      home: path.resolve(home),
    });
  });

  it("routes an empty source home through the source-first-start path", async () => {
    const root = temporaryRoot();
    const home = path.join(root, "home");
    const marker = path.join(root, "source-start.json");
    fs.mkdirSync(home);
    const source = createSeed(root, "1.0.0", "source-entry", "source");
    fs.mkdirSync(path.join(source, "src"));

    const code = await runRuntimeLauncher({
      command: "niubot",
      argv: ["start", "--home", home],
      installedPackageRoot: source,
      env: { NIUBOT_TEST_LAUNCH_MARKER: marker },
    });

    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(marker, "utf-8"))).toMatchObject({
      runtimeEnvironment: "dev",
      sourceFirstStart: "1",
    });
    expect(new HomeReleaseStore(home, new SharedReleaseStore(path.join(root, "shared"))).readState().current).toBeUndefined();
  });

  it("reuses one seed artifact across two homes", async () => {
    const root = temporaryRoot();
    const seed = createSeed(root);
    const shared = new SharedReleaseStore(path.join(root, "shared"));
    for (const name of ["home-a", "home-b"]) {
      const home = path.join(root, name);
      fs.mkdirSync(home);
      await bootstrapFixture({
        homeStore: new HomeReleaseStore(home, shared),
        installedPackageRoot: seed,
        env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
        verify: () => undefined,
      });
    }
    expect(fs.readdirSync(shared.releasesDirectory, { withFileTypes: true }).filter((entry) => entry.isDirectory())).toHaveLength(1);
    expect(shared.readAllHomeRefs()).toHaveLength(2);
  });

  it("uses the recommended management CLI for another production home's next start", async () => {
    const root = temporaryRoot();
    const shared = new SharedReleaseStore(path.join(root, "shared"));
    const oldHome = path.join(root, "old-home");
    const newHome = path.join(root, "new-home");
    fs.mkdirSync(oldHome);
    fs.mkdirSync(newHome);
    const oldStore = new HomeReleaseStore(oldHome, shared);
    const oldState = await bootstrapFixture({
      homeStore: oldStore,
      installedPackageRoot: createSeed(root, "1.0.0", "old-seed", "old"),
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
      verify: () => undefined,
    });
    await bootstrapFixture({
      homeStore: new HomeReleaseStore(newHome, shared),
      installedPackageRoot: createSeed(root, "2.0.0", "new-seed", "recommended"),
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
      verify: () => undefined,
    });
    const marker = path.join(root, "recommended-start.json");
    const code = await runRuntimeLauncher({
      command: "niubot",
      argv: ["start", "--home", oldHome],
      env: {
        NIUBOT_SHARED_STORE: shared.rootDirectory,
        NIUBOT_TEST_LAUNCH_MARKER: marker,
        NIUBOT_ALLOW_ROOT_STORE: "1",
      },
    });
    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(marker, "utf-8"))).toMatchObject({ label: "recommended" });
    expect(oldStore.readState().current).toEqual(oldState.current);
  });

  it("uses the recommended management CLI for an explicit restart", async () => {
    const root = temporaryRoot();
    const shared = new SharedReleaseStore(path.join(root, "shared"));
    const oldHome = path.join(root, "old-home");
    const newHome = path.join(root, "new-home");
    fs.mkdirSync(oldHome);
    fs.mkdirSync(newHome);
    await bootstrapFixture({
      homeStore: new HomeReleaseStore(oldHome, shared),
      installedPackageRoot: createSeed(root, "1.0.0", "old-restart-seed", "old"),
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" }, verify: () => undefined,
    });
    await bootstrapFixture({
      homeStore: new HomeReleaseStore(newHome, shared),
      installedPackageRoot: createSeed(root, "2.0.0", "new-restart-seed", "recommended"),
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" }, verify: () => undefined,
    });
    const marker = path.join(root, "recommended-restart.json");
    const code = await runRuntimeLauncher({
      command: "niubot", argv: ["restart", "--home", oldHome],
      env: {
        NIUBOT_SHARED_STORE: shared.rootDirectory,
        NIUBOT_TEST_LAUNCH_MARKER: marker,
        NIUBOT_ALLOW_ROOT_STORE: "1",
      },
    });
    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(marker, "utf-8"))).toMatchObject({ label: "recommended" });
  });

  it("uses an imported production package for recovery without overwriting current before health", async () => {
    const root = temporaryRoot();
    const home = path.join(root, "home");
    const marker = path.join(root, "recovered.json");
    fs.mkdirSync(path.join(home, "runtime"), { recursive: true });
    fs.writeFileSync(path.join(home, "runtime", "release-state.json"), JSON.stringify({
      schemaVersion: 2,
      current: { storage: "shared", artifactId: "missing", node: currentNodeRuntimeRef() },
    }));
    const code = await runRuntimeLauncher({
      command: "nbt",
      argv: ["status", "--home", home],
      installedPackageRoot: createSeed(root),
      bootstrapVerify: () => undefined,
      env: {
        NIUBOT_SHARED_STORE: path.join(root, "shared"),
        NIUBOT_TEST_LAUNCH_MARKER: marker,
        NIUBOT_ALLOW_ROOT_STORE: "1",
      },
    });
    expect(code).toBe(0);
    const state = new HomeReleaseStore(home, new SharedReleaseStore(path.join(root, "shared"))).readState();
    expect(state.current).toMatchObject({ storage: "shared" });
    expect((state.current as { artifactId: string }).artifactId).toBe("missing");
  });

  it("keeps a usable legacy v1 current instead of replacing it with the installed seed", async () => {
    const root = temporaryRoot();
    const home = path.join(root, "home");
    const legacy = path.join(home, "Bot", "releases", "old", "package");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "package.json"), JSON.stringify({
      name: "@yuanzhangjing/niubot",
      version: "0.9.0",
      type: "module",
    }));
    fs.mkdirSync(path.join(legacy, "dist"));
    fs.writeFileSync(path.join(legacy, "dist", "cli.js"), [
      "import fs from 'node:fs';",
      "fs.writeFileSync(process.env.NIUBOT_TEST_LAUNCH_MARKER, JSON.stringify({args:process.argv.slice(2),home:process.env.NIUBOT_HOME}));",
    ].join("\n"));
    const fakeSqlite = path.join(legacy, "node_modules", "better-sqlite3");
    fs.mkdirSync(fakeSqlite, { recursive: true });
    fs.writeFileSync(path.join(fakeSqlite, "package.json"), JSON.stringify({ name: "better-sqlite3", main: "index.js" }));
    fs.writeFileSync(path.join(fakeSqlite, "index.js"), "module.exports=class Database{close(){}};\n");
    fs.writeFileSync(path.join(home, "Bot", "releases", "state.json"), JSON.stringify({
      schemaVersion: 1,
      current: "old",
      lastKnownGood: "old",
    }));
    const sharedRoot = path.join(root, "shared");
    const code = await runRuntimeLauncher({
      command: "nbt",
      argv: ["status", "--home", home],
      installedPackageRoot: createSeed(root),
      bootstrapVerify: () => undefined,
      env: {
        NIUBOT_SHARED_STORE: sharedRoot,
        NIUBOT_TEST_LAUNCH_MARKER: path.join(root, "legacy-migrated.json"),
        NIUBOT_ALLOW_ROOT_STORE: "1",
      },
    });
    expect(code).toBe(0);
    const state = new HomeReleaseStore(home, new SharedReleaseStore(sharedRoot)).readState();
    expect(state.current).toMatchObject({ storage: "legacy", runtimePath: fs.realpathSync.native(legacy) });
    expect(state).not.toHaveProperty("lastKnownGood");
    expect(fs.readdirSync(path.join(sharedRoot, "releases"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("does not replace a newer usable legacy current with an older installed seed", async () => {
    const root = temporaryRoot();
    const home = path.join(root, "home");
    const marker = path.join(root, "legacy-current.json");
    const legacy = path.join(home, "Bot", "releases", "newer", "package");
    fs.mkdirSync(path.join(legacy, "dist"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "package.json"), JSON.stringify({
      name: "@yuanzhangjing/niubot",
      version: "0.2.6",
      type: "module",
    }));
    fs.writeFileSync(path.join(legacy, "dist", "cli.js"), [
      "import fs from 'node:fs';",
      "fs.writeFileSync(process.env.NIUBOT_TEST_LAUNCH_MARKER, JSON.stringify({version:'0.2.6'}));",
    ].join("\n"));
    const fakeSqlite = path.join(legacy, "node_modules", "better-sqlite3");
    fs.mkdirSync(fakeSqlite, { recursive: true });
    fs.writeFileSync(path.join(fakeSqlite, "package.json"), JSON.stringify({ name: "better-sqlite3", main: "index.js" }));
    fs.writeFileSync(path.join(fakeSqlite, "index.js"), "module.exports=class Database{close(){}};\n");
    fs.writeFileSync(path.join(home, "Bot", "releases", "state.json"), JSON.stringify({
      schemaVersion: 1,
      current: "newer",
      lastKnownGood: "newer",
    }));
    const sharedRoot = path.join(root, "shared");
    const code = await runRuntimeLauncher({
      command: "nbt",
      argv: ["status", "--home", home],
      installedPackageRoot: createSeed(root, "0.2.4"),
      bootstrapVerify: () => undefined,
      env: {
        NIUBOT_SHARED_STORE: sharedRoot,
        NIUBOT_TEST_LAUNCH_MARKER: marker,
        NIUBOT_ALLOW_ROOT_STORE: "1",
      },
    });
    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(marker, "utf-8"))).toEqual({ version: "0.2.6" });
    const state = new HomeReleaseStore(home, new SharedReleaseStore(sharedRoot)).readState();
    expect(state.current).toMatchObject({
      storage: "legacy",
      runtimePath: fs.realpathSync.native(legacy),
    });
    expect(fs.readdirSync(path.join(sharedRoot, "releases"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("keeps using a valid legacy runtime when seed migration fails", async () => {
    const root = temporaryRoot();
    const home = path.join(root, "home");
    const marker = path.join(root, "legacy-fallback.json");
    const legacy = path.join(home, "Bot", "releases", "old", "package");
    fs.mkdirSync(path.join(legacy, "dist"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "package.json"), JSON.stringify({
      name: "@yuanzhangjing/niubot",
      version: "0.9.0",
      type: "module",
    }));
    fs.writeFileSync(path.join(legacy, "dist", "cli.js"), [
      "import fs from 'node:fs';",
      "fs.writeFileSync(process.env.NIUBOT_TEST_LAUNCH_MARKER, 'legacy');",
    ].join("\n"));
    const sharedRoot = path.join(root, "shared");
    const store = new HomeReleaseStore(home, new SharedReleaseStore(sharedRoot));
    store.writeState({
      schemaVersion: 2,
      current: { storage: "legacy", runtimePath: legacy, node: currentNodeRuntimeRef() },
    });
    const seed = createSeed(root);
    fs.symlinkSync(path.join(root, "outside"), path.join(seed, "external-link"));

    const code = await runRuntimeLauncher({
      command: "nbt",
      argv: ["status", "--home", home],
      installedPackageRoot: seed,
      bootstrapVerify: () => undefined,
      env: {
        NIUBOT_SHARED_STORE: sharedRoot,
        NIUBOT_TEST_LAUNCH_MARKER: marker,
        NIUBOT_ALLOW_ROOT_STORE: "1",
      },
    });
    expect(code).toBe(0);
    expect(fs.readFileSync(marker, "utf-8")).toBe("legacy");
  });

  it("initializes an empty production home from the recommendation before an older seed", async () => {
    const root = temporaryRoot();
    const shared = new SharedReleaseStore(path.join(root, "shared"));
    const sourceHome = path.join(root, "source-home");
    const emptyHome = path.join(root, "empty-home");
    fs.mkdirSync(sourceHome);
    fs.mkdirSync(emptyHome);
    await bootstrapFixture({
      homeStore: new HomeReleaseStore(sourceHome, shared),
      installedPackageRoot: createSeed(root, "2.0.0", "recommended-empty-seed", "recommended"),
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
      verify: () => undefined,
    });
    const marker = path.join(root, "empty-home.json");
    const code = await runRuntimeLauncher({
      command: "nbt",
      argv: ["status", "--home", emptyHome],
      installedPackageRoot: createSeed(root, "1.0.0", "older-empty-seed", "old"),
      env: {
        NIUBOT_SHARED_STORE: shared.rootDirectory,
        NIUBOT_TEST_LAUNCH_MARKER: marker,
        NIUBOT_ALLOW_ROOT_STORE: "1",
      },
    });
    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(marker, "utf-8"))).toMatchObject({ label: "recommended" });
    const state = new HomeReleaseStore(emptyHome, shared).readState();
    expect(state.current).toBeUndefined();
  });

  it("keeps a source home on dev during restart even when production has a newer recommendation", async () => {
    const root = temporaryRoot();
    const shared = new SharedReleaseStore(path.join(root, "shared"));
    const devHome = path.join(root, "dev-home");
    const productionHome = path.join(root, "production-home");
    fs.mkdirSync(devHome);
    fs.mkdirSync(productionHome);
    const devRef = await installDevFixture(
      new HomeReleaseStore(devHome, shared),
      createSeed(root, "1.0.0-dev.1", "dev-seed", "dev"),
    );
    const devArtifactId = devRef.artifactId;
    const devManifest = shared.readManifest(devArtifactId)!;
    fs.writeFileSync(shared.manifestFile(devArtifactId), `${JSON.stringify({ ...devManifest, sourceKind: "source" }, null, 2)}\n`);
    await bootstrapFixture({
      homeStore: new HomeReleaseStore(productionHome, shared),
      installedPackageRoot: createSeed(root, "2.0.0", "production-seed", "production"),
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" }, verify: () => undefined,
    });
    const marker = path.join(root, "dev-restart.json");
    const code = await runRuntimeLauncher({
      command: "niubot", argv: ["restart", "--home", devHome],
      env: {
        NIUBOT_SHARED_STORE: shared.rootDirectory,
        NIUBOT_TEST_LAUNCH_MARKER: marker,
        NIUBOT_ALLOW_ROOT_STORE: "1",
      },
    });
    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(marker, "utf-8"))).toMatchObject({
      label: "dev",
      runtimeEnvironment: "dev",
    });
  });

  it("ignores a structurally valid recommendation that points at a source artifact", async () => {
    const root = temporaryRoot();
    const shared = new SharedReleaseStore(path.join(root, "shared"));
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    const state = await bootstrapFixture({
      homeStore: new HomeReleaseStore(home, shared),
      installedPackageRoot: createSeed(root, "1.0.0", "stable-seed", "stable"),
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" }, verify: () => undefined,
    });
    const sourceHome = path.join(root, "source-home");
    fs.mkdirSync(sourceHome);
    const sourceRef = await installDevFixture(
      new HomeReleaseStore(sourceHome, shared),
      createSeed(root, "2.0.0-dev.1", "source-seed", "source"),
    ) as ReleaseRef & { storage: "shared" };
    const sourceManifest = shared.readManifest(sourceRef.artifactId)!;
    fs.writeFileSync(shared.manifestFile(sourceRef.artifactId), `${JSON.stringify({ ...sourceManifest, sourceKind: "source" }, null, 2)}\n`);
    fs.writeFileSync(path.join(shared.rootDirectory, "recommended.json"), `${JSON.stringify({
      schemaVersion: 1,
      generation: 2,
      release: sourceRef,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    const marker = path.join(root, "source-recommendation.json");
    const code = await runRuntimeLauncher({
      command: "niubot", argv: ["restart", "--home", home],
      env: {
        NIUBOT_SHARED_STORE: shared.rootDirectory,
        NIUBOT_TEST_LAUNCH_MARKER: marker,
        NIUBOT_ALLOW_ROOT_STORE: "1",
      },
    });
    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(marker, "utf-8"))).toMatchObject({ label: "stable" });
    expect(new HomeReleaseStore(home, shared).readState().current).toEqual(state.current);
  });
});
