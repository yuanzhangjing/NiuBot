import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { localApiRequest } from "../local-api/client.js";
import { resolveBotEndpoint } from "../platform/ipc.js";
import { TZ, normalizeTimeZoneInput } from "../tz.js";
import { ApiServer, type ApiHandler } from "./api.js";

const tempDirs: string[] = [];
const servers: ApiServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
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
    mode: "main",
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
    // 默认时区与实现同源（NIUBOT_TZ 或系统时区），不绑定具体值，保证 CI（UTC）可移植
    timeZone: TZ,
  }, "tok-2", { scopeKey: undefined, threadId: undefined });
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

test("/collab/turn 只把合法的结构化动作交给当前 Pipeline", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "niubot-collab-api-"));
  tempDirs.push(root);
  const endpoint = resolveBotEndpoint(root, "test-bot");
  const executeCollabTurn = vi.fn(async () => ({ output: "协作动作已记录。" }));
  const handler: ApiHandler = {
    sendMessage: async () => {}, sendCard: async () => {}, sendFile: async () => {},
    resolveChatPlatformId: () => undefined, getDefaultPlatformChatId: () => undefined,
    executeCollabTurn,
  };
  const server = new ApiServer(endpoint, handler);
  servers.push(server);
  await server.start();

  const response = await localApiRequest(endpoint, "/collab/turn", {
    method: "POST",
    body: {
      chat_id: "chat-1",
      decision: { action: "handoff", to: "ou-cow" },
      collab_token: "turn-token",
      scope_key: "chat-1#omt-topic",
      thread_id: "omt-topic",
      reply_to_msg_id: "om-trigger",
    },
  });

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ output: "协作动作已记录。" });
  expect(executeCollabTurn).toHaveBeenCalledWith(
    "chat-1",
    { action: "handoff", to: "ou-cow" },
    "turn-token",
    { scopeKey: "chat-1#omt-topic", threadId: "omt-topic", replyToMsgId: "om-trigger" },
  );

  const invalid = await localApiRequest(endpoint, "/collab/turn", {
    method: "POST",
    body: { chat_id: "chat-1", decision: { action: "handoff", to: 42 } },
  });
  expect(invalid.statusCode).toBe(400);
  expect(executeCollabTurn).toHaveBeenCalledTimes(1);
});

test("/timezone lets the agent apply a resolved zone", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "niubot-timezone-api-"));
  tempDirs.push(root);
  const endpoint = resolveBotEndpoint(root, "test-bot");
  let current = "Asia/Shanghai";
  const handler: ApiHandler = {
    sendMessage: async () => {},
    sendCard: async () => {},
    sendFile: async () => {},
    resolveChatPlatformId: () => undefined,
    getDefaultPlatformChatId: () => undefined,
    getTimezone: () => current,
    setTimezone: (raw) => {
      const resolved = normalizeTimeZoneInput(raw);
      if (!resolved) throw new Error(`未知时区: ${raw}`);
      current = resolved;
      return resolved;
    },
  };
  const server = new ApiServer(endpoint, handler);
  servers.push(server);
  await server.start();

  const switched = await localApiRequest(endpoint, "/timezone", {
    method: "POST",
    body: { timezone: "西雅图" },
  });
  expect(switched.statusCode).toBe(200);
  expect(JSON.parse(switched.body)).toEqual({ timezone: "America/Los_Angeles" });
});
