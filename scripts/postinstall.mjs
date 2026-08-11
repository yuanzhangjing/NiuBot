import path from "node:path";
import { fileURLToPath } from "node:url";

const globalInstall = process.env.npm_config_global === "true" || process.env.npm_config_global === "1";
if (globalInstall) {
  try {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const { runNpmPostinstall } = await import("../dist/npm-postinstall.js");
    const result = runNpmPostinstall({ projectRoot });
    if (result.status === "completed") {
      for (const [command, shim] of Object.entries(result.shims)) {
        if (shim.status === "conflict") {
          console.warn(`[NiuBot] Kept existing ${command} command at ${shim.shimPath}: ${shim.reason}`);
        }
      }
    }
  } catch (error) {
    console.warn(`[NiuBot] Could not refresh the user launcher: ${error instanceof Error ? error.message : String(error)}`);
  }
}
