import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeReleaseStore } from "./home-release-store.js";
import { parseLauncherHome, bootstrapFromInstalledSeed, runRuntimeLauncher } from "./runtime-launcher.js";
import { SharedReleaseStore } from "./shared-release-store.js";
import { currentNodeRuntimeRef } from "./release-ref.js";

const tempDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-launcher-"));
  tempDirectories.push(root);
  return root;
}

function createSeed(root: string, version = "1.0.0"): string {
  const seed = path.join(root, "seed");
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
      "fs.writeFileSync(process.env.NIUBOT_TEST_LAUNCH_MARKER, JSON.stringify({ args: process.argv.slice(2), home: process.env.NIUBOT_HOME }));",
      "",
    ].join("\n"));
  }
  return seed;
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

  it("bootstraps an installed seed into the shared store", async () => {
    const root = temporaryRoot();
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    const shared = new SharedReleaseStore(path.join(root, "shared"));
    const store = new HomeReleaseStore(home, shared);
    const state = await bootstrapFromInstalledSeed({
      homeStore: store,
      seedRoot: createSeed(root),
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
      verify: () => undefined,
    });
    expect(state.current).toMatchObject({ storage: "shared" });
    expect(state.lastKnownGood).toBeUndefined();
    expect(shared.readAllHomeRefs()[0]?.pending?.protected).toEqual([state.current]);
    expect(shared.readAllHomeRefs()).toHaveLength(1);
  });

  it("protects the seed in pending refs before writing home state", async () => {
    const root = temporaryRoot();
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    const shared = new SharedReleaseStore(path.join(root, "shared"));
    const store = new HomeReleaseStore(home, shared);
    vi.spyOn(store, "writeState").mockImplementation(() => { throw new Error("simulated crash"); });
    await expect(bootstrapFromInstalledSeed({
      homeStore: store,
      seedRoot: createSeed(root),
      env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
      verify: () => undefined,
    })).rejects.toThrow(/simulated crash/);
    const ref = shared.readHomeRef(store.homeId);
    expect(ref?.active).toEqual({});
    expect(ref?.pending?.protected[0]).toMatchObject({ storage: "shared" });
  });

  it("launches the shared CLI selected by the home state", async () => {
    const root = temporaryRoot();
    const home = path.join(root, "home");
    const marker = path.join(root, "launched.json");
    fs.mkdirSync(home);
    const code = await runRuntimeLauncher({
      command: "nbt",
      argv: ["task", "list", "--home", home],
      seedRoot: createSeed(root),
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

  it("reuses one seed artifact across two homes", async () => {
    const root = temporaryRoot();
    const seed = createSeed(root);
    const shared = new SharedReleaseStore(path.join(root, "shared"));
    for (const name of ["home-a", "home-b"]) {
      const home = path.join(root, name);
      fs.mkdirSync(home);
      await bootstrapFromInstalledSeed({
        homeStore: new HomeReleaseStore(home, shared),
        seedRoot: seed,
        env: { NIUBOT_ALLOW_ROOT_STORE: "1" },
        verify: () => undefined,
      });
    }
    expect(fs.readdirSync(shared.releasesDirectory, { withFileTypes: true }).filter((entry) => entry.isDirectory())).toHaveLength(1);
    expect(shared.readAllHomeRefs()).toHaveLength(2);
  });

  it("recovers from unusable slots by importing the installed seed", async () => {
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
      seedRoot: createSeed(root),
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
    expect((state.current as { artifactId: string }).artifactId).not.toBe("missing");
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
      seedRoot: createSeed(root),
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
    expect(state.lastKnownGood).toMatchObject({ storage: "legacy", runtimePath: fs.realpathSync.native(legacy) });
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
      seedRoot: createSeed(root, "0.2.4"),
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
      seedRoot: seed,
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
});
