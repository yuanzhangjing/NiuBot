import fs from "node:fs";
import path from "node:path";

const RETRYABLE_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

export function replaceFileSync(source: string, destination: string, attempts = 5): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (err) {
      lastError = err;
      if (!isRetryableWindowsFileError(err) || attempt === attempts - 1) break;
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

function isRetryableWindowsFileError(err: unknown): boolean {
  return process.platform === "win32"
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
