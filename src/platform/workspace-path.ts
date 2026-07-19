import fs from "node:fs";
import path from "node:path";

export function resolveWorkspacePath(workingDirectory: string): string {
  const resolved = path.resolve(workingDirectory);
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}

/** Matches Claude Code's filesystem-safe project directory naming. */
export function claudeProjectKey(workingDirectory: string): string {
  return resolveWorkspacePath(workingDirectory).replace(/[/\\_:]/g, "-");
}

/** Matches Cursor Agent's project slug and removes Windows drive separators. */
export function cursorProjectKey(workingDirectory: string): string {
  return resolveWorkspacePath(workingDirectory)
    .replace(/^[/\\]+/, "")
    .replace(/[:/\\]+/g, "-");
}
