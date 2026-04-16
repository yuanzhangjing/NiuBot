import { execFileSync } from "node:child_process";

const raw = execFileSync("npm", ["pack", "--json", "--dry-run"], {
  encoding: "utf8",
});

const result = JSON.parse(raw);
const files = result[0]?.files ?? [];
const blocked = files
  .map((file) => file.path)
  .filter((path) => path.endsWith(".map") || path.startsWith("src/"));

if (blocked.length > 0) {
  console.error("Package check failed. Blocked files found:");
  for (const path of blocked) console.error(`- ${path}`);
  process.exit(1);
}

console.log(`Package check passed: ${files.length} files, no .map or src/ files in tarball.`);
