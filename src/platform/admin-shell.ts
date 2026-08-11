import { resolveExecutable } from "./executable.js";

export interface AdminShellOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resolve?: typeof resolveExecutable;
}

export interface AdminShellInvocation {
  command: string;
  args: string[];
}

/**
 * Windows 管理员命令统一用 PowerShell 执行：优先 PowerShell 7（pwsh），
 * 未安装时回退到系统自带的 Windows PowerShell 5.1。
 */
export function resolveWindowsAdminShell(options: AdminShellOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("Windows admin shell can only be resolved on win32");
  }

  const env = options.env ?? process.env;
  const resolve = options.resolve ?? resolveExecutable;
  return resolve("pwsh", { platform, env })
    ?? resolve("powershell", { platform, env })
    ?? "powershell.exe";
}

export function buildWindowsAdminShellInvocation(
  script: string,
  options: AdminShellOptions = {},
): AdminShellInvocation {
  return {
    command: resolveWindowsAdminShell(options),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
  };
}

/**
 * Windows PowerShell 的 cmdlet 和 alias（如 Get-Process、ls）不是 PATH 中的独立文件，
 * 因此 Windows 上不能沿用 Unix 的可执行文件预检查。
 */
export function shouldHandleAdminShellCommand(
  text: string,
  isAdmin: boolean,
  options: {
    platform?: NodeJS.Platform;
    commandExists?: (command: string) => boolean;
  } = {},
): boolean {
  if (!isAdmin || !text.startsWith("/") || text.startsWith("//")) return false;

  const command = text.slice(1).trim().split(/\s+/, 1)[0];
  if (!command) return false;
  if ((options.platform ?? process.platform) === "win32") return true;
  return (options.commandExists ?? ((candidate) => resolveExecutable(candidate) !== undefined))(command);
}
