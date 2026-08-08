import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { c as createTar } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { assertInstallablePackageArchive } from "./package-archive.js";

const roots: string[] = [];

async function archiveWith(files: string[]): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-package-archive-"));
  roots.push(root);
  const packageDirectory = path.join(root, "package");
  fs.mkdirSync(packageDirectory);
  for (const file of files) fs.writeFileSync(path.join(packageDirectory, file), "{}\n");
  const archive = path.join(root, "package.tgz");
  await createTar({ gzip: true, cwd: root, file: archive }, ["package"]);
  return archive;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("package archive validation", () => {
  it("accepts an archive with package metadata and shrinkwrap", async () => {
    await expect(assertInstallablePackageArchive(await archiveWith([
      "package.json",
      "npm-shrinkwrap.json",
    ]))).resolves.toBeUndefined();
  });

  it("rejects an archive without shrinkwrap", async () => {
    await expect(assertInstallablePackageArchive(await archiveWith([
      "package.json",
    ]))).rejects.toThrow(/npm-shrinkwrap/);
  });
});
