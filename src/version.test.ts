import { describe, expect, it } from "vitest";
import { comparePackageVersions, isNewerPackageVersion } from "./version.js";

describe("package version comparison", () => {
  it("orders stable numeric versions without lexical mistakes", () => {
    expect(comparePackageVersions("0.1.100", "0.1.99")).toBe(1);
    expect(comparePackageVersions("1.0.0", "1.0.0")).toBe(0);
    expect(isNewerPackageVersion("0.1.99", "0.1.100")).toBe(false);
  });

  it("orders prereleases below their stable version", () => {
    expect(comparePackageVersions("1.0.0-beta.2", "1.0.0-beta.1")).toBe(1);
    expect(comparePackageVersions("1.0.0", "1.0.0-beta.2")).toBe(1);
  });

  it("falls back to inequality for non-SemVer development labels", () => {
    expect(comparePackageVersions("unknown", "1.0.0")).toBeUndefined();
    expect(isNewerPackageVersion("1.0.0", "unknown")).toBe(true);
  });
});
