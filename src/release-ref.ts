import { spawnSync } from "node:child_process";
import path from "node:path";

export interface NodeRuntimeRef {
  nodePath: string;
  nodeVersion: string;
  nodeAbi: string;
}

export type ReleaseRef =
  | { storage: "shared"; artifactId: string; node: NodeRuntimeRef }
  | { storage: "legacy"; runtimePath: string; node: NodeRuntimeRef };

export interface ReleaseSlots {
  current?: ReleaseRef;
  previous?: ReleaseRef;
  lastKnownGood?: ReleaseRef;
}

export function currentNodeRuntimeRef(): NodeRuntimeRef {
  return {
    nodePath: process.execPath,
    nodeVersion: process.version,
    nodeAbi: process.versions.modules,
  };
}

export function probeNodeRuntimeRef(nodePath: string): NodeRuntimeRef {
  const result = spawnSync(nodePath, ["-p", "JSON.stringify({version:process.version,abi:process.versions.modules})"], {
    encoding: "utf-8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`Node runtime exited with ${result.status}: ${nodePath}`);
  }
  const value = JSON.parse(result.stdout.trim()) as { version?: unknown; abi?: unknown };
  if (typeof value.version !== "string" || typeof value.abi !== "string") {
    throw new Error(`Node runtime returned invalid identity: ${nodePath}`);
  }
  return { nodePath: path.resolve(nodePath), nodeVersion: value.version, nodeAbi: value.abi };
}

export function isReleaseRef(value: unknown): value is ReleaseRef {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (!isNodeRuntimeRef(item["node"])) return false;
  if (item["storage"] === "shared") return isSafeIdentifier(item["artifactId"]);
  return item["storage"] === "legacy"
    && typeof item["runtimePath"] === "string"
    && path.isAbsolute(item["runtimePath"]);
}

export function isNodeRuntimeRef(value: unknown): value is NodeRuntimeRef {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item["nodePath"] === "string"
    && path.isAbsolute(item["nodePath"])
    && typeof item["nodeVersion"] === "string"
    && item["nodeVersion"].length > 0
    && typeof item["nodeAbi"] === "string"
    && item["nodeAbi"].length > 0;
}

export function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 240
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && path.basename(value) === value;
}
