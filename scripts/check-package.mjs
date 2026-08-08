import { execFileSync } from "node:child_process";

const npmEntry = process.env.npm_execpath;
if (!npmEntry) throw new Error("npm_execpath is not set; run this check through npm run pack:check");
const raw = execFileSync(process.execPath, [npmEntry, "pack", "--json", "--dry-run"], {
  encoding: "utf8",
});

const result = JSON.parse(raw);
const files = result[0]?.files ?? [];
const blocked = files
  .map((file) => file.path)
  .filter((path) => path.endsWith(".map") || path.startsWith("src/"));
const required = [
  "package.json",
  "npm-shrinkwrap.json",
  "dist/niubot-launcher.js",
  "dist/nbt-launcher.js",
  "dist/user-cli.js",
  "dist/cli.js",
];
const packagedPaths = new Set(files.map((file) => file.path));
const missing = required.filter((path) => !packagedPaths.has(path));

if (blocked.length > 0) {
  console.error("Package check failed. Blocked files found:");
  for (const path of blocked) console.error(`- ${path}`);
  process.exit(1);
}

if (missing.length > 0) {
  console.error("Package check failed. Required runtime files are missing:");
  for (const path of missing) console.error(`- ${path}`);
  process.exit(1);
}

console.log(`Package check passed: ${files.length} files, required runtime files present, no .map or src/ files.`);
