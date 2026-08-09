import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { x as extractTar } from "tar";

const npmEntry = process.env.npm_execpath;
if (!npmEntry) throw new Error("npm_execpath is not set; run this check through npm run pack:smoke");

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-package-smoke-"));
const packageDirectory = path.join(temporaryRoot, "package");
const installPrefix = path.join(temporaryRoot, "install");
const smokeEnv = {
  ...process.env,
  HOME: path.join(temporaryRoot, "user-home"),
  USERPROFILE: path.join(temporaryRoot, "user-home"),
  NIUBOT_HOME: path.join(temporaryRoot, "niubot-home"),
  NIUBOT_SHARED_STORE: path.join(temporaryRoot, "shared-store"),
  NIUBOT_ALLOW_ROOT_STORE: "1",
};
fs.mkdirSync(packageDirectory, { recursive: true });

try {
  const packOutput = execFileSync(process.execPath, [
    npmEntry,
    "pack",
    "--json",
    "--pack-destination",
    packageDirectory,
  ], { encoding: "utf8" });
  const tarballName = JSON.parse(packOutput)[0]?.filename;
  if (!tarballName) throw new Error("npm pack did not return a tarball filename");

  const tarballPath = path.join(packageDirectory, tarballName);
  const archiveInstallRoot = path.join(temporaryRoot, "archive-install");
  fs.mkdirSync(archiveInstallRoot);
  await extractTar({ file: tarballPath, cwd: archiveInstallRoot, strip: 1 });
  execFileSync(process.execPath, [
    npmEntry,
    "ci",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
  ], {
    cwd: archiveInstallRoot,
    env: smokeEnv,
    stdio: "inherit",
  });
  if (!fs.existsSync(path.join(archiveInstallRoot, "node_modules", "better-sqlite3"))) {
    throw new Error("Archive npm ci did not install runtime dependencies");
  }

  execFileSync(process.execPath, [
    npmEntry,
    "install",
    "--global",
    "--prefix",
    installPrefix,
    tarballPath,
  ], { stdio: "inherit" });

  const cliPath = process.platform === "win32"
    ? path.join(installPrefix, "niubot.cmd")
    : path.join(installPrefix, "bin", "niubot");
  if (!fs.existsSync(cliPath)) throw new Error(`Installed niubot command is missing: ${cliPath}`);
  const nbtPath = process.platform === "win32"
    ? path.join(installPrefix, "nbt.cmd")
    : path.join(installPrefix, "bin", "nbt");
  if (!fs.existsSync(nbtPath)) throw new Error(`Installed nbt command is missing: ${nbtPath}`);

  const installedPackageRoot = process.platform === "win32"
    ? path.join(installPrefix, "node_modules", "@yuanzhangjing", "niubot")
    : path.join(installPrefix, "lib", "node_modules", "@yuanzhangjing", "niubot");
  execFileSync(process.execPath, [
    "-e",
    "const Database=require(process.argv[1]);const db=new Database(':memory:');db.close();",
    path.join(installedPackageRoot, "node_modules", "better-sqlite3"),
  ], { stdio: "inherit" });

  const output = execFileSync(cliPath, ["version"], {
    encoding: "utf8",
    env: smokeEnv,
    shell: process.platform === "win32",
    windowsHide: true,
  });
  const expected = `niubot v${packageJson.version}`;
  if (output.trim() !== expected) {
    throw new Error(`Installed command returned ${JSON.stringify(output.trim())}; expected ${JSON.stringify(expected)}`);
  }
  const nbtHelp = execFileSync(nbtPath, ["--help"], {
    encoding: "utf8",
    env: smokeEnv,
    shell: process.platform === "win32",
    windowsHide: true,
  });
  if (!nbtHelp.includes("NiuBot Tool (nbt)")) {
    throw new Error("Installed nbt command did not reach the packaged CLI entry");
  }

  const guideOutput = execFileSync(cliPath, ["install-guide"], {
    encoding: "utf8",
    env: smokeEnv,
    shell: process.platform === "win32",
    windowsHide: true,
  });
  if (!guideOutput.startsWith("# NiuBot Installation Guide")) {
    throw new Error("Installed command could not read the packaged installation guide");
  }

  execFileSync(cliPath, ["version"], {
    encoding: "utf8",
    env: { ...smokeEnv, NIUBOT_HOME: path.join(temporaryRoot, "niubot-home-2") },
    shell: process.platform === "win32",
    windowsHide: true,
  });
  const sharedReleases = fs.readdirSync(path.join(smokeEnv.NIUBOT_SHARED_STORE, "releases"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  const homeRefs = fs.readdirSync(path.join(smokeEnv.NIUBOT_SHARED_STORE, "refs"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  if (sharedReleases.length !== 1 || homeRefs.length !== 2) {
    throw new Error(`Shared bootstrap mismatch: ${sharedReleases.length} releases, ${homeRefs.length} home refs`);
  }

  // Simulate the first Engine boot after an old updater placed the package in
  // a per-home release directory. The built package must adopt that exact
  // runtime automatically without selecting a different installed seed.
  const legacyHome = path.join(temporaryRoot, "legacy-home");
  const legacyRuntime = path.join(legacyHome, "LegacyBot", "releases", `${packageJson.version}-npm`, "package");
  fs.mkdirSync(path.dirname(legacyRuntime), { recursive: true });
  fs.renameSync(archiveInstallRoot, legacyRuntime);
  const legacySharedRoot = path.join(temporaryRoot, "legacy-shared-store");
  const [{ HomeReleaseStore }, { SharedReleaseStore }, { completeRuntimeHomeMigrationAfterStartup }] = await Promise.all([
    import(pathToFileURL(path.join(legacyRuntime, "dist", "home-release-store.js"))),
    import(pathToFileURL(path.join(legacyRuntime, "dist", "shared-release-store.js"))),
    import(pathToFileURL(path.join(legacyRuntime, "dist", "runtime-home-migration.js"))),
  ]);
  const sharedStore = new SharedReleaseStore(legacySharedRoot);
  const homeStore = new HomeReleaseStore(legacyHome, sharedStore);
  const node = {
    nodePath: process.execPath,
    nodeVersion: process.version,
    nodeAbi: process.versions.modules,
  };
  const legacyRef = { storage: "legacy", runtimePath: legacyRuntime, node };
  homeStore.writeState({ schemaVersion: 2, current: legacyRef, lastKnownGood: legacyRef });
  const migration = await completeRuntimeHomeMigrationAfterStartup({
    niubotHome: legacyHome,
    runtimePath: legacyRuntime,
    node,
    sharedStore,
    env: smokeEnv,
    settleMs: 0,
  });
  if (migration?.state.current?.storage !== "shared") {
    throw new Error("Packaged legacy runtime was not migrated to the shared store");
  }
  const migratedManifest = sharedStore.readManifest(migration.state.current.artifactId);
  if (migratedManifest?.version !== packageJson.version || migration.state.lastKnownGood?.storage !== "shared") {
    throw new Error("Packaged legacy migration did not preserve the active version and last-known-good slot");
  }

  console.log(`Package smoke passed: ${expected}; two homes share one artifact; legacy runtime adopted in one start`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
