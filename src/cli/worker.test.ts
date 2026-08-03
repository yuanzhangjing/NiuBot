import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { initDatabase } from "../database/schema.js";
import { findLatestUserPlatformMsgId } from "../messages/store.js";
import { ApiServer, type ApiHandler } from "../core/api.js";
import { resolveBotEndpoint } from "../platform/ipc.js";
import { SqliteJobService } from "../worker/job-service.js";
import { WorkerProfileRegistry } from "../worker/profiles.js";
import type { WorkerAgentCommand } from "../worker/agent-command.js";
import { handleWorker, type WorkerCommandExecutor } from "./worker.js";

const BOT_ID = "test-bot";
const CHAT_ID = "chat-1";
const USER_ID = "user-1";

let db: Database.Database;
let tempRoot: string;
let captured: string[];
let execute: WorkerCommandExecutor;

async function capture(fn: () => void | Promise<void>): Promise<string[]> {
  captured = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
    captured.push(String(line));
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return captured;
}

function env(overrides: Record<string, string> = {}) {
  const base = {
    NIUBOT_BOT_ID: BOT_ID,
    NIUBOT_BOT_NAME: BOT_ID,
    NIUBOT_CHAT_ID: CHAT_ID,
    NIUBOT_USER_ID: USER_ID,
    NIUBOT_CHAT_TYPE: "p2p",
    NIUBOT_WORK_DIR: tempRoot,
  };
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    process.env[key] = value;
  }
}

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "worker-cli-"));
  db = initDatabase(path.join(tempRoot, "niubot.db"));
  env();
  const service = new SqliteJobService(db, BOT_ID);
  const registry = new WorkerProfileRegistry();
  execute = async (_chatId: string, command: WorkerAgentCommand) => {
    switch (command.type) {
      case "work.create": {
        const work = service.createWork({
          botId: BOT_ID,
          ownerUserId: USER_ID,
          sourceChatId: CHAT_ID,
          visibility: process.env["NIUBOT_CHAT_TYPE"] === "group" ? "public" : "private",
          request: command.request,
          triggerMsgPlatformId: findLatestUserPlatformMsgId(db, CHAT_ID, USER_ID),
        });
        return { output: work.id };
      }
      case "job.create": {
        if (!registry.get(command.workerProfileId)) throw new Error(`未知 Worker Profile: ${command.workerProfileId}`);
        const job = service.createJob({
          workId: command.workId,
          workerProfileId: command.workerProfileId,
          prompt: command.prompt,
          workdir: command.workdir ?? tempRoot,
          workspacePolicy: command.workspacePolicy,
          dependsOn: command.dependsOn,
        }, command.idempotencyKey);
        return { output: job.id };
      }
      case "cancel": {
        if (command.id.startsWith("wrk_")) service.cancelWork(command.id);
        else service.requestCancel(command.id);
        return { output: `${command.id} 已请求取消` };
      }
      case "work.complete_recovery": {
        const work = service.completeWork(command.workId, { conclusion: command.conclusion });
        if (!work) throw new Error("Work 不可完成");
        return { output: `Work ${command.workId} 已完成` };
      }
      default:
        throw new Error(`测试未实现命令: ${command.type}`);
    }
  };
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function writeDoc(name: string, content: string): string {
  const file = path.join(tempRoot, name);
  writeFileSync(file, content);
  return file;
}

test("work create → job create → list → get → complete 完整链路", async () => {
  // 当前 chat 最近一条用户消息（有平台侧 ID）应被记为 Work 的触发消息
  db.prepare(
    `INSERT INTO messages (chat_id, sender_id, role, content_text, platform, platform_msg_id, created_at)
     VALUES (?, ?, 'user', '审查登录模块的并发问题', 'feishu', 'om_trigger_1', datetime('now'))`,
  ).run(CHAT_ID, USER_ID);

  const workFile = writeDoc("work.md", "审查登录模块的并发问题");
  const out1 = await capture(() => handleWorker(db, ["work", "create", "--file", workFile], execute));
  const workId = out1[0]!;
  expect(workId).toMatch(/^wrk_/);
  const workRow = db.prepare("SELECT trigger_msg_platform_id FROM worker_works WHERE id = ?").get(workId) as
    | { trigger_msg_platform_id: string | null }
    | undefined;
  expect(workRow?.trigger_msg_platform_id).toBe("om_trigger_1");

  const jobFile = writeDoc("job.md", "检查 handleLogin 的竞态，给出证据");
  const out2 = await capture(() => handleWorker(db, ["job", "create", "--work", workId, "--worker", "reviewer", "--file", jobFile], execute));
  const jobId = out2[0]!;
  expect(jobId).toMatch(/^job_/);

  // 相同内容重复创建返回原 Job（幂等）
  const out3 = await capture(() => handleWorker(db, ["job", "create", "--work", workId, "--worker", "reviewer", "--file", jobFile], execute));
  expect(out3[0]).toBe(jobId);

  // list 能看到
  const listOut = await capture(() => handleWorker(db, ["list"], execute));
  expect(listOut.join("\n")).toContain(workId);
  expect(listOut.join("\n")).toContain(jobId);

  // get job 详情
  const getOut = await capture(() => handleWorker(db, ["get", jobId], execute));
  expect(getOut.join("\n")).toContain("检查 handleLogin");

  // complete work
  const resultFile = writeDoc("result.md", "已完成审查，无阻塞问题");
  await expect(handleWorker(db, ["complete", "--work", workId, "--file", resultFile], execute)).rejects.toThrow();
  const service = new SqliteJobService(db, BOT_ID);
  service.claimJob({ jobId, claimToken: "test-lease" });
  service.completeJob(jobId, {
    status: "completed",
    responseText: "done",
    changedFiles: [],
    artifacts: [],
    startedAt: "2026-08-03 13:00:00",
    endedAt: "2026-08-03 13:01:00",
  });
  const doneOut = await capture(() => handleWorker(db, ["complete", "--force", "--work", workId, "--file", resultFile], execute));
  expect(doneOut.join("\n")).toContain("已完成");
});

test("群聊中触发消息限定发送者：其他成员的最新消息不被选中", async () => {
  env({ NIUBOT_CHAT_TYPE: "group" });
  // 其他成员的最新消息（id 更大）不应被选为触发消息
  db.prepare(
    `INSERT INTO messages (chat_id, sender_id, role, content_text, platform, platform_msg_id, created_at)
     VALUES (?, 'member-b', 'user', '我先说一句', 'feishu', 'om_other_1', datetime('now'))`,
  ).run(CHAT_ID);
  db.prepare(
    `INSERT INTO messages (chat_id, sender_id, role, content_text, platform, platform_msg_id, created_at)
     VALUES (?, ?, 'user', '帮我审查', 'feishu', 'om_mine_1', datetime('now'))`,
  ).run(CHAT_ID, USER_ID);

  const workFile = writeDoc("work.md", "审查任务");
  const workId = (await capture(() => handleWorker(db, ["work", "create", "--file", workFile], execute)))[0]!;
  const workRow = db.prepare("SELECT trigger_msg_platform_id FROM worker_works WHERE id = ?").get(workId) as
    | { trigger_msg_platform_id: string | null }
    | undefined;
  // 选中自己最近的消息（即使时间上不是 chat 最近）
  expect(workRow?.trigger_msg_platform_id).toBe("om_mine_1");
});

test("未知 worker profile 拒绝创建 Job", async () => {
  const workFile = writeDoc("work.md", "任务");
  const workId = (await capture(() => handleWorker(db, ["work", "create", "--file", workFile], execute)))[0]!;
  const jobFile = writeDoc("job.md", "任务内容");
  await expect(handleWorker(db, ["job", "create", "--work", workId, "--worker", "nope", "--file", jobFile], execute))
    .rejects.toThrow("未知 Worker Profile");
});

test("cancel 请求取消 Work", async () => {
  const workFile = writeDoc("work.md", "任务");
  const workId = (await capture(() => handleWorker(db, ["work", "create", "--file", workFile], execute)))[0]!;
  const out = await capture(() => handleWorker(db, ["cancel", workId], execute));
  expect(out.join("\n")).toContain("已请求取消");
});

test("help 输出用法", async () => {
  const out = await capture(() => handleWorker(db, ["help"], execute));
  expect(out.join("\n")).toContain("nbt worker");
  expect(out.join("\n")).toContain("general");
});

test("默认写路径通过 IPC 交给 Pipeline，不直接修改数据库", async () => {
  const endpoint = resolveBotEndpoint(tempRoot, BOT_ID, { unixSocketDirectory: tempRoot });
  const executeWorkerCommand = vi.fn(async () => ({ output: "wrk_from_pipeline" }));
  const handler: ApiHandler = {
    sendMessage: async () => {},
    sendCard: async () => {},
    sendFile: async () => {},
    resolveChatPlatformId: () => undefined,
    getDefaultPlatformChatId: () => undefined,
    executeWorkerCommand,
  };
  const server = new ApiServer(endpoint, handler);
  await server.start();
  vi.stubEnv("NIUBOT_HOME", tempRoot);
  vi.stubEnv("NIUBOT_API_SOCKET", endpoint.address);

  try {
    const workFile = writeDoc("ipc-work.md", "只走 Pipeline");
    const out = await capture(() => handleWorker(db, ["work", "create", "--file", workFile]));
    expect(out).toEqual(["wrk_from_pipeline"]);
    expect(executeWorkerCommand).toHaveBeenCalledWith(CHAT_ID, { type: "work.create", request: "只走 Pipeline" });
    expect((db.prepare("SELECT COUNT(*) AS count FROM worker_works").get() as { count: number }).count).toBe(0);
  } finally {
    server.stop();
  }
});

test("Pipeline 不可用时写操作失败，不回退为直写数据库", async () => {
  const endpoint = resolveBotEndpoint(tempRoot, BOT_ID, { unixSocketDirectory: tempRoot });
  vi.stubEnv("NIUBOT_HOME", tempRoot);
  vi.stubEnv("NIUBOT_API_SOCKET", endpoint.address);
  const workFile = writeDoc("offline-work.md", "不能绕过 Pipeline");

  await expect(handleWorker(db, ["work", "create", "--file", workFile])).rejects.toThrow(/无法连接 NiuBot Pipeline/);
  expect((db.prepare("SELECT COUNT(*) AS count FROM worker_works").get() as { count: number }).count).toBe(0);
});
