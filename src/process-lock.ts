import fs from "node:fs";
import path from "node:path";
import {
  isProcessAlive,
  processStartMarkersMatch,
  queryProcessStartMarker,
  waitForProcessStartMarker,
} from "./platform/process.js";

interface ProcessLockRecord {
  pid: number;
  processStartMarker?: string;
  createdAt: string;
}

export function acquireProcessLock(lockFile: string, label: string): () => void {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const ownMarker = waitForProcessStartMarker(process.pid);
  const record: ProcessLockRecord = {
    pid: process.pid,
    processStartMarker: ownMarker,
    createdAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf-8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return () => releaseProcessLock(lockFile, record);
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      const owner = readProcessLock(lockFile);
      if (owner && lockOwnerIsAlive(owner)) {
        throw new Error(`${label} is already running (PID ${owner.pid})`);
      }
      try { fs.unlinkSync(lockFile); } catch { /* retry once */ }
    }
  }

  throw new Error(`Could not acquire ${label} lock`);
}

function releaseProcessLock(lockFile: string, expected: ProcessLockRecord): void {
  const current = readProcessLock(lockFile);
  if (!current || current.pid !== expected.pid || current.processStartMarker !== expected.processStartMarker) return;
  try { fs.unlinkSync(lockFile); } catch { /* already removed */ }
}

function readProcessLock(lockFile: string): ProcessLockRecord | undefined {
  try {
    const raw = fs.readFileSync(lockFile, "utf-8").trim();
    // Releases before the shared lock format stored only the restart worker PID.
    const legacyPid = Number.parseInt(raw, 10);
    if (/^[0-9]+$/.test(raw) && Number.isInteger(legacyPid) && legacyPid > 0) {
      return { pid: legacyPid, createdAt: "legacy" };
    }
    const value = JSON.parse(raw) as Partial<ProcessLockRecord>;
    if (!Number.isInteger(value.pid) || value.pid! <= 0 || typeof value.createdAt !== "string") return undefined;
    if (value.processStartMarker !== undefined && typeof value.processStartMarker !== "string") return undefined;
    return value as ProcessLockRecord;
  } catch {
    return undefined;
  }
}

function lockOwnerIsAlive(owner: ProcessLockRecord): boolean {
  if (!isProcessAlive(owner.pid)) return false;
  if (!owner.processStartMarker) return true;
  return processStartMarkersMatch(owner.processStartMarker, queryProcessStartMarker(owner.pid));
}

function isAlreadyExists(err: unknown): boolean {
  return err instanceof Error
    && "code" in err
    && (err as NodeJS.ErrnoException).code === "EEXIST";
}
