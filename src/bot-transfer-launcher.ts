import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireProcessLock } from "./process-lock.js";
import { replaceFileSync } from "./platform/files.js";
import { queryProcessStartMarker } from "./platform/process.js";

export interface TransferRuntimeTarget {
  runtimePath: string;
  nodePath: string;
  version: string;
  runtimeMode?: string;
  sourceDirectory?: string;
  logLevel?: string;
  debugAgentStdout?: string;
}

interface TransferRequestBase {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  runtime: TransferRuntimeTarget;
  notifyChatId?: string;
  notifyBotId?: string;
  notifyHome?: string;
}

export interface ImportTransferRequest extends TransferRequestBase {
  kind: "import";
  home: string;
  bundlePath: string;
  appId?: string;
  appSecret?: string;
  workingDirectory?: string;
}

export interface MoveTransferRequest extends TransferRequestBase {
  kind: "move";
  sourceHome: string;
  targetHome: string;
  botId: string;
  sourceVersion: string;
}

export type BotTransferWorkerRequest = ImportTransferRequest | MoveTransferRequest;

export interface LaunchBotTransferOptions {
  runtimeRoot: string;
  request: Omit<ImportTransferRequest, "schemaVersion" | "id" | "createdAt">
    | Omit<MoveTransferRequest, "schemaVersion" | "id" | "createdAt">;
}

export interface BotTransferWorkerLaunch {
  id: string;
  pid: number;
  stateFile: string;
  logFile: string;
}

export function launchBotTransferWorker(options: LaunchBotTransferOptions): BotTransferWorkerLaunch {
  const id = randomUUID();
  const request = {
    ...options.request,
    schemaVersion: 1,
    id,
    createdAt: new Date().toISOString(),
  } as BotTransferWorkerRequest;
  const homes = request.kind === "import" ? [request.home] : [request.sourceHome, request.targetHome];
  const orderedHomes = [...new Set(homes.map((home) => path.resolve(home)))].sort((a, b) => a.localeCompare(b));
  const primaryHome = request.kind === "import" ? path.resolve(request.home) : path.resolve(request.targetHome);
  const jobDirectory = path.join(primaryHome, "run", "bot-transfer-jobs", id);
  const requestFile = path.join(jobDirectory, "request.json");
  const stateFile = path.join(jobDirectory, "state.json");
  const logFile = path.join(primaryHome, "logs", "bot-transfer.log");
  const releases: Array<() => void> = [];
  const markerFiles: string[] = [];
  const launcherStartMarker = queryProcessStartMarker(process.pid);
  let spawned = false;
  try {
    for (const home of orderedHomes) {
      const runDirectory = path.join(home, "run");
      fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
      releases.push(acquireProcessLock(path.join(runDirectory, "bot-transfer.lock"), "Bot transfer"));
      const activeDirectory = path.join(runDirectory, "bot-transfer-active");
      fs.mkdirSync(activeDirectory, { recursive: true, mode: 0o700 });
      if (fs.readdirSync(activeDirectory).length > 0) {
        throw new Error(`another Bot transfer lifecycle is already active: ${home}`);
      }
      markerFiles.push(path.join(activeDirectory, `${id}.json`));
    }

    fs.mkdirSync(jobDirectory, { recursive: true, mode: 0o700 });
    writePrivateJson(requestFile, request);
    for (const markerFile of markerFiles) {
      writePrivateJson(markerFile, {
        schemaVersion: 1,
        id,
        status: "launching",
        pid: process.pid,
        processStartMarker: launcherStartMarker,
        primaryHome,
        stateFile,
      });
    }
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const logFd = fs.openSync(logFile, "a");
    let child;
    try {
      const workerEntry = path.join(path.resolve(options.runtimeRoot), "dist", "bot-transfer-worker.js");
      if (!fs.existsSync(workerEntry)) throw new Error(`Bot transfer worker not found: ${workerEntry}`);
      child = spawn(process.execPath, [workerEntry], {
        cwd: path.resolve(options.runtimeRoot),
        detached: true,
        windowsHide: true,
        stdio: ["ignore", logFd, logFd],
        env: {
          ...process.env,
          NIUBOT_BOT_TRANSFER_REQUEST: requestFile,
        },
      });
    } finally {
      fs.closeSync(logFd);
    }
    if (!child.pid) throw new Error("Bot transfer worker did not provide a PID");
    const workerStartMarker = queryProcessStartMarker(child.pid);
    for (const markerFile of markerFiles) {
      replacePrivateJson(markerFile, {
        schemaVersion: 1,
        id,
        status: "running",
        pid: child.pid,
        processStartMarker: workerStartMarker,
        primaryHome,
        stateFile,
      });
    }
    child.unref();
    spawned = true;
    return { id, pid: child.pid, stateFile, logFile };
  } finally {
    for (const release of releases.reverse()) release();
    if (!spawned) {
      for (const markerFile of markerFiles) fs.rmSync(markerFile, { force: true });
      fs.rmSync(jobDirectory, { recursive: true, force: true });
    }
  }
}

function writePrivateJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

function replacePrivateJson(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writePrivateJson(temporary, value);
  try { replaceFileSync(temporary, filePath); } finally { fs.rmSync(temporary, { force: true }); }
}
