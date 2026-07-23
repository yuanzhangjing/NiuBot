import fs from "node:fs";
import { fileURLToPath } from "node:url";
import yaml from "yaml";
import { describe, expect, it } from "vitest";
import {
  assertSupportedNodeRuntime,
  isSupportedNodeMajor,
  SUPPORTED_NODE_MAJORS,
} from "./node-support.js";

describe("Node runtime support", () => {
  it("matches the LTS majors covered by the install matrix", () => {
    expect(SUPPORTED_NODE_MAJORS).toEqual([20, 22, 24]);
    expect(isSupportedNodeMajor(20)).toBe(true);
    expect(isSupportedNodeMajor(22)).toBe(true);
    expect(isSupportedNodeMajor(24)).toBe(true);
    expect(isSupportedNodeMajor(18)).toBe(false);
    expect(isSupportedNodeMajor(23)).toBe(false);
    expect(isSupportedNodeMajor(25)).toBe(false);
  });

  it("rejects unsupported runtimes with an actionable error", () => {
    expect(() => assertSupportedNodeRuntime("18.20.8")).toThrow(/Unsupported Node\.js v18\.20\.8/);
    expect(() => assertSupportedNodeRuntime("25.9.0")).toThrow(/that Node installation's npm/);
    expect(() => assertSupportedNodeRuntime("22.14.0")).not.toThrow();
  });

  it("stays aligned with package engines and the Windows CI matrix", () => {
    const packageJson = JSON.parse(fs.readFileSync(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf-8",
    )) as { engines: { node: string } };
    expect(packageJson.engines.node).toBe(
      SUPPORTED_NODE_MAJORS.map((major) => `${major}.x`).join(" || "),
    );

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
    expect(windowsMajors).toEqual([...SUPPORTED_NODE_MAJORS]);
  });
});
