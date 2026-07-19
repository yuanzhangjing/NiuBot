import { localApiRequest } from "./client.js";
import type { LocalIpcEndpoint } from "../platform/ipc.js";
import type { EngineIdentity } from "./engine-server.js";

export async function readEngineIdentity(
  endpoint: LocalIpcEndpoint,
  timeoutMs = 2_000,
): Promise<EngineIdentity | undefined> {
  try {
    const response = await localApiRequest(endpoint, "/identity", { timeoutMs });
    if (response.statusCode !== 200) return undefined;
    const value = JSON.parse(response.body) as unknown;
    return isEngineIdentity(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function requestEngineShutdown(
  endpoint: LocalIpcEndpoint,
  controlToken: string,
  timeoutMs = 2_000,
): Promise<boolean> {
  const response = await localApiRequestWithToken(endpoint, "/shutdown", controlToken, timeoutMs);
  return response === 202;
}

export async function waitForEngineIdentity(
  endpoint: LocalIpcEndpoint,
  expectedInstanceId: string,
  timeoutMs: number,
  intervalMs = 250,
): Promise<EngineIdentity | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const identity = await readEngineIdentity(endpoint, Math.min(2_000, timeoutMs));
    if (identity?.instanceId === expectedInstanceId) return identity;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
  return undefined;
}

async function localApiRequestWithToken(
  endpoint: LocalIpcEndpoint,
  requestPath: string,
  token: string,
  timeoutMs: number,
): Promise<number> {
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: endpoint.address,
      path: requestPath,
      method: "POST",
      headers: { "X-NiuBot-Control-Token": token },
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("timeout", () => req.destroy(new Error("Engine control request timed out")));
    req.on("error", reject);
    req.end();
  });
}

function isEngineIdentity(value: unknown): value is EngineIdentity {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item["pid"] === "number"
    && typeof item["instanceId"] === "string"
    && typeof item["home"] === "string"
    && typeof item["version"] === "string"
    && typeof item["runtimePath"] === "string"
    && typeof item["startedAt"] === "string";
}
