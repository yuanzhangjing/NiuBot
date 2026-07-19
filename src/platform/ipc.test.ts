import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupLocalIpcEndpoint,
  endpointFromAddress,
  prepareLocalIpcEndpoint,
  resolveBotEndpoint,
  resolveEngineEndpoint,
  resolvePreflightEndpoint,
} from "./ipc.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("local IPC endpoints", () => {
  it("preserves the existing Unix socket locations", () => {
    expect(resolveBotEndpoint("/tmp/niubot", "NiuBot", "darwin")).toEqual({
      kind: "unix-socket",
      address: "/tmp/niubot/NiuBot/api.sock",
    });
    expect(resolveEngineEndpoint("/tmp/niubot", "linux").address).toBe("/tmp/niubot/run/engine.sock");
    expect(resolvePreflightEndpoint("/tmp/niubot", "NiuBot", "default", "linux").address)
      .toBe("/tmp/niubot/NiuBot/api.sock.preflight");
  });

  it("uses stable Windows named pipes without embedding user paths", () => {
    const first = resolveBotEndpoint("C:\\Users\\Zen\\.niubot", "Niu Bot", "win32");
    const second = resolveBotEndpoint("C:\\Users\\Zen\\.niubot", "Niu Bot", "win32");

    expect(first).toEqual(second);
    expect(first.kind).toBe("named-pipe");
    expect(first.address.startsWith("\\\\.\\pipe\\niubot-")).toBe(true);
    expect(first.address.slice("\\\\.\\pipe\\niubot-".length)).toMatch(/^[a-f0-9]{16}-bot-niu-bot-[a-f0-9]{8}$/);
    expect(first.address).not.toContain("Users");
  });

  it("does not collide when different bot IDs have the same readable slug", () => {
    const first = resolveBotEndpoint("C:\\Users\\Zen\\.niubot", "Niu Bot", "win32");
    const second = resolveBotEndpoint("C:\\Users\\Zen\\.niubot", "Niu-Bot", "win32");

    expect(first.address).not.toBe(second.address);
  });

  it("only creates and removes filesystem entries for Unix sockets", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-ipc-"));
    tempDirs.push(dir);
    const endpoint = resolveBotEndpoint(dir, "NiuBot", "darwin");
    fs.mkdirSync(path.dirname(endpoint.address), { recursive: true });
    fs.writeFileSync(endpoint.address, "stale");

    await prepareLocalIpcEndpoint(endpoint);
    expect(fs.existsSync(endpoint.address)).toBe(false);
    fs.writeFileSync(endpoint.address, "socket-placeholder");
    cleanupLocalIpcEndpoint(endpoint);
    expect(fs.existsSync(endpoint.address)).toBe(false);

    await expect(prepareLocalIpcEndpoint(endpointFromAddress("\\\\.\\pipe\\niubot-test", "win32")))
      .resolves.toBeUndefined();
  });

  it("refuses to unlink an active Unix socket", async () => {
    if (process.platform === "win32") return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-ipc-active-"));
    tempDirs.push(dir);
    const endpoint = resolveEngineEndpoint(dir);
    fs.mkdirSync(path.dirname(endpoint.address), { recursive: true });
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint.address, resolve);
    });

    try {
      await expect(prepareLocalIpcEndpoint(endpoint)).rejects.toThrow("already active");
      expect(fs.existsSync(endpoint.address)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
