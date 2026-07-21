#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchRestartWorker } from "./restart-launcher.js";
import { runRestartWorker } from "./restart-worker.js";

export function resolveRestartCompatOptions(
  env: NodeJS.ProcessEnv,
  runtimeRoot: string,
) {
  const niubotHome = env["NIUBOT_HOME"];
  if (!niubotHome) throw new Error("NIUBOT_HOME is not set");
  return {
    niubotHome,
    botName: env["NIUBOT_BOT_NAME"] || "NiuBot",
    runtimeRoot,
    sourceDirectory: env["NIUBOT_SOURCE_DIR"] || runtimeRoot,
    runtimeMode: env["NIUBOT_RUNTIME_MODE"] || "",
    // v0.1.12..v0.1.16 only provided NIUBOT_CHAT_ID. Keep the old name so
    // installing a new package before invoking the old /restart still reports
    // the final result to the originating chat.
    notifyChatId: env["NIUBOT_RESTART_NOTIFY_CHAT_ID"] || env["NIUBOT_CHAT_ID"],
    updateVersion: env["NIUBOT_UPDATE_VERSION"],
  };
}

async function main(): Promise<void> {
  const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  if (process.argv.includes("--no-detach")) {
    await runRestartWorker();
    return;
  }

  const worker = launchRestartWorker(resolveRestartCompatOptions(process.env, runtimeRoot));
  process.stdout.write(`restart detached (pid=${worker.pid})\n  debug log: ${worker.logFile}\n`);
}

const entryPath = process.argv[1] && fs.existsSync(process.argv[1])
  ? fs.realpathSync(path.resolve(process.argv[1]))
  : undefined;
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
