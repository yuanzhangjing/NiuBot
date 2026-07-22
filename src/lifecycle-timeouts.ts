export const DEFAULT_ENGINE_START_TIMEOUT_MS = 120_000;
export const DEFAULT_BACKEND_PROBE_TIMEOUT_MS = 60_000;
export const DEFAULT_ENGINE_SHUTDOWN_TIMEOUT_MS = 60_000;
export const DEFAULT_ENGINE_CONTROL_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Lifecycle timeout environment values are expressed in seconds so operators
 * do not need to work with large millisecond values in PowerShell or service
 * configuration.
 */
export function readPositiveSecondsAsMs(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (!raw) return fallback;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : fallback;
}

export function resolveEngineStartTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const legacyRestartTimeout = readPositiveSecondsAsMs(
    "NIUBOT_RESTART_HEALTH_TIMEOUT",
    DEFAULT_ENGINE_START_TIMEOUT_MS,
    env,
  );
  return readPositiveSecondsAsMs("NIUBOT_ENGINE_START_TIMEOUT", legacyRestartTimeout, env);
}

export function resolveBackendProbeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveSecondsAsMs("NIUBOT_BACKEND_PROBE_TIMEOUT", DEFAULT_BACKEND_PROBE_TIMEOUT_MS, env);
}

export function resolveEngineShutdownTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveSecondsAsMs("NIUBOT_ENGINE_SHUTDOWN_TIMEOUT", DEFAULT_ENGINE_SHUTDOWN_TIMEOUT_MS, env);
}

/** Leave time for backend cleanup, DB close, process-state cleanup, and exit. */
export function resolveInFlightShutdownTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1_000, Math.floor(resolveEngineShutdownTimeoutMs(env) * 0.75));
}
