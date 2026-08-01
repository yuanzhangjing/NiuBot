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

/**
 * Build a child environment where lifecycle scripts resolve `node` to the
 * runtime that owns the selected npm executable. Windows environment keys are
 * case-insensitive, so remove duplicate Path/PATH entries before setting it.
 */
export function withNodeRuntimeOnPath(
  nodePath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const delimiter = platform === "win32" ? path.win32.delimiter : path.posix.delimiter;
  const isPathKey = (key: string) => platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH";
  const existingPathKey = Object.keys(env).find(isPathKey);
  const currentPath = existingPathKey ? env[existingPathKey] ?? "" : "";
  const output = { ...env };
  for (const key of Object.keys(output)) {
    if (isPathKey(key)) delete output[key];
  }

  const entries = [pathApi.dirname(nodePath), ...currentPath.split(delimiter)];
  const seen = new Set<string>();
  const normalizedEntries: string[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    const unquoted = trimWrappingQuotes(entry);
    const key = platform === "win32"
      ? pathApi.normalize(unquoted).toLowerCase()
      : unquoted;
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedEntries.push(unquoted);
  }
  output[existingPathKey ?? "PATH"] = normalizedEntries.join(delimiter);
  return output;
}

export function deriveNpmPrefixFromPackageRoot(
  packageRoot: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalized = pathApi.normalize(packageRoot);
  const parts = normalized.split(pathApi.sep);
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (nodeModulesIndex < 1) return undefined;

  const prefixParts = parts[nodeModulesIndex - 1] === "lib"
    ? parts.slice(0, nodeModulesIndex - 1)
    : parts.slice(0, nodeModulesIndex);
  const prefix = prefixParts.join(pathApi.sep);
  return prefix || pathApi.sep;
}

export function isPackageRootInsideNpmRoot(
  packageRoot: string,
  npmRoot: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const relative = pathApi.relative(pathApi.resolve(npmRoot), pathApi.resolve(packageRoot));
  return relative !== "" && !relative.startsWith("..") && !pathApi.isAbsolute(relative);
}

export function commandLookupHint(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? `Get-Command ${command} -All` : `which -a ${command}`;
}

export function resolveExecutable(
  command: string,
  options: ResolveExecutableOptions = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const isExecutable = options.isExecutable ?? ((candidate: string) => defaultExecutableCheck(candidate, platform));
  const extensions = executableExtensions(command, platform, env);

  if (hasPathSeparator(command, platform)) {
    const base = pathApi.isAbsolute(command) ? command : pathApi.resolve(options.cwd ?? process.cwd(), command);
    return firstExecutable(base, extensions, isExecutable);
  }

  const pathValue = readEnv(env, "PATH") ?? "";
  const delimiter = platform === "win32" ? path.win32.delimiter : path.posix.delimiter;
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

  // npm 二进制 shim（node_modules\.bin\*.cmd）：解析出真实入口直跑（JS 入口用 node、
  // 原生 .exe 直跑），绕过 cmd.exe。cmd 的命令行解析把换行当命令分隔，
  // 多行参数（如 --append-system-prompt 的多行 system rules）会在第一个换行处截断，
  // 截断点之后的参数（--resume 等）静默丢失。node/exe 的参数传递不经 cmd 解析，换行安全。
  const shimTarget = resolveNpmShimTarget(executable, args);
  if (shimTarget) {
    return shimTarget;
  }

  const env = options.env ?? process.env;
  const commandInterpreter = readEnv(env, "COMSPEC") || "cmd.exe";
  const doubleEscapeMetaCharacters = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(executable);
  const commandLine = [
    escapeCmdCommand(executable),
    ...args.map((argument) => escapeCmdArgument(argument, doubleEscapeMetaCharacters)),
  ].join(" ");
  return {
    command: commandInterpreter,
    // cmd /s strips the first and last quote. The outer pair is therefore part
    // of the protocol and is required when the shim path contains spaces.
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * 解析 npm 安装的 .cmd shim 指向的真实入口。
 * npm shim 形如 `"%_prog%" "%dp0%\..\pkg\cli.js" %*`（老式 find_dp0 与新式简化版
 * 结构相同，仅有无 find_dp0 子过程之分）：提取 `%dp0%` 之后的 JS 入口用当前 node
 * 直跑；纯原生 .exe shim 则解析 exe 路径直跑。解析失败（非 npm shim / 内容异常）
 * 返回 undefined，调用方保持原 cmd 包装路径。
 */
function resolveNpmShimTarget(shimPath: string, args: string[]): ExecutableInvocation | undefined {
  if (!/node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(shimPath)) return undefined;
  let content: string;
  try {
    content = fs.readFileSync(shimPath, "utf8");
  } catch {
    return undefined;
  }
  const dp0 = path.win32.dirname(shimPath);

  // JS 入口（cli.js）：取最后一个 .js/.cjs/.mjs 引用（排除 node.exe 判断行）
  const jsRefs = [...content.matchAll(/"%(?:~)?dp0%\\?([^"\r\n]+?\.(?:js|cjs|mjs))"/gi)];
  if (jsRefs.length > 0) {
    const raw = jsRefs[jsRefs.length - 1]![1];
    return {
      command: process.execPath,
      args: [path.win32.resolve(dp0, raw), ...args],
    };
  }

  // 纯原生 .exe shim：取最后一个非 node.exe 的 exe 引用
  const exeRefs = [...content.matchAll(/"%(?:~)?dp0%\\?([^"\r\n]+?\.exe)"/gi)].filter(
    (m) => !/node\.exe$/i.test(m[1]!),
  );
  if (exeRefs.length > 0) {
    const raw = exeRefs[exeRefs.length - 1]![1];
    return { command: path.win32.resolve(dp0, raw), args };
  }
  return undefined;
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
const CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(value: string): string {
  return String(value).replace(CMD_META_CHARACTERS, "^$1");
}

function escapeCmdArgument(value: string, doubleEscapeMetaCharacters: boolean): string {
  let escaped = String(value);
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META_CHARACTERS, "^$1");
  return doubleEscapeMetaCharacters
    ? escaped.replace(CMD_META_CHARACTERS, "^$1")
    : escaped;
}
