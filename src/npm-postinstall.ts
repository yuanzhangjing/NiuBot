import os from "node:os";
import { ensureRuntimeCliShims, type RuntimeCliShimResults } from "./platform/cli-runtime.js";

export type NpmPostinstallResult =
  | { status: "skipped"; reason: string }
  | { status: "completed"; shims: RuntimeCliShimResults };

export function runNpmPostinstall(options: {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  execPath?: string;
  platform?: NodeJS.Platform;
}): NpmPostinstallResult {
  const env = options.env ?? process.env;
  if (env["npm_config_global"] !== "true" && env["npm_config_global"] !== "1") {
    return { status: "skipped", reason: "not a global npm install" };
  }
  const platform = options.platform ?? process.platform;
  return {
    status: "completed",
    shims: ensureRuntimeCliShims({
      projectRoot: options.projectRoot,
      homeDir: options.homeDir ?? os.homedir(),
      execPath: options.execPath ?? process.execPath,
      platform,
      localAppData: env["LOCALAPPDATA"],
    }),
  };
}
