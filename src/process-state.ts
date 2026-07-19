import fs from "node:fs";
import path from "node:path";
import type { LocalIpcEndpointKind } from "./platform/ipc.js";
import { removeFileSync, replaceFileSync } from "./platform/files.js";

export const PROCESS_STATE_SCHEMA_VERSION = 1;

export interface EngineProcessState {
  pid: number;
  instanceId: string;
  startedAt: string;
  platformStartMarker?: string;
  endpoint: string;
  endpointKind: LocalIpcEndpointKind;
  controlToken: string;
  version: string;
  runtimeMode?: string;
  runtimePath: string;
  nodePath: string;
}

export interface NiuBotProcessState {
  schemaVersion: typeof PROCESS_STATE_SCHEMA_VERSION;
  processes: {
    engine: EngineProcessState;
  };
}

export function getProcessStatePath(niubotHome: string): string {
  return path.join(niubotHome, "run", "process-state.json");
}

export function readProcessState(niubotHome: string): NiuBotProcessState | undefined {
  const filePath = getProcessStatePath(niubotHome);
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    return isProcessState(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeProcessState(niubotHome: string, engine: EngineProcessState): void {
  const filePath = getProcessStatePath(niubotHome);
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(directory, `.process-state.${process.pid}.${Date.now()}.tmp`);
  const state: NiuBotProcessState = {
    schemaVersion: PROCESS_STATE_SCHEMA_VERSION,
    processes: { engine },
  };

  const fd = fs.openSync(tempPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    replaceFileSync(tempPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    throw err;
  }
}

export function clearProcessState(niubotHome: string, expectedInstanceId?: string): boolean {
  const filePath = getProcessStatePath(niubotHome);
  if (expectedInstanceId) {
    const current = readProcessState(niubotHome);
    if (current && current.processes.engine.instanceId !== expectedInstanceId) return false;
  }
  try {
    return removeFileSync(filePath);
  } catch (err) { throw err; }
}

function isProcessState(value: unknown): value is NiuBotProcessState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record["schemaVersion"] !== PROCESS_STATE_SCHEMA_VERSION) return false;
  const processes = record["processes"];
  if (!processes || typeof processes !== "object") return false;
  const engine = (processes as Record<string, unknown>)["engine"];
  if (!engine || typeof engine !== "object") return false;
  const item = engine as Record<string, unknown>;
  return typeof item["pid"] === "number"
    && Number.isInteger(item["pid"])
    && item["pid"] > 0
    && typeof item["instanceId"] === "string"
    && typeof item["startedAt"] === "string"
    && (item["platformStartMarker"] === undefined || typeof item["platformStartMarker"] === "string")
    && typeof item["endpoint"] === "string"
    && (item["endpointKind"] === "unix-socket" || item["endpointKind"] === "named-pipe")
    && typeof item["controlToken"] === "string"
    && typeof item["version"] === "string"
    && (item["runtimeMode"] === undefined || typeof item["runtimeMode"] === "string")
    && typeof item["runtimePath"] === "string"
    && typeof item["nodePath"] === "string";
}
