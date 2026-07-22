import { spawnSync } from "node:child_process";
import { AGENT_REGISTRY, BUILTIN_BACKENDS, normalizeBackend, type BuiltinBackendType } from "../config.js";
import { buildExecutableInvocation, resolveExecutable } from "../platform/executable.js";
import { runCommand } from "../platform/command.js";
import { resolveBackendProbeTimeoutMs } from "../lifecycle-timeouts.js";

export type BackendPlatformSupport = "native" | "dependency-required" | "wsl-only" | "unknown";

export interface BackendCapability {
  backend: BuiltinBackendType;
  platform: NodeJS.Platform;
  support: BackendPlatformSupport;
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
  const support: BackendPlatformSupport = platform === "win32"
    ? definition.windowsSupport
    : "native";
  const executable = (options.resolveCommand ?? resolveExecutable)(definition.command, { platform, env });

  if (!executable) {
    return {
      backend,
      platform,
      support,
      installed: false,
      selectable: false,
      reason: `${definition.command} CLI not found`,
    };
  }

  if (support === "wsl-only") {
    return {
      backend,
      platform,
      support,
      installed: true,
      selectable: false,
      executable,
      reason: "upstream CLI currently requires WSL on Windows",
    };
  }
  if (support === "unknown") {
    return {
      backend,
      platform,
      support,
      installed: true,
      selectable: false,
      executable,
      reason: "native Windows support has not been verified",
    };
  }

  if (options.verifyVersion === false) {
    return {
      backend,
      platform,
      support,
      installed: true,
      selectable: true,
      executable,
      reason: supportReason(support),
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
      support,
      installed: true,
      selectable: true,
      executable,
      version: parseVersion(output),
      reason: supportReason(support),
    };
  } catch (err) {
    return {
      backend,
      platform,
      support,
      installed: true,
      selectable: false,
      executable,
      reason: versionProbeError(err),
    };
  }
}

function supportReason(support: BackendPlatformSupport): string | undefined {
  return support === "dependency-required"
    ? "requires the upstream Windows runtime dependency"
    : undefined;
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

function defaultRunVersion(command: string, args: string[], windowsVerbatimArguments = false): string {
  const result = spawnSync(command, args, {
    timeout: resolveBackendProbeTimeoutMs(),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || `exit ${result.status}`).trim());
  return result.stdout;
}

function parseVersion(output: string): string | undefined {
  const match = output.match(/[0-9]+\.[0-9]+[0-9.a-z-]*/i);
  return match?.[0] ?? (output.split(/\r?\n/, 1)[0] || undefined);
}

function versionProbeError(err: unknown): string {
  if (err instanceof Error && err.message) return `CLI version probe failed: ${err.message}`;
  return "CLI version probe failed";
}
