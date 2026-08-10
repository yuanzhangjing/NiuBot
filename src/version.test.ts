import { describe, expect, it } from "vitest";
import {
  comparePackageVersions,
  devVersionParts,
  isDevVersion,
  isNewerPackageVersion,
  isProductionVersion,
  runtimeEnvironmentForVersion,
} from "./version.js";

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

describe("runtime version channels", () => {
  it("accepts only exact stable SemVer as production", () => {
    expect(isProductionVersion("0.2.10")).toBe(true);
    for (const value of ["v0.2.10", "0.2.10+build", "0.2.10-dev.1", "0.2", "01.2.3"]) {
      expect(isProductionVersion(value)).toBe(false);
    }
  });

  it("accepts only numbered dev prereleases", () => {
    expect(isDevVersion("0.2.10-dev.1")).toBe(true);
    expect(isDevVersion("0.2.10-dev.12")).toBe(true);
    for (const value of ["0.2.10-dev", "0.2.10-dev.0", "0.2.10-dev.01", "0.2.10-beta.1", "v0.2.10-dev.1"]) {
      expect(isDevVersion(value)).toBe(false);
    }
    expect(devVersionParts("0.2.10-dev.12")).toEqual({ baseVersion: "0.2.10", sequence: 12 });
  });

  it("derives the environment only from the exact version channel", () => {
    expect(runtimeEnvironmentForVersion("1.2.3")).toBe("production");
    expect(runtimeEnvironmentForVersion("1.2.3-dev.4")).toBe("dev");
    expect(runtimeEnvironmentForVersion("1.2.3-beta.1")).toBeUndefined();
  });
});
