#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchRestartWorker } from "./restart-launcher.js";
import { runRestartWorker } from "./restart-worker.js";

async function main(): Promise<void> {
  const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const niubotHome = process.env["NIUBOT_HOME"];
  if (!niubotHome) throw new Error("NIUBOT_HOME is not set");

  if (process.argv.includes("--no-detach")) {
    await runRestartWorker();
    return;
  }

  const worker = launchRestartWorker({
    niubotHome,
    botName: process.env["NIUBOT_BOT_NAME"] || "NiuBot",
    runtimeRoot,
    sourceDirectory: process.env["NIUBOT_SOURCE_DIR"] || runtimeRoot,
    runtimeMode: process.env["NIUBOT_RUNTIME_MODE"] || "",
    notifyChatId: process.env["NIUBOT_RESTART_NOTIFY_CHAT_ID"],
    updateVersion: process.env["NIUBOT_UPDATE_VERSION"],
  });
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
