import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveRestartDebugLog } from "./restart-log.js";

export interface RestartWorkerLaunchOptions {
  niubotHome: string;
  botName: string;
  runtimeRoot: string;
  sourceDirectory: string;
  /** One-cycle compatibility for legacy source homes whose package version had no DEV suffix. */
  restartMode?: "source";
  /** dev/production 运行环境；透传给 worker 作为 NIUBOT_ENV（旧版 runtimeMode 透传已废弃） */
  environment?: string;
  /** 本次重启是否自动升级触发；worker 写入 restart/state.json 的 autoUpdate 标记 */
  autoUpdate?: boolean;
  notifyChatId?: string;
  updateVersion?: string;
  recommendedArtifactId?: string;
  recommendedGeneration?: number;
  /** Exact shared artifact selected by Launcher for safe first-start/recovery activation. */
  candidateArtifactId?: string;
  /** Preserve a stopped Engine state after update verification, even if the caller exits. */
  stopAfterCompletion?: boolean;
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
    NIUBOT_ENV: options.environment ?? "",
    NIUBOT_RESTART_NOTIFY_CHAT_ID: options.notifyChatId ?? "",
    NIUBOT_RESTART_ID: options.restartId ?? "",
    NIUBOT_RESTART_STARTED_AT: options.restartStartedAt ?? "",
    NIUBOT_RESTART_WAKE_PROMPT: options.wakePrompt ?? "",
    NIUBOT_AUTO_UPDATE: options.autoUpdate ? "1" : "",
    NIUBOT_RESTART_STOP_AFTER_COMPLETION: options.stopAfterCompletion ? "1" : "",
  };
  delete env["NIUBOT_AGENT_SESSION"];
  if (options.updateVersion) {
    env["NIUBOT_RESTART_MODE"] = "npm-update";
    env["NIUBOT_UPDATE_VERSION"] = options.updateVersion;
    delete env["NIUBOT_RECOMMENDED_ARTIFACT_ID"];
    delete env["NIUBOT_RECOMMENDED_GENERATION"];
    delete env["NIUBOT_CANDIDATE_ARTIFACT_ID"];
  } else if (options.recommendedArtifactId && options.recommendedGeneration) {
    env["NIUBOT_RESTART_MODE"] = "recommended";
    env["NIUBOT_RECOMMENDED_ARTIFACT_ID"] = options.recommendedArtifactId;
    env["NIUBOT_RECOMMENDED_GENERATION"] = String(options.recommendedGeneration);
    delete env["NIUBOT_UPDATE_VERSION"];
    delete env["NIUBOT_CANDIDATE_ARTIFACT_ID"];
  } else if (options.candidateArtifactId) {
    env["NIUBOT_RESTART_MODE"] = "candidate";
    env["NIUBOT_CANDIDATE_ARTIFACT_ID"] = options.candidateArtifactId;
    delete env["NIUBOT_UPDATE_VERSION"];
    delete env["NIUBOT_RECOMMENDED_ARTIFACT_ID"];
    delete env["NIUBOT_RECOMMENDED_GENERATION"];
  } else if (options.restartMode === "source") {
    env["NIUBOT_RESTART_MODE"] = "source";
    delete env["NIUBOT_UPDATE_VERSION"];
    delete env["NIUBOT_RECOMMENDED_ARTIFACT_ID"];
    delete env["NIUBOT_RECOMMENDED_GENERATION"];
    delete env["NIUBOT_CANDIDATE_ARTIFACT_ID"];
  } else {
    delete env["NIUBOT_RESTART_MODE"];
    delete env["NIUBOT_UPDATE_VERSION"];
    delete env["NIUBOT_RECOMMENDED_ARTIFACT_ID"];
    delete env["NIUBOT_RECOMMENDED_GENERATION"];
    delete env["NIUBOT_CANDIDATE_ARTIFACT_ID"];
  }
  delete env["NIUBOT_LAUNCH_CANDIDATE_ARTIFACT_ID"];
  return env;
}

export function launchRestartWorker(options: RestartWorkerLaunchOptions): RestartWorkerLaunch {
  // 允许 Agent 会话内触发重启（/restart 命令或 Agent 直接调用都走同一入口）。
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const workerEntry = path.join(runtimeRoot, "dist", "restart-worker.js");
  if (!fs.existsSync(workerEntry)) throw new Error(`Restart worker not found: ${workerEntry}`);

  const restartId = options.restartId || randomUUID();
  const restartStartedAt = options.restartStartedAt || new Date().toISOString();
  const logFile = resolveRestartDebugLog(options.niubotHome, restartId);
  const stateFile = path.join(
    path.resolve(options.niubotHome),
    options.botName,
    "restart",
    "state.json",
  );
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
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
