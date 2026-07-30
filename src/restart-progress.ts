import { isProcessAlive } from "./platform/process.js";
import { readRestartState, type RestartState } from "./restart-state.js";

const SUCCESS_PHASES = new Set(["success", "production_success"]);
const FAILURE_PHASES = new Set([
  "failed",
  "rollback_success",
  "rollback_unavailable",
  "rollback_failed",
]);

export type RestartCompletion = "success" | "rolled-back" | "failed";

export function restartCompletion(state: RestartState): RestartCompletion | undefined {
  if (SUCCESS_PHASES.has(state.phase)) return "success";
  if (state.phase === "rollback_success") return "rolled-back";
  if (FAILURE_PHASES.has(state.phase)) return "failed";
  return undefined;
}

export function restartPhaseLabel(phase: string, version?: string): string {
  switch (phase) {
    case "started":
      return "Preparing update";
    case "bootstrap_last_known_good":
      return "Preparing recovery point";
    case "build_npm_candidate":
      return version ? `Installing ${version}` : "Installing update";
    case "preflight_snapshot":
      return "Preparing validation";
    case "preflight_candidate":
      return "Validating new version";
    case "stop_old_service":
      return "Stopping current service";
    case "rollback_snapshot":
      return "Preparing rollback snapshot";
    case "start_candidate":
      return "Starting new version";
    case "health_check_candidate":
      return "Checking new version";
    case "rollback_stop_candidate":
      return "Update failed; stopping new version";
    case "rollback_restore_database":
      return "Restoring data";
    case "rollback_start_lkg":
      return "Starting previous version";
    case "health_check_rollback":
      return "Checking previous version";
    case "snapshot_failed_restart_old":
      return "Snapshot failed; restarting previous version";
    case "health_check_snapshot_recovery":
      return "Checking previous version";
    default:
      return phase.replaceAll("_", " ");
  }
}

export interface WaitForRestartOptions {
  stateFile: string;
  restartId: string;
  workerPid: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onPhase?: (state: RestartState) => void;
  processAlive?: (pid: number) => boolean;
}

export async function waitForRestartCompletion(
  options: WaitForRestartOptions,
): Promise<{ state: RestartState; completion: RestartCompletion }> {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const processAlive = options.processAlive ?? isProcessAlive;
  const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
  let lastPhase: string | undefined;

  while (deadline === undefined || Date.now() < deadline) {
    const state = readRestartState(options.stateFile, options.restartId);
    if (state && state.phase !== lastPhase) {
      lastPhase = state.phase;
      options.onPhase?.(state);
    }
    if (state) {
      const completion = restartCompletion(state);
      if (completion) return { state, completion };
    }
    if (!processAlive(options.workerPid)) {
      await delay(Math.min(pollIntervalMs, 100));
      const finalState = readRestartState(options.stateFile, options.restartId);
      if (finalState) {
        const completion = restartCompletion(finalState);
        if (completion) return { state: finalState, completion };
      }
      throw new Error("Update worker exited before recording a final result");
    }
    await delay(pollIntervalMs);
  }

  throw new Error("Timed out waiting for the update worker; the update may still be running");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
