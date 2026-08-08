#!/usr/bin/env node

import { runRuntimeLauncher } from "./runtime-launcher.js";

const internalNbt = process.argv[2] === "__nbt";
runRuntimeLauncher({
  command: internalNbt ? "nbt" : "niubot",
  argv: internalNbt ? process.argv.slice(3) : undefined,
}).then(
  (code) => { process.exitCode = code; },
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
