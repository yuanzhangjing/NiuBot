import { AGENT_REGISTRY, BUILTIN_BACKENDS, normalizeBackend, type BuiltinBackendType } from "../config.js";
import { buildExecutableInvocation, resolveExecutable } from "../platform/executable.js";
import { runCommand, runCommandSync } from "../platform/command.js";
import { resolveBackendProbeTimeoutMs } from "../lifecycle-timeouts.js";

export interface BackendCapability {
  backend: BuiltinBackendType;
  platform: NodeJS.Platform;
  installed: boolean;
  version?: string;
  selectable: boolean;
  executable?: string;
  reason?: string;
}

export interface ProbeBackendOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resolveCommand?: typeof resolveExecutable;
  runVersion?: (command: string, args: string[], windowsVerbatimArguments?: boolean) => string;
  verifyVersion?: boolean;
}

export interface ProbeBackendAsyncOptions extends Omit<ProbeBackendOptions, "runVersion"> {
  runVersionAsync?: (command: string, args: string[]) => Promise<string>;
}

export function probeBackendCapability(
  rawBackend: string,
  options: ProbeBackendOptions = {},
): BackendCapability | undefined {
  const normalized = normalizeBackend(rawBackend);
  if (!normalized || !BUILTIN_BACKENDS.has(normalized as BuiltinBackendType)) return undefined;
  const backend = normalized as BuiltinBackendType;
  const definition = AGENT_REGISTRY[backend];
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const executable = (options.resolveCommand ?? resolveExecutable)(definition.command, { platform, env });

  if (!executable) {
    return {
      backend,
      platform,
      installed: false,
      selectable: false,
      reason: `${definition.command} CLI not found`,
    };
  }

  if (options.verifyVersion === false) {
    return {
      backend,
      platform,
      installed: true,
      selectable: true,
      executable,
    };
  }

  const invocation = buildExecutableInvocation(executable, [...definition.versionArgs], { platform, env });
  try {
    const output = (options.runVersion ?? defaultRunVersion)(
      invocation.command,
      invocation.args,
      invocation.windowsVerbatimArguments,
    ).trim();
    return {
      backend,
      platform,
      installed: true,
      selectable: true,
      executable,
      version: parseVersion(output),
    };
  } catch (err) {
    return {
      backend,
      platform,
      installed: true,
      selectable: false,
      executable,
      reason: versionProbeError(err),
    };
  }
}

export function probeAllBackendCapabilities(options: ProbeBackendOptions = {}): BackendCapability[] {
  return (Object.keys(AGENT_REGISTRY) as BuiltinBackendType[])
    .map((backend) => probeBackendCapability(backend, options)!)
    .filter(Boolean);
}

export async function probeBackendCapabilityAsync(
  rawBackend: string,
  options: ProbeBackendAsyncOptions = {},
): Promise<BackendCapability | undefined> {
  const base = probeBackendCapability(rawBackend, { ...options, verifyVersion: false });
  if (!base || !base.selectable || options.verifyVersion === false) return base;

  const definition = AGENT_REGISTRY[base.backend];
  try {
    const output = await (options.runVersionAsync ?? defaultRunVersionAsync)(
      base.executable!,
      [...definition.versionArgs],
    );
    return { ...base, version: parseVersion(output.trim()) };
  } catch (err) {
    return { ...base, selectable: false, reason: versionProbeError(err) };
  }
}

export async function probeAllBackendCapabilitiesAsync(
  options: ProbeBackendAsyncOptions = {},
): Promise<BackendCapability[]> {
  return (await Promise.all(
    (Object.keys(AGENT_REGISTRY) as BuiltinBackendType[])
      .map((backend) => probeBackendCapabilityAsync(backend, options)),
  )).filter((capability): capability is BackendCapability => Boolean(capability));
}

async function defaultRunVersionAsync(command: string, args: string[]): Promise<string> {
  return (await runCommand(command, args, {
    timeoutMs: resolveBackendProbeTimeoutMs(),
    maxOutputBytes: 1024 * 1024,
  })).stdout;
}

function defaultRunVersion(command: string, args: string[], _windowsVerbatimArguments = false): string {
  // 统一走 runCommandSync：固定 windowsHide + 超时 + 非零退出码抛错（调用方转为探测失败）
  return runCommandSync(command, args, {
    timeoutMs: resolveBackendProbeTimeoutMs(),
  }).stdout;
}

function parseVersion(output: string): string | undefined {
  const match = output.match(/[0-9]+\.[0-9]+[0-9.a-z-]*/i);
  return match?.[0] ?? (output.split(/\r?\n/, 1)[0] || undefined);
}

function versionProbeError(err: unknown): string {
  if (err instanceof Error && err.message) return `CLI version probe failed: ${err.message}`;
  return "CLI version probe failed";
}
