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
    expect(() => assertSupportedNodeRuntime("25.9.0")).toThrow(/NiuBotRuntime/);
    expect(() => assertSupportedNodeRuntime("22.14.0")).not.toThrow();
  });
});
