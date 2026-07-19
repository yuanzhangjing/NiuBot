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

export function queryProcessCommandLine(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (platform === "linux") {
      return fs.readFileSync(`/proc/${pid}/cmdline`).toString("utf-8").split("\0").filter(Boolean).join(" ") || undefined;
    }
    if (platform === "darwin") {
      return execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
        timeout: 5_000,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined;
    }
    if (platform === "win32") {
      const script = [
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
        "if ($null -ne $p) { $p.CommandLine }",
      ].join("; ");
      return execFileSync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
      ], {
        timeout: 10_000,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }).trim() || undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Read one environment value from an existing process when the OS exposes it. */
export function queryProcessEnvironmentValue(
  pid: number,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
  try {
    if (platform === "linux") {
      const prefix = `${name}=`;
      const entry = fs.readFileSync(`/proc/${pid}/environ`)
        .toString("utf-8")
        .split("\0")
        .find((item) => item.startsWith(prefix));
      return entry?.slice(prefix.length);
    }
    if (platform === "darwin") {
      const output = execFileSync("ps", ["eww", "-p", String(pid), "-o", "command="], {
        timeout: 5_000,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 4 * 1024 * 1024,
      });
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = output.match(new RegExp(`(?:^|\\s)${escapedName}=(.*?)(?=\\s[A-Za-z_][A-Za-z0-9_]*=|\\s*$)`));
      return match?.[1];
    }
  } catch {
    return undefined;
  }
  // Windows does not expose another process's environment through a stable,
  // supported API. Legacy PID-only state is therefore intentionally not
  // eligible for automatic termination there.
  return undefined;
}

export function waitForProcessStartMarker(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  timeoutMs = 5_000,
  intervalMs = 100,
): string | undefined {
  const deadline = Date.now() + timeoutMs;
  do {
    const marker = queryProcessStartMarker(pid, platform);
    if (marker) return marker;
    if (!isProcessAlive(pid)) return undefined;
    blockingDelay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return queryProcessStartMarker(pid, platform);
}

export function forceTerminateProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") {
    try {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        timeout: 10_000,
        stdio: "ignore",
      });
    } catch {
      // The process may have exited between identity verification and taskkill.
      // Callers verify that it is gone and report a failure if it is still alive.
    }
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

function blockingDelay(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}
