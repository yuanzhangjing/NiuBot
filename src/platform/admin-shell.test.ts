import { describe, expect, test, vi } from "vitest";
import {
  buildWindowsAdminShellInvocation,
  resolveWindowsAdminShell,
  shouldHandleAdminShellCommand,
} from "./admin-shell.js";

describe("Windows admin shell", () => {
  test("prefers PowerShell 7 when pwsh is installed", () => {
    const resolve = vi.fn((command: string) => command === "pwsh" ? "C:\\PowerShell\\pwsh.exe" : undefined);

    expect(resolveWindowsAdminShell({ platform: "win32", resolve })).toBe("C:\\PowerShell\\pwsh.exe");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test("falls back to Windows PowerShell when pwsh is unavailable", () => {
    const resolve = vi.fn((command: string) => command === "powershell" ? "C:\\Windows\\powershell.exe" : undefined);

    expect(resolveWindowsAdminShell({ platform: "win32", resolve })).toBe("C:\\Windows\\powershell.exe");
    expect(resolve.mock.calls.map(([command]) => command)).toEqual(["pwsh", "powershell"]);
  });

  test("uses the built-in PowerShell name as the final Windows fallback", () => {
    expect(resolveWindowsAdminShell({
      platform: "win32",
      resolve: () => undefined,
    })).toBe("powershell.exe");
  });

  test("runs scripts without loading interactive PowerShell profiles", () => {
    const invocation = buildWindowsAdminShellInvocation("Get-Process", {
      platform: "win32",
      resolve: () => "C:\\PowerShell\\pwsh.exe",
    });

    expect(invocation).toEqual({
      command: "C:\\PowerShell\\pwsh.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Get-Process"],
    });
  });

  test("accepts PowerShell cmdlets and aliases without PATH lookup", () => {
    const commandExists = vi.fn(() => false);

    expect(shouldHandleAdminShellCommand("/Get-Process", true, { platform: "win32", commandExists })).toBe(true);
    expect(shouldHandleAdminShellCommand("/ls", true, { platform: "win32", commandExists })).toBe(true);
    expect(commandExists).not.toHaveBeenCalled();
  });

  test("keeps forced agent passthrough and non-admin commands out of the shell", () => {
    expect(shouldHandleAdminShellCommand("//Get-Process", true, { platform: "win32" })).toBe(false);
    expect(shouldHandleAdminShellCommand("/Get-Process", false, { platform: "win32" })).toBe(false);
  });

  test("keeps Unix executable lookup behavior", () => {
    const commandExists = vi.fn((command: string) => command === "pwd");

    expect(shouldHandleAdminShellCommand("/pwd", true, { platform: "linux", commandExists })).toBe(true);
    expect(shouldHandleAdminShellCommand("/not-a-command", true, { platform: "linux", commandExists })).toBe(false);
  });
});
