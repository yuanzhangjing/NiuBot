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
 * 解析 npm 安装的 .cmd shim 指向的真实入口（任意位置：本地 node_modules/.bin、
 * npm 全局 %APPDATA%\npm、yarn 等）。
 * npm shim 的调用行形如 `"%_prog%" "%dp0%\..\pkg\cli.js" %*`（find_dp0 变量赋值后
 * 引用）或 `node "%~dp0\..\pkg\cli.js" %*`（内联式；cmd 的 %~dp0 语法没有结尾百分号）。
 * 提取真实入口用当前 node 直跑（JS 入口）/ exe 直跑，绕过 cmd.exe——cmd 的命令行解析
 * 把换行当命令分隔，多行参数（--append-system-prompt）会在第一个换行处截断，
 * 截断点之后的参数静默丢失。
 * 解析失败（非 npm shim / 内容异常）返回 undefined，调用方保持原 cmd 包装路径。
 */
function resolveNpmShimTarget(shimPath: string, args: string[]): ExecutableInvocation | undefined {
  let content: string;
  try {
    content = fs.readFileSync(shimPath, "utf8");
  } catch {
    return undefined;
  }
  const dp0 = path.win32.dirname(shimPath);

  // npm shim 调用行特征（排除普通批处理误判）：
  // - 行以 `%*` 结尾（透传全部参数），且不是 REM/:: 注释行
  // - 入口引用必须含 `..\` 段（npm shim 的 cli.js 在 .bin 上跳一级的包目录；
  //   排除 `call tool.cmd "%dp0%\config.js" %*` 这类传配置文件的普通脚本）
  // - 取该行第一个非 node.exe 的 dp0 引用作为入口（prog 可能是 %dp0%\node.exe）
  // 匹配 %dp0%（find_dp0 赋值后引用）与 %~dp0（内联式，无结尾 %）；
  // [\\/]* 吞掉转义/正斜杠，避免盘符根相对解析。
  let raw: string | undefined;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/\s+%\*/.test(line)) continue;
    if (/^(?:rem|::)\b/i.test(trimmed)) continue;
    const refs = [...line.matchAll(/"%(?:~)?dp0(?:%)?[\\/]*(\.\.[\\/][^"\r\n]+?\.(?:js|cjs|mjs|exe))"/gi)];
    const candidate = refs.find((m) => !/node\.exe$/i.test(m[1]!));
    if (candidate) raw = candidate[1];
  }
  if (!raw) return undefined;
  const target = path.win32.resolve(dp0, raw);
  // 解析出的入口必须真实存在，否则回退 cmd（避免误判/损坏 shim 直跑错误路径）。
  // Windows API 接受正斜杠分隔符，统一转正斜杠做存在性检查（与平台无关）。
  try {
    if (!fs.statSync(target.replace(/\\/g, "/")).isFile()) return undefined;
  } catch {
    return undefined;
  }
  if (/\.(?:js|cjs|mjs)$/i.test(raw)) {
    return { command: process.execPath, args: [target, ...args] };
  }
  return { command: target, args };
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
