import { describe, expect, it, vi } from "vitest";
import {
  probeAllBackendCapabilities,
  probeAllBackendCapabilitiesAsync,
  probeBackendCapability,
  probeBackendCapabilityAsync,
} from "./backend-capability.js";

describe("backend capability", () => {
  it("probes installed backends concurrently", async () => {
    let active = 0;
    let peak = 0;
    const capabilities = await probeAllBackendCapabilitiesAsync({
      platform: "linux",
      resolveCommand: (command) => `/bin/${command}`,
      runVersionAsync: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return "1.2.3";
      },
    });

    expect(capabilities.every((capability) => capability.selectable)).toBe(true);
    expect(peak).toBeGreaterThan(1);
  });

  it("can discover installed backends without running version commands", async () => {
    const runVersionAsync = vi.fn(async () => "1.2.3");
    const capabilities = await probeAllBackendCapabilitiesAsync({
      platform: "win32",
      resolveCommand: (command) => `C:\\bin\\${command}.cmd`,
      runVersionAsync,
      verifyVersion: false,
    });

    expect(runVersionAsync).not.toHaveBeenCalled();
    const codex = capabilities.find((capability) => capability.backend === "codex");
    expect(codex).toMatchObject({
      installed: true,
      selectable: true,
    });
    expect(codex).not.toHaveProperty("version");
  });

  it("marks an installed native backend selectable", () => {
    const capability = probeBackendCapability("codex", {
      platform: "win32",
      resolveCommand: () => "C:\\bin\\codex.cmd",
      runVersion: () => "codex-cli 1.2.3",
    });
    expect(capability).toMatchObject({
      backend: "codex",
      installed: true,
      selectable: true,
      version: "1.2.3",
    });
  });

  it("treats current Claude Code as native on Windows", () => {
    expect(probeBackendCapability("claude", {
      platform: "win32",
      resolveCommand: () => "C:\\bin\\claude.exe",
      runVersion: () => "2.1.0",
    })).toMatchObject({ installed: true, selectable: true });
  });

  it("allows every installed backend on native Windows when its version command works", () => {
    const resolveCommand = vi.fn((command: string) => `C:\\bin\\${command}.cmd`);
    const runVersion = vi.fn(() => "1.2.3");
    for (const backend of ["cursor", "pi", "traecli"]) {
      expect(probeBackendCapability(backend, {
        platform: "win32",
        resolveCommand,
        runVersion,
      })).toMatchObject({ installed: true, selectable: true, version: "1.2.3" });
    }
    expect(runVersion).toHaveBeenCalledTimes(3);
  });

  it("allows every discovered backend on native Windows without a version probe", async () => {
    const runVersionAsync = vi.fn(async () => "1.2.3");
    const capabilities = await probeAllBackendCapabilitiesAsync({
      platform: "win32",
      resolveCommand: (command) => `C:\\bin\\${command}.cmd`,
      runVersionAsync,
      verifyVersion: false,
    });

    expect(capabilities).toHaveLength(6);
    expect(capabilities.every((capability) => capability.installed && capability.selectable)).toBe(true);
    expect(runVersionAsync).not.toHaveBeenCalled();
  });

  it("reports the real Windows version-probe error when verification is requested", async () => {
    const capability = await probeBackendCapabilityAsync("traecli", {
      platform: "win32",
      resolveCommand: () => "C:\\bin\\traecli.cmd",
      runVersionAsync: async () => {
        throw new Error("runtime initialization failed");
      },
    });

    expect(capability).toMatchObject({
      installed: true,
      selectable: false,
      reason: "CLI version probe failed: runtime initialization failed",
    });
  });

  it("keeps all installed backends selectable on macOS and Linux", () => {
    const capabilities = probeAllBackendCapabilities({
      platform: "darwin",
      resolveCommand: (_command, options) => `${options.platform === "darwin" ? "/opt/bin" : "/bin"}/agent`,
      runVersion: () => "1.0.0",
    });
    expect(capabilities.every((capability) => capability.selectable)).toBe(true);
  });

  it("reports missing CLIs without running a version probe", () => {
    const runVersion = vi.fn(() => "1.0.0");
    expect(probeBackendCapability("traecli", {
      platform: "linux",
      resolveCommand: () => undefined,
      runVersion,
    })).toMatchObject({ installed: false, selectable: false, reason: "traecli CLI not found" });
    expect(runVersion).not.toHaveBeenCalled();
  });
});
