import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKEND_PROBE_TIMEOUT_MS,
  DEFAULT_ENGINE_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_ENGINE_START_TIMEOUT_MS,
  resolveBackendProbeTimeoutMs,
  resolveEngineShutdownTimeoutMs,
  resolveEngineStartTimeoutMs,
  resolveInFlightShutdownTimeoutMs,
} from "./lifecycle-timeouts.js";

describe("lifecycle timeouts", () => {
  it("uses low-end-host-safe defaults", () => {
    expect(resolveEngineStartTimeoutMs({})).toBe(DEFAULT_ENGINE_START_TIMEOUT_MS);
    expect(DEFAULT_ENGINE_START_TIMEOUT_MS).toBe(120_000);
    expect(resolveBackendProbeTimeoutMs({})).toBe(DEFAULT_BACKEND_PROBE_TIMEOUT_MS);
    expect(DEFAULT_BACKEND_PROBE_TIMEOUT_MS).toBe(60_000);
    expect(resolveEngineShutdownTimeoutMs({})).toBe(DEFAULT_ENGINE_SHUTDOWN_TIMEOUT_MS);
    expect(DEFAULT_ENGINE_SHUTDOWN_TIMEOUT_MS).toBe(60_000);
    expect(resolveInFlightShutdownTimeoutMs({})).toBe(45_000);
  });

  it("accepts positive second overrides and rejects invalid values", () => {
    expect(resolveEngineStartTimeoutMs({ NIUBOT_ENGINE_START_TIMEOUT: "180" })).toBe(180_000);
    expect(resolveBackendProbeTimeoutMs({ NIUBOT_BACKEND_PROBE_TIMEOUT: "90" })).toBe(90_000);
    expect(resolveEngineShutdownTimeoutMs({ NIUBOT_ENGINE_SHUTDOWN_TIMEOUT: "75" })).toBe(75_000);
    expect(resolveEngineStartTimeoutMs({ NIUBOT_ENGINE_START_TIMEOUT: "0" })).toBe(120_000);
    expect(resolveBackendProbeTimeoutMs({ NIUBOT_BACKEND_PROBE_TIMEOUT: "invalid" })).toBe(60_000);
  });

  it("keeps the old restart health timeout as a compatibility alias", () => {
    expect(resolveEngineStartTimeoutMs({ NIUBOT_RESTART_HEALTH_TIMEOUT: "30" })).toBe(30_000);
    expect(resolveEngineStartTimeoutMs({
      NIUBOT_RESTART_HEALTH_TIMEOUT: "30",
      NIUBOT_ENGINE_START_TIMEOUT: "90",
    })).toBe(90_000);
  });
});
