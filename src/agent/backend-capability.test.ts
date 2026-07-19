import { describe, expect, it, vi } from "vitest";
import { probeAllBackendCapabilities, probeBackendCapability } from "./backend-capability.js";

describe("backend capability", () => {
  it("marks an installed native backend selectable", () => {
    const capability = probeBackendCapability("codex", {
      platform: "win32",
      resolveCommand: () => "C:\\bin\\codex.cmd",
      runVersion: () => "codex-cli 1.2.3",
    });
    expect(capability).toMatchObject({
      backend: "codex",
      support: "native",
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
    })).toMatchObject({ support: "native", installed: true, selectable: true });
  });

  it("does not expose WSL-only or unverified backends as native Windows choices", () => {
    const resolveCommand = vi.fn((command: string) => `C:\\bin\\${command}.cmd`);
    expect(probeBackendCapability("cursor", { platform: "win32", resolveCommand })?.selectable).toBe(false);
    expect(probeBackendCapability("pi", { platform: "win32", resolveCommand })?.selectable).toBe(false);
    expect(probeBackendCapability("traecli", { platform: "win32", resolveCommand })?.selectable).toBe(false);
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
    expect(probeBackendCapability("grok", {
      platform: "linux",
      resolveCommand: () => undefined,
      runVersion,
    })).toMatchObject({ installed: false, selectable: false, reason: "grok CLI not found" });
    expect(runVersion).not.toHaveBeenCalled();
  });
});
