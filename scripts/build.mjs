import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
rmSync(path.join(projectRoot, "dist"), { recursive: true, force: true });

const tscEntry = require.resolve("typescript/bin/tsc");
const result = spawnSync(process.execPath, [tscEntry, "-p", path.join(projectRoot, "tsconfig.json")], {
  cwd: projectRoot,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
