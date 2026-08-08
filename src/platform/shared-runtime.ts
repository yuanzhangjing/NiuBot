import os from "node:os";
import path from "node:path";

export interface SharedRuntimePathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  localAppData?: string;
  platform?: NodeJS.Platform;
}

/** Resolve the per-OS-user NiuBot program store. */
export function resolveSharedRuntimeRoot(options: SharedRuntimePathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const override = env["NIUBOT_SHARED_STORE"]?.trim();
  if (override) return pathApi.resolve(override);

  const homeDir = options.homeDir ?? os.homedir();
  if (platform === "win32") {
    const localAppData = options.localAppData ?? env["LOCALAPPDATA"] ?? pathApi.join(homeDir, "AppData", "Local");
    return pathApi.join(localAppData, "NiuBot");
  }
  return pathApi.join(homeDir, ".local", "niubot");
}
