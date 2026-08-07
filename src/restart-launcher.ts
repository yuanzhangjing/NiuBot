import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface RestartWorkerLaunchOptions {
  niubotHome: string;
  botName: string;
  runtimeRoot: string;
  sourceDirectory: string;
  runtimeMode?: string;
  notifyChatId?: string;
  updateVersion?: string;
  restartId?: string;
  restartStartedAt?: string;
  /** 重启完成后注入主会话的任务提示（nbt restart --wake）；不设置则只发通知不唤醒 */
  wakePrompt?: string;
}

export interface RestartWorkerLaunch {
  pid: number;
  logFile: string;
  restartId: string;
  stateFile: string;
}

export function buildRestartWorkerEnvironment(
  options: RestartWorkerLaunchOptions,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    NIUBOT_HOME: path.resolve(options.niubotHome),
    NIUBOT_BOT_NAME: options.botName,
    NIUBOT_SOURCE_DIR: path.resolve(options.sourceDirectory),
    NIUBOT_RUNTIME_MODE: options.runtimeMode ?? "",
    NIUBOT_RESTART_NOTIFY_CHAT_ID: options.notifyChatId ?? "",
    NIUBOT_RESTART_ID: options.restartId ?? "",
    NIUBOT_RESTART_STARTED_AT: options.restartStartedAt ?? "",
    NIUBOT_RESTART_WAKE_PROMPT: options.wakePrompt ?? "",
  };
  delete env["NIUBOT_AGENT_SESSION"];
  if (options.updateVersion) {
    env["NIUBOT_RESTART_MODE"] = "npm-update";
    env["NIUBOT_UPDATE_VERSION"] = options.updateVersion;
  } else {
    delete env["NIUBOT_RESTART_MODE"];
    delete env["NIUBOT_UPDATE_VERSION"];
  }
  return env;
}

export function launchRestartWorker(options: RestartWorkerLaunchOptions): RestartWorkerLaunch {
  // 允许 Agent 会话内触发重启（/restart 命令或 Agent 直接调用都走同一入口）。
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const workerEntry = path.join(runtimeRoot, "dist", "restart-worker.js");
  if (!fs.existsSync(workerEntry)) throw new Error(`Restart worker not found: ${workerEntry}`);

  const logDirectory = path.join(path.resolve(options.niubotHome), "logs");
  const logFile = path.join(logDirectory, "restart-debug.log");
  const restartId = options.restartId ?? randomUUID();
  const restartStartedAt = options.restartStartedAt ?? new Date().toISOString();
  const stateFile = path.join(
    path.resolve(options.niubotHome),
    options.botName,
    "restart",
    "state.json",
  );
  fs.mkdirSync(logDirectory, { recursive: true });
  const logFd = fs.openSync(logFile, "a");
  let child;
  try {
    child = spawn(process.execPath, [workerEntry], {
      cwd: runtimeRoot,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      env: buildRestartWorkerEnvironment({
        ...options,
        restartId,
        restartStartedAt,
      }),
    });
  } finally {
    fs.closeSync(logFd);
  }
  child.once("error", (err) => {
    try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] restart worker spawn failed: ${err.message}\n`); } catch { /* ignore */ }
  });
  if (!child.pid) throw new Error("Restart worker did not provide a PID");
  child.unref();
  return { pid: child.pid, logFile, restartId, stateFile };
}
