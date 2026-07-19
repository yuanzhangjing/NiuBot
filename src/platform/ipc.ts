import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { removeFileSync } from "./files.js";

export type LocalIpcEndpointKind = "unix-socket" | "named-pipe";

export interface LocalIpcEndpoint {
  kind: LocalIpcEndpointKind;
  address: string;
}

export interface ResolveBotEndpointOptions {
  platform?: NodeJS.Platform;
  unixSocketDirectory?: string;
}

export function resolveBotEndpoint(
  niubotHome: string,
  botId: string,
  options: ResolveBotEndpointOptions = {},
): LocalIpcEndpoint {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return namedPipeEndpoint(niubotHome, `bot-${stableSegment(botId)}`);
  }
  return {
    kind: "unix-socket",
    address: path.posix.join(options.unixSocketDirectory ?? path.posix.join(niubotHome, botId), "api.sock"),
  };
}

export function resolveEngineEndpoint(
  niubotHome: string,
  platform: NodeJS.Platform = process.platform,
): LocalIpcEndpoint {
  if (platform === "win32") return namedPipeEndpoint(niubotHome, "engine");
  return { kind: "unix-socket", address: path.posix.join(niubotHome, "run", "engine.sock") };
}

export function resolvePreflightEndpoint(
  niubotHome: string,
  botId: string,
  candidateId = "default",
  platform: NodeJS.Platform = process.platform,
): LocalIpcEndpoint {
  if (platform === "win32") {
    return namedPipeEndpoint(niubotHome, `preflight-${stableSegment(botId)}-${stableSegment(candidateId)}`);
  }
  const suffix = candidateId === "default" ? "" : `.${stableSegment(candidateId)}`;
  return { kind: "unix-socket", address: path.posix.join(niubotHome, botId, `api.sock.preflight${suffix}`) };
}

export function endpointFromAddress(
  address: string,
  platform: NodeJS.Platform = process.platform,
): LocalIpcEndpoint {
  return {
    kind: platform === "win32" || address.startsWith("\\\\.\\pipe\\")
      ? "named-pipe"
      : "unix-socket",
    address,
  };
}

export async function prepareLocalIpcEndpoint(endpoint: LocalIpcEndpoint): Promise<void> {
  if (endpoint.kind !== "unix-socket") return;
  fs.mkdirSync(path.dirname(endpoint.address), { recursive: true });
  if (!fs.existsSync(endpoint.address)) return;
  if (await canConnectToUnixSocket(endpoint.address)) {
    throw new Error(`Local IPC endpoint is already active: ${endpoint.address}`);
  }
  removeFileSync(endpoint.address);
}

export function cleanupLocalIpcEndpoint(endpoint: LocalIpcEndpoint): void {
  if (endpoint.kind !== "unix-socket") return;
  removeFileSync(endpoint.address);
}

function namedPipeEndpoint(niubotHome: string, role: string): LocalIpcEndpoint {
  const homeHash = createHash("sha256")
    .update(path.win32.resolve(niubotHome).toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return {
    kind: "named-pipe",
    address: `\\\\.\\pipe\\niubot-${homeHash}-${role}`,
  };
}

function stableSegment(value: string): string {
  const readable = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${readable || "id"}-${hash}`;
}

function canConnectToUnixSocket(address: string, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(address);
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
