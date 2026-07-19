import fs from "node:fs";
import path from "node:path";

export interface ResolveExecutableOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  isExecutable?: (filePath: string) => boolean;
}

export interface ExecutableInvocation {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export function resolveNpmExecutableForNode(
  nodePath: string,
  platform: NodeJS.Platform = process.platform,
  exists: (filePath: string) => boolean = fs.existsSync,
): string | undefined {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const candidate = pathApi.join(pathApi.dirname(nodePath), platform === "win32" ? "npm.cmd" : "npm");
  return exists(candidate) ? candidate : undefined;
}

export function resolveExecutable(
  command: string,
  options: ResolveExecutableOptions = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathApi = platform === "win32" ? path.win32 : path;
  const isExecutable = options.isExecutable ?? ((candidate: string) => defaultExecutableCheck(candidate, platform));
  const extensions = executableExtensions(command, platform, env);

  if (hasPathSeparator(command, platform)) {
    const base = pathApi.isAbsolute(command) ? command : pathApi.resolve(options.cwd ?? process.cwd(), command);
    return firstExecutable(base, extensions, isExecutable);
  }

  const pathValue = readEnv(env, "PATH") ?? "";
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const base = pathApi.join(trimWrappingQuotes(directory), command);
    const resolved = firstExecutable(base, extensions, isExecutable);
    if (resolved) return resolved;
  }
  return undefined;
}

export function buildExecutableInvocation(
  executable: string,
  args: string[],
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): ExecutableInvocation {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(executable)) {
    return { command: executable, args };
  }

  const env = options.env ?? process.env;
  const commandInterpreter = readEnv(env, "COMSPEC") || "cmd.exe";
  const commandLine = [escapeCmdArgument(executable), ...args.map(escapeCmdArgument)].join(" ");
  return {
    command: commandInterpreter,
    args: ["/d", "/s", "/c", commandLine],
    windowsVerbatimArguments: true,
  };
}

function firstExecutable(
  base: string,
  extensions: string[],
  isExecutable: (filePath: string) => boolean,
): string | undefined {
  for (const extension of extensions) {
    const candidate = `${base}${extension}`;
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function executableExtensions(command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== "win32") return [""];
  if (path.win32.extname(command)) return [""];
  const pathExt = readEnv(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD";
  return pathExt.split(";").filter(Boolean).map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
}

function defaultExecutableCheck(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasPathSeparator(command: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? /[\\/]/.test(command) : command.includes(path.sep);
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key];
  if (direct !== undefined) return direct;
  const actual = Object.keys(env).find((candidate) => candidate.toUpperCase() === key);
  return actual ? env[actual] : undefined;
}

function trimWrappingQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

// Equivalent to the escaping used by mature Node spawn wrappers for cmd.exe.
function escapeCmdArgument(value: string): string {
  let escaped = String(value);
  escaped = escaped.replace(/(\\*)"/g, "$1$1\\\"");
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`;
  return escaped.replace(/[()%!^"<>&|]/g, "^$&");
}
