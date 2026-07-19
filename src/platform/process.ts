import { execFileSync } from "node:child_process";
import fs from "node:fs";

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function shouldDetachChildProcessForTree(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32";
}

/**
 * Returns an OS-owned process creation marker for the rare case where the
 * Engine control endpoint is unavailable. The marker is only comparable on
 * the same host and is never used as the normal health signal.
 */
export function queryProcessStartMarker(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      const closingParen = stat.lastIndexOf(")");
      if (closingParen < 0) return undefined;
      // Fields after comm start at field 3. starttime is field 22.
      return stat.slice(closingParen + 2).trim().split(/\s+/)[19];
    }
    if (platform === "darwin") {
      const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        timeout: 5_000,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return output || undefined;
    }
    if (platform === "win32") {
      const script = [
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
        "if ($null -ne $p) { $p.CreationDate.ToUniversalTime().ToString('o') }",
      ].join("; ");
      const output = execFileSync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ], {
        timeout: 10_000,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }).trim();
      return output || undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function forceTerminateProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") {
    execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      timeout: 10_000,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
  }
}

export function terminateSpawnedProcessTree(
  pid: number,
  force: boolean,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    try { execFileSync("taskkill.exe", args, { timeout: 10_000, stdio: "ignore" }); } catch { /* already stopped */ }
    return;
  }
  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already stopped */ }
  }
}

export async function waitForProcessExit(pid: number, timeoutMs: number, intervalMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  return !isProcessAlive(pid);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
