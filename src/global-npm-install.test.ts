import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GlobalInstallError,
  resolveGlobalCommandPaths,
  resolveGlobalPackageLockPath,
  resolvePrimaryGlobalCommand,
  runRecoverableGlobalInstall,
} from "./global-npm-install.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("recoverable global npm install", () => {
  it("keeps a verified installation and removes its backup", async () => {
    const fixture = createFixture();

    const result = await runRecoverableGlobalInstall({
      packageRoot: fixture.packageRoot,
      npmPrefix: fixture.prefix,
      commandName: "niubot",
      platform: "linux",
      install: () => {
        expect(fs.existsSync(fixture.commandPath)).toBe(false);
        writeInstallation(fixture, "2.0.0");
      },
      verify: () => expect(readVersion(fixture.packageRoot)).toBe("2.0.0"),
    });

    expect(result.cleanupWarning).toBeUndefined();
    expect(readVersion(fixture.packageRoot)).toBe("2.0.0");
    expect(fs.readFileSync(fixture.commandPath, "utf-8")).toBe("shim-2.0.0");
    expect(fs.readFileSync(fixture.packageLockPath, "utf-8")).toBe("lock-2.0.0");
    expect(fs.existsSync(path.join(fixture.prefix, ".niubot-update-backups"))).toBe(false);
  });

  it("restores the previous package and command after install failure", async () => {
    const fixture = createFixture();

    let thrown: unknown;
    try {
      await runRecoverableGlobalInstall({
        packageRoot: fixture.packageRoot,
        npmPrefix: fixture.prefix,
        commandName: "niubot",
        platform: "linux",
        install: () => {
          fs.rmSync(fixture.packageRoot, { recursive: true, force: true });
          fs.rmSync(fixture.commandPath, { force: true });
          fs.writeFileSync(fixture.packageLockPath, "lock-broken");
          throw new Error("simulated npm failure");
        },
        verify: () => {
          throw new Error("must not verify");
        },
        verifyRollback: () => {
          expect(readVersion(fixture.packageRoot)).toBe("1.0.0");
          expect(fs.readFileSync(fixture.commandPath, "utf-8")).toBe("shim-1.0.0");
          expect(fs.readFileSync(fixture.packageLockPath, "utf-8")).toBe("lock-1.0.0");
        },
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(GlobalInstallError);
    expect((thrown as GlobalInstallError).restored).toBe(true);
    expect((thrown as Error).message).toMatch(/previous installation was restored/);
    expect(readVersion(fixture.packageRoot)).toBe("1.0.0");
    expect(fs.readFileSync(fixture.commandPath, "utf-8")).toBe("shim-1.0.0");
    expect(fs.readFileSync(fixture.packageLockPath, "utf-8")).toBe("lock-1.0.0");
    expect(fs.existsSync(path.join(fixture.prefix, ".niubot-update-backups"))).toBe(false);
  });

  it("restores the previous installation when post-install verification fails", async () => {
    const fixture = createFixture();

    await expect(runRecoverableGlobalInstall({
      packageRoot: fixture.packageRoot,
      npmPrefix: fixture.prefix,
      commandName: "niubot",
      platform: "linux",
      install: () => writeInstallation(fixture, "2.0.0"),
      verify: () => {
        throw new Error("native module did not load");
      },
      verifyRollback: () => expect(readVersion(fixture.packageRoot)).toBe("1.0.0"),
    })).rejects.toThrow(/previous installation was restored/);

    expect(readVersion(fixture.packageRoot)).toBe("1.0.0");
    expect(fs.readFileSync(fixture.commandPath, "utf-8")).toBe("shim-1.0.0");
  });

  it("uses the standard npm command paths on Windows and POSIX", () => {
    expect(resolveGlobalCommandPaths("C:\\Users\\Admin\\AppData\\Roaming\\npm", "niubot", "win32")).toEqual([
      "C:\\Users\\Admin\\AppData\\Roaming\\npm\\niubot",
      "C:\\Users\\Admin\\AppData\\Roaming\\npm\\niubot.cmd",
      "C:\\Users\\Admin\\AppData\\Roaming\\npm\\niubot.ps1",
    ]);
    expect(resolvePrimaryGlobalCommand("C:\\Users\\Admin\\AppData\\Roaming\\npm", "niubot", "win32"))
      .toBe("C:\\Users\\Admin\\AppData\\Roaming\\npm\\niubot.cmd");
    expect(resolveGlobalCommandPaths("/usr/local", "niubot", "linux"))
      .toEqual(["/usr/local/bin/niubot"]);
    expect(resolveGlobalPackageLockPath(
      "C:\\Users\\Admin\\AppData\\Roaming\\npm\\node_modules\\@yuanzhangjing\\niubot",
      "win32",
    )).toBe("C:\\Users\\Admin\\AppData\\Roaming\\npm\\node_modules\\.package-lock.json");
    expect(resolveGlobalPackageLockPath(
      "/usr/local/lib/node_modules/@yuanzhangjing/niubot",
      "linux",
    )).toBe("/usr/local/lib/node_modules/.package-lock.json");
  });

  it.skipIf(process.platform === "win32")("restores a relative npm symlink without dereferencing it", async () => {
    const fixture = createFixture();
    const target = path.join(fixture.packageRoot, "dist", "user-cli.js");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "old-cli");
    fs.rmSync(fixture.commandPath, { force: true });
    const linkTarget = path.relative(path.dirname(fixture.commandPath), target);
    fs.symlinkSync(linkTarget, fixture.commandPath);

    await expect(runRecoverableGlobalInstall({
      packageRoot: fixture.packageRoot,
      npmPrefix: fixture.prefix,
      commandName: "niubot",
      platform: "linux",
      install: () => {
        fs.rmSync(fixture.packageRoot, { recursive: true, force: true });
        fs.rmSync(fixture.commandPath, { force: true });
        throw new Error("simulated npm failure");
      },
      verify: () => {
        throw new Error("must not verify");
      },
    })).rejects.toThrow(/previous installation was restored/);

    expect(fs.readlinkSync(fixture.commandPath)).toBe(linkTarget);
    expect(fs.readFileSync(fixture.commandPath, "utf-8")).toBe("old-cli");
  });

  it("refuses to touch a package outside the selected npm prefix", async () => {
    const fixture = createFixture();
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-other-package-"));
    temporaryRoots.push(otherRoot);

    await expect(runRecoverableGlobalInstall({
      packageRoot: otherRoot,
      npmPrefix: fixture.prefix,
      commandName: "niubot",
      platform: "linux",
      install: () => {
        throw new Error("must not install");
      },
      verify: () => {
        throw new Error("must not verify");
      },
    })).rejects.toThrow(/outside npm prefix/);
  });
});

function createFixture(): {
  root: string;
  prefix: string;
  packageRoot: string;
  commandPath: string;
  packageLockPath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-global-install-"));
  temporaryRoots.push(root);
  const prefix = path.join(root, "prefix");
  const packageRoot = path.join(prefix, "lib", "node_modules", "@yuanzhangjing", "niubot");
  const commandPath = path.join(prefix, "bin", "niubot");
  const packageLockPath = path.join(prefix, "lib", "node_modules", ".package-lock.json");
  const fixture = { root, prefix, packageRoot, commandPath, packageLockPath };
  writeInstallation(fixture, "1.0.0");
  return fixture;
}

function writeInstallation(
  fixture: { packageRoot: string; commandPath: string; packageLockPath: string },
  version: string,
): void {
  fs.rmSync(fixture.packageRoot, { recursive: true, force: true });
  fs.mkdirSync(fixture.packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(fixture.packageRoot, "package.json"),
    JSON.stringify({ name: "@yuanzhangjing/niubot", version }),
  );
  fs.mkdirSync(path.dirname(fixture.commandPath), { recursive: true });
  fs.writeFileSync(fixture.commandPath, `shim-${version}`, { mode: 0o755 });
  fs.writeFileSync(fixture.packageLockPath, `lock-${version}`);
}

function readVersion(packageRoot: string): string {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8")).version;
}
