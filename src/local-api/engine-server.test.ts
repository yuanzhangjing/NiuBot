import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEngineEndpoint } from "../platform/ipc.js";
import { readEngineIdentity, requestEngineShutdown } from "./engine-client.js";
import { EngineControlServer, type EngineIdentity } from "./engine-server.js";

const tempDirs: string[] = [];
const servers: EngineControlServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("engine control API", () => {
  it("returns identity and protects shutdown with a token", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-engine-api-"));
    tempDirs.push(home);
    const endpoint = resolveEngineEndpoint(home);
    const shutdown = vi.fn();
    const identity: EngineIdentity = {
      pid: 123,
      instanceId: "instance-a",
      home,
      version: "1.2.3",
      runtimePath: "/opt/niubot",
      startedAt: "2026-07-19T00:00:00.000Z",
    };
    const server = new EngineControlServer(endpoint, identity, "token-a", shutdown);
    servers.push(server);
    await server.start();

    expect(await readEngineIdentity(endpoint)).toEqual(identity);
    await expect(requestEngineShutdown(endpoint, "wrong-token")).resolves.toBe(false);
    expect(shutdown).not.toHaveBeenCalled();
    await expect(requestEngineShutdown(endpoint, "token-a")).resolves.toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
