import { spawn, spawnSync } from "node:child_process";
import { buildExecutableInvocation, resolveExecutable } from "./executable.js";
import { shouldDetachChildProcessForTree, terminateSpawnedProcessTree } from "./process.js";

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
  /** 用平台 shell 执行整条命令字符串（Unix: /bin/sh -c；Windows: cmd.exe /d /s /c）。默认直接执行命令。 */
  shell?: boolean;
  /** 非零退出码不抛错，通过 result.exitCode 返回（默认 true 抛错）。 */
  throwOnNonZero?: boolean;
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
  const throwOnNonZero = options.throwOnNonZero !== false;
  const { executable, args: invocationArgs, windowsVerbatimArguments } = buildCommandInvocation(command, args, options, env);

  return new Promise((resolve, reject) => {
    const child = spawn(executable, invocationArgs, {
      cwd: options.cwd,
      env,
      detached: shouldDetachChildProcessForTree(),
      windowsHide: true,
      windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputLimitExceeded = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const timer = options.timeoutMs
        ? setTimeout(() => {
          timedOut = true;
          // Windows has no dependable SIGTERM equivalent for a detached-less
          // console process tree. Once the command deadline is exceeded, use
          // taskkill /F immediately instead of waiting for a grace period that
          // the child cannot observe.
          if (child.pid) terminateSpawnedProcessTree(child.pid, process.platform === "win32");
          forceTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null && child.pid) {
              terminateSpawnedProcessTree(child.pid, true);
            }
          }, 5_000);
          forceTimer.unref();
        }, options.timeoutMs)
      : undefined;
    timer?.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      options.onOutput?.("stdout", text);
      enforceOutputLimit();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      options.onOutput?.("stderr", text);
      enforceOutputLimit();
    });
    const enforceOutputLimit = () => {
      if (!options.maxOutputBytes || outputLimitExceeded) return;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) <= options.maxOutputBytes) return;
      outputLimitExceeded = true;
      if (child.pid) terminateSpawnedProcessTree(child.pid, true);
    };
    child.once("error", (err) => {
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      reject(err);
    });
    child.once("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      const exitCode = code ?? (signal ? 1 : 0);
      const result: CommandResult = { command: executable, args: invocationArgs, stdout, stderr, exitCode };
      if (timedOut) {
        reject(commandError(`Command timed out after ${options.timeoutMs}ms`, result));
      } else if (outputLimitExceeded) {
        reject(commandError(`Command output exceeded ${options.maxOutputBytes} bytes`, result));
      } else if (throwOnNonZero && exitCode !== 0) {
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
  const throwOnNonZero = options.throwOnNonZero !== false;
  const { executable, args: invocationArgs, windowsVerbatimArguments } = buildCommandInvocation(command, args, options, env);
  const result = spawnSync(executable, invocationArgs, {
    cwd: options.cwd,
    env,
    timeout: options.timeoutMs,
    windowsHide: true,
    windowsVerbatimArguments,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const commandResult: CommandResult = {
    command: executable,
    args: invocationArgs,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
  if (result.error) throw commandError(result.error.message, commandResult);
  if (throwOnNonZero && commandResult.exitCode !== 0) {
    throw commandError(`Command exited with code ${commandResult.exitCode}`, commandResult);
  }
  return commandResult;
}

/** 统一解析命令 → 可执行入口 + 参数。shell 模式用平台 shell 执行整条命令字符串。 */
function buildCommandInvocation(
  command: string,
  args: string[],
  options: Pick<RunCommandOptions, "cwd" | "env" | "shell">,
  env: NodeJS.ProcessEnv,
): { executable: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (options.shell === true) {
    const shell = process.platform === "win32"
      ? env["COMSPEC"] || "cmd.exe"
      : "/bin/sh";
    const executable = resolveExecutable(shell, { env, cwd: options.cwd }) ?? shell;
    const script = [command, ...args].join(" ");
    return process.platform === "win32"
      ? { executable, args: ["/d", "/s", "/c", `"${script}"`], windowsVerbatimArguments: true }
      : { executable, args: ["-c", script] };
  }
  const executable = resolveExecutable(command, { env, cwd: options.cwd });
  if (!executable) throw new Error(`Command not found: ${command}`);
  const invocation = buildExecutableInvocation(executable, args, { env });
  return {
    executable: invocation.command,
    args: invocation.args,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  };
}

function commandError(message: string, result: CommandResult): Error & { result: CommandResult } {
  const detail = (result.stderr || result.stdout).trim().slice(-2_000);
  const err = new Error(`${message}: ${result.command} ${result.args.join(" ")}${detail ? `\n${detail}` : ""}`) as Error & { result: CommandResult };
  err.result = result;
  return err;
}
