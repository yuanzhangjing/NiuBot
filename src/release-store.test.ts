import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReleaseStore } from "./release-store.js";

const tempDirs: string[] = [];

function createStore(): ReleaseStore {
  const botDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-releases-"));
  tempDirs.push(botDirectory);
  return new ReleaseStore(botDirectory);
}

function createRelease(store: ReleaseStore, id: string, version = "1.0.0"): void {
  const directory = store.packageDirectory(id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
    name: "@yuanzhangjing/niubot",
    version,
  }));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("release store", () => {
  it("activates a candidate and only marks it good after health succeeds", () => {
    const store = createStore();
    createRelease(store, "old");
    createRelease(store, "candidate", "1.1.0");
    store.writeState({ schemaVersion: 1, current: "old", lastKnownGood: "old" });

    expect(store.activate("candidate")).toEqual({
      schemaVersion: 1,
      current: "candidate",
      previous: "old",
      lastKnownGood: "old",
    });
    expect(store.markLastKnownGood("candidate").lastKnownGood).toBe("candidate");
  });

  it("migrates legacy symlinks only when targets are valid releases", () => {
    const store = createStore();
    createRelease(store, "release-a");
    const type = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(store.releaseDirectory("release-a"), path.join(store.botDirectory, "current"), type);
    fs.symlinkSync(path.dirname(store.botDirectory), path.join(store.botDirectory, "previous"), type);

    expect(store.migrateLegacyLinks()).toEqual({
      schemaVersion: 1,
      current: "release-a",
      previous: undefined,
      lastKnownGood: undefined,
    });
  });

  it("protects current, previous, LKG, and active runtime releases during cleanup", () => {
    const store = createStore();
    for (const id of ["01", "02", "03", "04", "05", "06", "07"]) createRelease(store, id);
    store.writeState({ schemaVersion: 1, current: "07", previous: "06", lastKnownGood: "05" });

    store.cleanup({ protectedRuntimePaths: [store.packageDirectory("01")], keepRecent: 1 });

    expect(fs.existsSync(store.releaseDirectory("07"))).toBe(true);
    expect(fs.existsSync(store.releaseDirectory("06"))).toBe(true);
    expect(fs.existsSync(store.releaseDirectory("05"))).toBe(true);
    expect(fs.existsSync(store.releaseDirectory("04"))).toBe(true);
    expect(fs.existsSync(store.releaseDirectory("01"))).toBe(true);
    expect(fs.existsSync(store.releaseDirectory("03"))).toBe(false);
    expect(fs.existsSync(store.releaseDirectory("02"))).toBe(false);
  });

  it("refuses path traversal release ids", () => {
    const store = createStore();
    expect(() => store.releaseDirectory("../outside")).toThrow(/Invalid release id/);
  });

  it("only derives release ids from runtime paths inside this store", () => {
    const store = createStore();
    createRelease(store, "release-a");
    expect(store.releaseIdForRuntimePath(store.packageDirectory("release-a"))).toBe("release-a");
    expect(store.releaseIdForRuntimePath(path.join(path.dirname(store.botDirectory), "outside", "package"))).toBeUndefined();
    if (process.platform === "win32") {
      expect(store.releaseIdForRuntimePath("Z:\\unrelated\\releases\\release-a\\package")).toBeUndefined();
    }
  });
});
