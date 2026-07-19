import { spawn } from "node:child_process";
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
}

export interface RestartWorkerLaunch {
  pid: number;
  logFile: string;
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
  if (process.env["NIUBOT_AGENT_SESSION"]) {
    throw new Error("Cannot restart from within an agent session");
  }
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const workerEntry = path.join(runtimeRoot, "dist", "restart-worker.js");
  if (!fs.existsSync(workerEntry)) throw new Error(`Restart worker not found: ${workerEntry}`);

  const logDirectory = path.join(path.resolve(options.niubotHome), "logs");
  const logFile = path.join(logDirectory, "restart-debug.log");
  fs.mkdirSync(logDirectory, { recursive: true });
  const logFd = fs.openSync(logFile, "a");
  let child;
  try {
    child = spawn(process.execPath, [workerEntry], {
      cwd: runtimeRoot,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      env: buildRestartWorkerEnvironment(options),
    });
  } finally {
    fs.closeSync(logFd);
  }
  child.once("error", (err) => {
    try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] restart worker spawn failed: ${err.message}\n`); } catch { /* ignore */ }
  });
  if (!child.pid) throw new Error("Restart worker did not provide a PID");
  child.unref();
  return { pid: child.pid, logFile };
}
