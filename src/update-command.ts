import { existsSync, statSync } from "node:fs";
import os from "node:os";

/** 为 npm 更新命令选择不会在迁移中消失的工作目录。 */
export function resolveUpdateCommandCwd(niubotHome: string, fallbackHome = os.homedir()): string {
  const candidates = [niubotHome, fallbackHome];
  try { candidates.push(process.cwd()); } catch { /* current directory may have been deleted */ }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    } catch { /* try the next stable directory */ }
  }
  throw new Error("No existing directory is available for the npm update check");
}
