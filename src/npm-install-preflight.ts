import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand, type CommandResult, type RunCommandOptions } from "./platform/command.js";

type CommandRunner = (
  command: string,
  args: string[],
  options?: Omit<RunCommandOptions, "onOutput">,
) => Promise<CommandResult>;

export interface NpmInstallPreflightOptions {
  npmCommand: string;
  nodePath: string;
  packageName: string;
  packageSpec: string;
  expectedVersion: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  platform?: NodeJS.Platform;
  run?: CommandRunner;
}

export interface VerifyInstalledPackageOptions {
  packageRoot: string;
  nodePath: string;
  packageName: string;
  expectedVersion: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  run?: CommandRunner;
}

/**
 * Install the candidate under a disposable npm prefix and verify both the CLI
 * entry and native dependency before the real global installation is touched.
 */
export async function preflightGlobalNpmInstall(options: NpmInstallPreflightOptions): Promise<void> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-update-preflight-"));
  const prefix = path.join(temporaryRoot, "install");
  try {
    await run(options.npmCommand, [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--no-audit",
      "--no-fund",
      options.packageSpec,
    ], {
      timeoutMs: options.timeoutMs,
      cwd: options.cwd,
      env: options.env,
    });

    await verifyInstalledPackage({
      packageRoot: resolveGlobalPackageRoot(prefix, options.packageName, platform),
      nodePath: options.nodePath,
      packageName: options.packageName,
      expectedVersion: options.expectedVersion,
      cwd: options.cwd,
      env: options.env,
      run,
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export async function verifyInstalledPackage(options: VerifyInstalledPackageOptions): Promise<void> {
  const run = options.run ?? runCommand;
  assertCandidateMetadata(options.packageRoot, options.packageName, options.expectedVersion);
  const cliEntry = path.join(options.packageRoot, "dist", "user-cli.js");
  const cli = await run(options.nodePath, [cliEntry, "version"], {
    timeoutMs: 30_000,
    cwd: options.cwd,
    env: options.env,
  });
  const expectedOutput = `niubot v${options.expectedVersion}`;
  if (cli.stdout.trim() !== expectedOutput) {
    throw new Error(`installed CLI returned ${JSON.stringify(cli.stdout.trim())}; expected ${JSON.stringify(expectedOutput)}`);
  }

  await run(options.nodePath, [
    "-e",
    "const Database=require(process.argv[1]);const db=new Database(':memory:');db.close();",
    path.join(options.packageRoot, "node_modules", "better-sqlite3"),
  ], {
    timeoutMs: 30_000,
    cwd: options.cwd,
    env: options.env,
  });
}

export function resolveGlobalPackageRoot(
  prefix: string,
  packageName: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return platform === "win32"
    ? pathApi.join(prefix, "node_modules", packageName)
    : pathApi.join(prefix, "lib", "node_modules", packageName);
}

function assertCandidateMetadata(packageRoot: string, packageName: string, expectedVersion: string): void {
  let value: { name?: string; version?: string };
  try {
    value = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8")) as {
      name?: string;
      version?: string;
    };
  } catch (err) {
    throw new Error(`candidate package metadata is unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (value.name !== packageName || value.version !== expectedVersion) {
    throw new Error(
      `candidate package mismatch: ${value.name ?? "(missing)"}@${value.version ?? "(missing)"}; `
      + `expected ${packageName}@${expectedVersion}`,
    );
  }
}
