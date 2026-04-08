import path from "node:path";
import { fileURLToPath } from "node:url";

export function getProjectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function getBundledNiubotBinDir(): string {
  return path.join(getProjectRoot(), "bin");
}

export function prependNiubotBinToPath(currentPath = process.env["PATH"] ?? ""): string {
  const niubotBinDir = getBundledNiubotBinDir();
  const entries = currentPath.split(path.delimiter).filter(Boolean);
  if (entries.includes(niubotBinDir)) return currentPath;
  return [niubotBinDir, ...entries].join(path.delimiter);
}
