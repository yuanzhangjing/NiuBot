import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { replaceFileSync } from "./platform/files.js";

/** Keep the flat version file understood by pre-process-state releases. */
export function writeLegacyRuntimeVersion(niubotHome: string, version: string): void {
  const target = path.join(niubotHome, "niubot.version");
  const temporary = path.join(niubotHome, `.niubot.version.${process.pid}.${randomUUID()}.tmp`);
  fs.mkdirSync(niubotHome, { recursive: true });
  try {
    fs.writeFileSync(temporary, version);
    replaceFileSync(temporary, target);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best-effort temporary cleanup.
    }
  }
}
