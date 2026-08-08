import path from "node:path";
import { t as listTar } from "tar";

const REQUIRED_PACKAGE_ENTRIES = new Set([
  "package/package.json",
  "package/npm-shrinkwrap.json",
]);

/** Verify the minimum archive contract required by SharedReleaseInstaller. */
export async function assertInstallablePackageArchive(archivePath: string): Promise<void> {
  const found = new Set<string>();
  await listTar({
    file: archivePath,
    onReadEntry(entry) {
      const normalized = entry.path.replace(/^\.\//, "").split(path.sep).join("/");
      if (REQUIRED_PACKAGE_ENTRIES.has(normalized)) found.add(normalized);
    },
  });
  const missing = [...REQUIRED_PACKAGE_ENTRIES].filter((entry) => !found.has(entry));
  if (missing.length > 0) {
    throw new Error(`Cached package archive is incomplete: missing ${missing.join(", ")}`);
  }
}
