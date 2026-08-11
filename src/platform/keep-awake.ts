import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { createLogger } from "../logger.js";
import { buildWindowsAdminShellInvocation } from "./admin-shell.js";
import { resolveExecutable } from "./executable.js";

export interface KeepAwakeStatus {
  supported: boolean;
  enabled: boolean;
  platform: NodeJS.Platform;
  method?: string;
}

export interface KeepAwakeInvocation {
  command: string;
  args: string[];
  method: string;
  readyMarker?: string;
}

interface KeepAwakeDependencies {
  spawnProcess: typeof spawn;
  delay: (ms: number) => Promise<void>;
}

const WINDOWS_READY_MARKER = "NIUBOT_KEEP_AWAKE_READY";
const WINDOWS_READY_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 3_000;

const WINDOWS_KEEP_AWAKE_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
public static class NiuBotKeepAwake {
  private const uint ES_CONTINUOUS = 0x80000000;
  private const uint ES_SYSTEM_REQUIRED = 0x00000001;
  private const uint ES_DISPLAY_REQUIRED = 0x00000002;

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint SetThreadExecutionState(uint flags);

  public static void Run() {
    uint flags = ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED;
    if (SetThreadExecutionState(flags) == 0) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    try {
      Console.Out.WriteLine("${WINDOWS_READY_MARKER}");
      Console.Out.Flush();
      Thread.Sleep(Timeout.Infinite);
    } finally {
      SetThreadExecutionState(ES_CONTINUOUS);
    }
  }
}
'@
[NiuBotKeepAwake]::Run()
`.trim();

export function buildKeepAwakeInvocation(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): KeepAwakeInvocation | undefined {
  if (platform === "darwin") {
    return {
      command: resolveExecutable("caffeinate", { platform, env }) ?? "/usr/bin/caffeinate",
      args: ["-d", "-i"],
      method: "caffeinate",
    };
  }
  if (platform === "win32") {
    const invocation = buildWindowsAdminShellInvocation(WINDOWS_KEEP_AWAKE_SCRIPT, { platform, env });
    return {
      ...invocation,
      method: path.win32.basename(invocation.command).replace(/\.exe$/i, ""),
      readyMarker: WINDOWS_READY_MARKER,
    };
  }
  return undefined;
}

/** Engine 级防休眠控制器。子进程退出时，系统会自动释放对应的唤醒断言。 */
export class KeepAwakeController {
  private readonly log = createLogger("keep-awake");
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly dependencies: KeepAwakeDependencies;
  private child?: ChildProcess;
  private method?: string;
  private ready = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    dependencies?: Partial<KeepAwakeDependencies>;
  } = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.dependencies = {
      spawnProcess: spawn,
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...options.dependencies,
    };
  }

  status(): KeepAwakeStatus {
    const supported = this.platform === "darwin" || this.platform === "win32";
    return {
      supported,
      enabled: supported && this.ready && this.child !== undefined && isChildRunning(this.child),
      platform: this.platform,
      method: this.method,
    };
  }

  setEnabled(enabled: boolean): Promise<KeepAwakeStatus> {
    const operation = this.queue.then(() => (enabled ? this.enable() : this.disable()));
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async enable(): Promise<KeepAwakeStatus> {
    if (this.status().enabled) return this.status();
    if (this.child && isChildRunning(this.child)) {
      throw new Error("已有未确认生效的防休眠辅助进程，需先执行 /awake off 将它停止。");
    }
    if (this.child) {
      this.child = undefined;
      this.method = undefined;
      this.ready = false;
    }
    const invocation = buildKeepAwakeInvocation(this.platform, this.env);
    if (!invocation) throw new Error("当前系统不支持内置防休眠；仅支持 macOS 和 Windows。");

    let stderr = "";
    const child = this.dependencies.spawnProcess(invocation.command, invocation.args, {
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.method = invocation.method;
    this.ready = false;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string | Buffer) => {
      if (stderr.length < 4000) stderr += String(chunk);
    });
    child.on("error", (err) => {
      this.log.warn("keep-awake process error", { error: String(err) });
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.method = undefined;
      this.ready = false;
      this.log.warn("keep-awake process exited", { code, signal, stderr: stderr.trim() || undefined });
    });

    try {
      if (invocation.readyMarker) {
        await waitForReadyMarker(child, invocation.readyMarker, WINDOWS_READY_TIMEOUT_MS, () => stderr);
      } else {
        await waitForSpawn(child);
        await this.dependencies.delay(200);
        if (child.exitCode !== null) {
          throw new Error(stderr.trim() || `防休眠进程提前退出（code ${child.exitCode}）`);
        }
      }
      if (this.child !== child || !isChildRunning(child)) {
        throw new Error(stderr.trim() || "防休眠进程在确认生效前退出");
      }
      this.ready = true;
    } catch (err) {
      if (isChildRunning(child)) {
        try {
          await stopChild(child, STOP_TIMEOUT_MS);
        } catch (stopError) {
          throw new AggregateError([err, stopError], "防休眠启动失败，且辅助进程未能停止");
        }
      }
      if (this.child === child) {
        this.child = undefined;
        this.method = undefined;
        this.ready = false;
      }
      throw err;
    }

    this.log.info("keep-awake enabled", { method: invocation.method, pid: child.pid });
    return this.status();
  }

  private async disable(): Promise<KeepAwakeStatus> {
    const child = this.child;
    if (!child || !isChildRunning(child)) {
      if (this.child === child) {
        this.child = undefined;
        this.method = undefined;
        this.ready = false;
      }
      return this.status();
    }

    await stopChild(child, STOP_TIMEOUT_MS);
    if (this.child === child) {
      this.child = undefined;
      this.method = undefined;
      this.ready = false;
    }
    this.log.info("keep-awake disabled");
    return this.status();
  }
}

function waitForReadyMarker(
  child: ChildProcess,
  marker: string,
  timeoutMs: number,
  getStderr: () => string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`防休眠辅助进程启动超时（${timeoutMs}ms）`));
    }, timeoutMs);
    timeout.unref?.();

    const onData = (chunk: string | Buffer) => {
      stdout = (stdout + String(chunk)).slice(-4000);
      if (!stdout.includes(marker)) return;
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(getStderr().trim() || `防休眠进程提前退出（code ${String(code)}）`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function stopChild(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!isChildRunning(child)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`防休眠辅助进程在 ${timeoutMs}ms 内没有退出`));
    }, timeoutMs);
    timeout.unref?.();

    const onExit = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);

    try {
      if (!child.kill()) {
        cleanup();
        reject(new Error("无法停止防休眠辅助进程"));
      }
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}
