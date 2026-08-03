import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { localApiRequest } from "../local-api/client.js";
import { resolveBotEndpoint } from "../platform/ipc.js";
import { ApiServer, type ApiHandler } from "./api.js";

const tempDirs: string[] = [];
const servers: ApiServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

test("/worker 把写命令转交给 Pipeline handler", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "niubot-worker-api-"));
  tempDirs.push(root);
  const endpoint = resolveBotEndpoint(root, "test-bot");
  const executeWorkerCommand = vi.fn(async () => ({ output: "wrk_test" }));
  const handler: ApiHandler = {
    sendMessage: async () => {},
    sendCard: async () => {},
    sendFile: async () => {},
    resolveChatPlatformId: () => undefined,
    getDefaultPlatformChatId: () => undefined,
    executeWorkerCommand,
  };
  const server = new ApiServer(endpoint, handler);
  servers.push(server);
  await server.start();

  const command = { type: "work.create" as const, request: "检查状态流转" };
  const response = await localApiRequest(endpoint, "/worker", {
    method: "POST",
    body: { chat_id: "chat-1", command },
  });

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ output: "wrk_test" });
  expect(executeWorkerCommand).toHaveBeenCalledWith("chat-1", command);
});

