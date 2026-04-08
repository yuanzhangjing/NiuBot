import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.resolve(moduleDir, "..", "AGENTS.template.md");

export function loadStaticContextTemplate(): string {
  return fs.readFileSync(templatePath, "utf-8");
}
