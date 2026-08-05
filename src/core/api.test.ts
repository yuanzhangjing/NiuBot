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
    body: { chat_id: "chat-1", command, schedule_token: "tok-1" },
  });

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ output: "wrk_test" });
  expect(executeWorkerCommand).toHaveBeenCalledWith("chat-1", command, "tok-1");
});

test("/schedule 把结构化调度命令转交给当前 Pipeline 回合", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "niubot-schedule-api-"));
  tempDirs.push(root);
  const endpoint = resolveBotEndpoint(root, "test-bot");
  const executeScheduleCommand = vi.fn(async () => ({ output: "Created loop:1" }));
  const handler: ApiHandler = {
    sendMessage: async () => {},
    sendCard: async () => {},
    sendFile: async () => {},
    resolveChatPlatformId: () => undefined,
    getDefaultPlatformChatId: () => undefined,
    executeScheduleCommand,
  };
  const server = new ApiServer(endpoint, handler);
  servers.push(server);
  await server.start();

  const command = {
    type: "create.loop" as const,
    intervalSeconds: 300,
    prompt: "检查部署状态",
  };
  const response = await localApiRequest(endpoint, "/schedule", {
    method: "POST",
    body: { chat_id: "chat-1", command, schedule_token: "tok-2" },
  });

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ output: "Created loop:1" });
  // 旧格式 create.loop 被归一化为统一的 create.schedule
  expect(executeScheduleCommand).toHaveBeenCalledWith("chat-1", {
    type: "create.schedule",
    mode: "loop",
    trigger: "every",
    intervalSeconds: 300,
    prompt: "检查部署状态",
    maxTimes: undefined,
    durationSeconds: undefined,
    at: undefined,
    afterSeconds: undefined,
    cronExpr: undefined,
    description: undefined,
    untilTime: undefined,
    timeZone: "Asia/Shanghai",
  }, "tok-2");
});

test("/schedule 在 API 边界拒绝未知操作和非法字段", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "niubot-schedule-invalid-api-"));
  tempDirs.push(root);
  const endpoint = resolveBotEndpoint(root, "test-bot");
  const executeScheduleCommand = vi.fn(async () => ({ output: "unexpected" }));
  const handler: ApiHandler = {
    sendMessage: async () => {}, sendCard: async () => {}, sendFile: async () => {},
    resolveChatPlatformId: () => undefined, getDefaultPlatformChatId: () => undefined,
    executeScheduleCommand,
  };
  const server = new ApiServer(endpoint, handler);
  servers.push(server);
  await server.start();

  for (const command of [
    { type: "unknown" },
    { type: "create.cron", prompt: "task", cronExpr: "* * * * *", maxTimes: -1 },
    { type: "create.loop", prompt: " ", intervalSeconds: 60 },
  ]) {
    const response = await localApiRequest(endpoint, "/schedule", {
      method: "POST", body: { chat_id: "chat-1", command },
    });
    expect(response.statusCode).toBe(400);
  }
  expect(executeScheduleCommand).not.toHaveBeenCalled();
});
