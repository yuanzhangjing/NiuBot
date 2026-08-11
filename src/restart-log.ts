import fs from "node:fs";
import path from "node:path";

export function resolveRestartDebugLog(niubotHome: string, restartId: string): string {
  const safeId = restartId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown";
  return path.join(path.resolve(niubotHome), "logs", "restarts", `${safeId}.log`);
}

export function beginRestartDebugLog(logFile: string, restartId: string, now = new Date()): void {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `\n[${now.toISOString()}] restart ${restartId}\n`);
}
