import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { c as createTar } from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedReleaseInstaller } from "./shared-release-installer.js";
import { SharedReleaseStore } from "./shared-release-store.js";

const tempDirectories: string[] = [];

function temporaryRoot(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

async function createArchive(options: { shrinkwrap?: boolean; version?: string } = {}): Promise<string> {
  const root = temporaryRoot("niubot-installer-source-");
  const packageDirectory = path.join(root, "package");
  fs.mkdirSync(path.join(packageDirectory, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({
    name: "@yuanzhangjing/niubot",
    version: options.version ?? "1.2.3",
  }));
  fs.writeFileSync(path.join(packageDirectory, "dist", "user-cli.js"), "console.log('ok');\n");
  if (options.shrinkwrap !== false) {
    fs.writeFileSync(path.join(packageDirectory, "npm-shrinkwrap.json"), JSON.stringify({ lockfileVersion: 3 }));
  }
  const archive = path.join(root, "package.tgz");
  await createTar({ gzip: true, cwd: root, file: archive }, ["package"]);
  return archive;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("shared release installer", () => {
  it("installs a shrinkwrapped archive with npm ci and reuses it", async () => {
    const root = temporaryRoot("niubot-installer-store-");
    const store = new SharedReleaseStore(root);
    const installer = new SharedReleaseInstaller(store);
    const archive = await createArchive();
    const run = vi.fn(async (_command: string, args: string[], options: { cwd?: string }) => {
      expect(args[0]).toBe("ci");
      fs.mkdirSync(path.join(options.cwd!, "node_modules"));
      return { command: "npm", args, stdout: "", stderr: "", exitCode: 0 };
    });
    const verify = vi.fn();
    const options = {
      archivePath: archive,
      sourceKind: "npm" as const,
      nodePath: process.execPath,
      nodeVersion: process.version,
      nodeAbi: process.versions.modules,
      npmCommand: "npm",
      cwd: root,
      env: {},
      timeoutMs: 10_000,
      run,
      verify,
    };
    const first = await installer.installArchive(options);
    expect(first.reused).toBe(false);
    expect(first.manifest.lockDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);

    const second = await installer.installArchive(options);
    expect(second.artifactId).toBe(first.artifactId);
    expect(second.reused).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);

    fs.writeFileSync(path.join(first.packageDirectory, "dist", "user-cli.js"), "corrupted\n");
    const repaired = await installer.installArchive(options);
    expect(repaired.artifactId).toBe(first.artifactId);
    expect(repaired.reused).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(repaired.packageDirectory, "dist", "user-cli.js"), "utf-8"))
      .toBe("console.log('ok');\n");
  });

  it("rejects archives without npm-shrinkwrap", async () => {
    const root = temporaryRoot("niubot-installer-store-");
    const installer = new SharedReleaseInstaller(new SharedReleaseStore(root));
    await expect(installer.installArchive({
      archivePath: await createArchive({ shrinkwrap: false }),
      sourceKind: "npm",
      nodePath: process.execPath,
      nodeVersion: process.version,
      nodeAbi: process.versions.modules,
      npmCommand: "npm",
      cwd: root,
      env: {},
      timeoutMs: 10_000,
      run: vi.fn(),
      verify: vi.fn(),
    })).rejects.toThrow(/npm-shrinkwrap/);
  });

  it("imports a self-contained installed tree without npm", async () => {
    const root = temporaryRoot("niubot-seed-store-");
    const source = path.join(root, "source");
    fs.mkdirSync(path.join(source, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({
      name: "@yuanzhangjing/niubot",
      version: "1.0.0",
    }));
    fs.writeFileSync(path.join(source, "node_modules", "dep.js"), "dependency\n");
    const run = vi.fn();
    const result = await new SharedReleaseInstaller(new SharedReleaseStore(path.join(root, "store"))).importInstalledTree({
      sourceDirectory: source,
      sourceKind: "seed",
      nodePath: process.execPath,
      nodeVersion: process.version,
      nodeAbi: process.versions.modules,
      cwd: root,
      env: {},
      run,
      verify: vi.fn(),
    });
    expect(result.artifactId).toMatch(/^seed-1\.0\.0-/);
    expect(fs.existsSync(path.join(result.packageDirectory, "node_modules", "dep.js"))).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")("rejects external links in an offline seed", async () => {
    const root = temporaryRoot("niubot-seed-link-");
    const source = path.join(root, "source");
    const outside = path.join(root, "outside.js");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({
      name: "@yuanzhangjing/niubot",
      version: "1.0.0",
    }));
    fs.writeFileSync(outside, "outside\n");
    fs.symlinkSync(outside, path.join(source, "external.js"));
    const installer = new SharedReleaseInstaller(new SharedReleaseStore(path.join(root, "store")));
    await expect(installer.importInstalledTree({
      sourceDirectory: source,
      sourceKind: "seed",
      nodePath: process.execPath,
      nodeVersion: process.version,
      nodeAbi: process.versions.modules,
      cwd: root,
      env: {},
      verify: vi.fn(),
    })).rejects.toThrow(/external symbolic link/);
  });

  it.runIf(process.platform !== "win32")("rewrites absolute internal seed links to the shared tree", async () => {
    const root = temporaryRoot("niubot-seed-internal-link-");
    const source = path.join(root, "source");
    fs.mkdirSync(path.join(source, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({
      name: "@yuanzhangjing/niubot",
      version: "1.0.0",
    }));
    const target = path.join(source, "node_modules", "real.js");
    fs.writeFileSync(target, "inside\n");
    fs.symlinkSync(target, path.join(source, "node_modules", "linked.js"));
    const installer = new SharedReleaseInstaller(new SharedReleaseStore(path.join(root, "store")));
    const result = await installer.importInstalledTree({
      sourceDirectory: source,
      sourceKind: "seed",
      nodePath: process.execPath,
      nodeVersion: process.version,
      nodeAbi: process.versions.modules,
      cwd: root,
      env: {},
      verify: vi.fn(),
    });
    const copiedLink = path.join(result.packageDirectory, "node_modules", "linked.js");
    expect(path.isAbsolute(fs.readlinkSync(copiedLink))).toBe(false);
    expect(fs.realpathSync.native(copiedLink)).toBe(fs.realpathSync.native(path.join(result.packageDirectory, "node_modules", "real.js")));
  });
});
