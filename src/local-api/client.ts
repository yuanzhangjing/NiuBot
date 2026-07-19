import http from "node:http";
import type { LocalIpcEndpoint } from "../platform/ipc.js";

export interface LocalApiResponse {
  statusCode: number;
  body: string;
}

export function localApiRequest(
  endpoint: LocalIpcEndpoint,
  requestPath: string,
  options: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<LocalApiResponse> {
  const data = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: endpoint.address,
      path: requestPath,
      method: options.method ?? (data === undefined ? "GET" : "POST"),
      headers: data === undefined
        ? undefined
        : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: options.timeoutMs ?? 2_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({
        statusCode: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on("timeout", () => req.destroy(new Error("Local API request timed out")));
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

export async function waitForLocalApiHealth(
  endpoint: LocalIpcEndpoint,
  timeoutMs: number,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await localApiRequest(endpoint, "/ping", { timeoutMs: Math.min(2_000, timeoutMs) });
      if (response.statusCode === 200) return true;
    } catch {
      // Engine may still be starting.
    }
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
