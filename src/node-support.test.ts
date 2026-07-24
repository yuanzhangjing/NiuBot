import fs from "node:fs";
import { fileURLToPath } from "node:url";
import yaml from "yaml";
import { describe, expect, it } from "vitest";
import {
  assertSupportedNodeRuntime,
  isSupportedNodeMajor,
  MINIMUM_NODE_MAJOR,
  WINDOWS_TESTED_NODE_MAJORS,
} from "./node-support.js";

describe("Node runtime support", () => {
  it("accepts Node 20+ on Unix and keeps Windows on tested LTS majors", () => {
    expect(MINIMUM_NODE_MAJOR).toBe(20);
    expect(WINDOWS_TESTED_NODE_MAJORS).toEqual([20, 22, 24]);
    expect(isSupportedNodeMajor(20, "darwin")).toBe(true);
    expect(isSupportedNodeMajor(23, "linux")).toBe(true);
    expect(isSupportedNodeMajor(25, "darwin")).toBe(true);
    expect(isSupportedNodeMajor(18, "darwin")).toBe(false);
    expect(isSupportedNodeMajor(20, "win32")).toBe(true);
    expect(isSupportedNodeMajor(22, "win32")).toBe(true);
    expect(isSupportedNodeMajor(24, "win32")).toBe(true);
    expect(isSupportedNodeMajor(23, "win32")).toBe(false);
    expect(isSupportedNodeMajor(25, "win32")).toBe(false);
  });

  it("rejects unsupported runtimes with an actionable error", () => {
    expect(() => assertSupportedNodeRuntime("18.20.8", "darwin")).toThrow(/Node\.js 20 or newer/);
    expect(() => assertSupportedNodeRuntime("25.9.0", "win32")).toThrow(/Node\.js 20, 22, 24/);
    expect(() => assertSupportedNodeRuntime("25.9.0", "darwin")).not.toThrow();
    expect(() => assertSupportedNodeRuntime("25.9.0", "linux")).not.toThrow();
    expect(() => assertSupportedNodeRuntime("22.14.0", "win32")).not.toThrow();
  });

  it("stays aligned with package engines and the Windows CI matrix", () => {
    const packageJson = JSON.parse(fs.readFileSync(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf-8",
    )) as { engines: { node: string } };
    expect(packageJson.engines.node).toBe(`>=${MINIMUM_NODE_MAJOR}`);

    const workflow = yaml.parse(fs.readFileSync(
      fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)),
      "utf-8",
    )) as {
      jobs: {
        test: {
          strategy: {
            matrix: {
              include: Array<{ os: string; node: string }>;
            };
          };
        };
      };
    };
    const windowsMajors = workflow.jobs.test.strategy.matrix.include
      .filter((entry) => entry.os === "windows-latest")
      .map((entry) => Number.parseInt(entry.node, 10))
      .sort((left, right) => left - right);
    expect(windowsMajors).toEqual([...WINDOWS_TESTED_NODE_MAJORS]);
    expect(workflow.jobs.test.strategy.matrix.include).toContainEqual({
      os: "macos-latest",
      node: "25.9.0",
      "run-tests": true,
    });
  });
});
