#!/usr/bin/env node

import { runRuntimeLauncher } from "./runtime-launcher.js";

runRuntimeLauncher({ command: "nbt" }).then(
  (code) => { process.exitCode = code; },
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
