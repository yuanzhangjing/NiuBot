import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const npmEntry = process.env.npm_execpath;
if (!npmEntry) throw new Error("npm_execpath is not set; run this check through npm run pack:smoke");

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-package-smoke-"));
const packageDirectory = path.join(temporaryRoot, "package");
const installPrefix = path.join(temporaryRoot, "install");
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
    shell: process.platform === "win32",
    windowsHide: true,
  });
  const expected = `niubot v${packageJson.version}`;
  if (output.trim() !== expected) {
    throw new Error(`Installed command returned ${JSON.stringify(output.trim())}; expected ${JSON.stringify(expected)}`);
  }

  const guideOutput = execFileSync(cliPath, ["install-guide"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  if (!guideOutput.startsWith("# NiuBot Installation Guide")) {
    throw new Error("Installed command could not read the packaged installation guide");
  }

  console.log(`Package smoke passed: ${expected}`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
