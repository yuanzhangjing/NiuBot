import fs from "node:fs";
import path from "node:path";

const RETRYABLE_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const REPLACE_BACKUP_SUFFIX = ".replace-backup";

export function replaceFileSync(
  source: string,
  destination: string,
  attempts = 5,
  platform: NodeJS.Platform = process.platform,
): void {
  recoverFileReplacementSync(destination);
  if (platform === "win32" && fs.existsSync(destination)) {
    replaceWindowsFileSync(source, destination, attempts);
    return;
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (err) {
      lastError = err;
      if (!isRetryableWindowsFileError(err, platform) || attempt === attempts - 1) break;
      blockingDelay(20 * (attempt + 1));
    }
  }
  throw lastError;
}

export function removeFileSync(filePath: string, attempts = 5): boolean {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return false;
      lastError = err;
      if (!isRetryableWindowsFileError(err) || attempt === attempts - 1) break;
      blockingDelay(20 * (attempt + 1));
    }
  }
  throw lastError;
}

export function samePlatformPath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const a = canonicalPath(left);
  const b = canonicalPath(right);
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function replaceWindowsFileSync(source: string, destination: string, attempts: number): void {
  const backup = replacementBackupPath(destination);
  retryRename(destination, backup, attempts, "win32");
  try {
    retryRename(source, destination, attempts, "win32");
  } catch (err) {
    try { retryRename(backup, destination, attempts, "win32"); } catch { /* preserve original error */ }
    throw err;
  }
  try { removeFileSync(backup, attempts); } catch { /* stale backup is recoverable on the next read/write */ }
}

export function recoverFileReplacementSync(destination: string): void {
  const backup = replacementBackupPath(destination);
  if (fs.existsSync(destination)) {
    if (fs.existsSync(backup)) {
      try { removeFileSync(backup); } catch { /* a valid destination already exists */ }
    }
    return;
  }
  if (fs.existsSync(backup)) fs.renameSync(backup, destination);
}

function replacementBackupPath(destination: string): string {
  return `${destination}${REPLACE_BACKUP_SUFFIX}`;
}

function retryRename(source: string, destination: string, attempts: number, platform: NodeJS.Platform): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (err) {
      lastError = err;
      if (!isRetryableWindowsFileError(err, platform) || attempt === attempts - 1) break;
      blockingDelay(20 * (attempt + 1));
    }
  }
  throw lastError;
}

function isRetryableWindowsFileError(err: unknown, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32"
    && err instanceof Error
    && "code" in err
    && RETRYABLE_CODES.has(String((err as NodeJS.ErrnoException).code));
}

function blockingDelay(milliseconds: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function canonicalPath(value: string): string {
  try { return fs.realpathSync.native(value); } catch { return path.resolve(value); }
}
