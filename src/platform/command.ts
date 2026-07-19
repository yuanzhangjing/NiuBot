import { spawn, spawnSync } from "node:child_process";
import { buildExecutableInvocation, resolveExecutable } from "./executable.js";
import { shouldDetachChildProcessForTree, terminateSpawnedProcessTree } from "./process.js";

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
}

export interface CommandResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const env = { ...process.env, ...options.env };
  const executable = resolveExecutable(command, { env, cwd: options.cwd });
  if (!executable) throw new Error(`Command not found: ${command}`);
  const invocation = buildExecutableInvocation(executable, args, { env });

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env,
      detached: shouldDetachChildProcessForTree(),
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          if (child.pid) terminateSpawnedProcessTree(child.pid, false);
          setTimeout(() => {
            if (child.exitCode === null && child.pid) terminateSpawnedProcessTree(child.pid, true);
          }, 5_000).unref();
        }, options.timeoutMs)
      : undefined;
    timer?.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      options.onOutput?.("stdout", text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      options.onOutput?.("stderr", text);
    });
    child.once("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      const exitCode = code ?? (signal ? 1 : 0);
      const result: CommandResult = { command: executable, args, stdout, stderr, exitCode };
      if (timedOut) {
        reject(commandError(`Command timed out after ${options.timeoutMs}ms`, result));
      } else if (exitCode !== 0) {
        reject(commandError(`Command exited with code ${exitCode}`, result));
      } else {
        resolve(result);
      }
    });
  });
}

export function runCommandSync(
  command: string,
  args: string[],
  options: Omit<RunCommandOptions, "onOutput"> = {},
): CommandResult {
  const env = { ...process.env, ...options.env };
  const executable = resolveExecutable(command, { env, cwd: options.cwd });
  if (!executable) throw new Error(`Command not found: ${command}`);
  const invocation = buildExecutableInvocation(executable, args, { env });
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env,
    timeout: options.timeoutMs,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const commandResult: CommandResult = {
    command: executable,
    args,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
  if (result.error) throw commandError(result.error.message, commandResult);
  if (commandResult.exitCode !== 0) {
    throw commandError(`Command exited with code ${commandResult.exitCode}`, commandResult);
  }
  return commandResult;
}

function commandError(message: string, result: CommandResult): Error & { result: CommandResult } {
  const detail = (result.stderr || result.stdout).trim().slice(-2_000);
  const err = new Error(`${message}: ${result.command} ${result.args.join(" ")}${detail ? `\n${detail}` : ""}`) as Error & { result: CommandResult };
  err.result = result;
  return err;
}
