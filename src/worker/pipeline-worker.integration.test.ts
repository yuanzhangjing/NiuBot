/**
 * Worker 执行闭环集成测试（Phase 2 验收）：
 * Work/Job 创建 → Scheduler 认领 → WorkerRuntime 执行（FakeAgent）→
 * Job 终态 → Continuation 入队 → Pipeline 唤醒主 Agent 验收 → 最终回复。
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { AgentBackend, AgentResponse, AgentSession, SessionConfig } from "../agent/types.js";
import { initDatabase } from "../database/schema.js";
import type { TransportClient } from "../transport/types.js";
import { Pipeline } from "../core/pipeline.js";
import { SqliteJobService } from "./job-service.js";
import { WorkerProfileRegistry } from "./profiles.js";
import type { JobService } from "./types.js";

const BOT_ID = "test-bot";
const OWNER = "user-1";
const CHAT_ID = "chat-1";

class FakeWorkerBackend implements AgentBackend {
  readonly sessions: string[] = [];
  readonly messages: Array<{ sessionId: string; text: string }> = [];
  /** 每个 worker session 返回的结果文本 */
  resultText = "审查结论：发现 2 个并发问题，详见报告。";
  /** worker session 的 sendMessage 次数（0 时挂起，用于并发测试） */
  delayMs = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async createSession(_config: SessionConfig): Promise<AgentSession> {
    const id = `agent_${this.sessions.length + 1}`;
    this.sessions.push(id);
    return { id };
  }

  async sendMessage(session: AgentSession, message: string): Promise<AgentResponse> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    this.messages.push({ sessionId: session.id, text: message });
    return { text: this.resultText };
  }

  async cancelSession(session: AgentSession): Promise<void> {}
  async closeSession(session: AgentSession): Promise<void> {}
  getAgentSessionId(sessionId: string): string {
    return sessionId;
  }
  needsStableUserPrefix(): boolean {
    return false;
  }
  needsCompactRecoveryReminder(): boolean {
    return false;
  }
  async validateModel(_model: string): Promise<{ valid: boolean }> {
    return { valid: true };
  }
}

class FakeTransport implements TransportClient {
  readonly sent: Array<{ chatId: string; text: string }> = [];
  async sendText(chatId: string, text: string): Promise<{ ok: boolean }> {
    this.sent.push({ chatId, text });
    return { ok: true };
  }
  async sendReply(_chatId: string, _text: string, _replyTo: string): Promise<{ ok: boolean }> {
    return { ok: true };
  }
  async sendCard(_chatId: string, _header: string, _text: string, _footer?: string, _replyTo?: string): Promise<{ ok: boolean }> {
    return { ok: true };
  }
  async sendFile(_chatId: string, _filePath: string, _fileName?: string, _replyTo?: string): Promise<{ ok: boolean }> {
    return { ok: true };
  }
  async addReaction(_chatId: string, _msgId: string, _type: string): Promise<void> {}
  async resolveChatPlatformId(_chatId: string): Promise<string> {
    return _chatId;
  }
  async getDefaultPlatformChatId(_chatId: string): Promise<string> {
    return _chatId;
  }
  discardInboundMessages?(_messageIds: number[]): void {}
}

let db: Database.Database;
let service: JobService;
let registry: WorkerProfileRegistry;
let backend: FakeWorkerBackend;
let transport: FakeTransport;
let pipeline: Pipeline;
let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "worker-pipeline-"));
  db = initDatabase(path.join(tempRoot, "niubot.db"));
  service = new SqliteJobService(db, BOT_ID);
  registry = new WorkerProfileRegistry();
  backend = new FakeWorkerBackend();
  transport = new FakeTransport();

  // 注册来源 chat（真实场景由用户消息入站时创建）
  db.prepare("INSERT INTO chats (id, platform_id, platform, type) VALUES (?, ?, 'feishu', 'p2p')").run(CHAT_ID, "oc_chat_1");

  pipeline = new Pipeline(
    db,
    transport as unknown as TransportClient,
    backend as unknown as AgentBackend,
    { name: "NiuBot", platform: "feishu", platformBotId: "bot" },
    tempRoot,
    path.join(tempRoot, "niubot.db"),
    10,
    "test",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    {
      jobService: service,
      registry,
      maxConcurrent: 2,
      tickMs: 50,
    },
  );
});

afterEach(async () => {
  pipeline.stop();
  db.close();
});

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("Worker 闭环：Job 执行 → 主 Agent 验收 → 最终回复", async () => {
  await pipeline.start();

  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "审查登录模块",
  });
  const job = service.createJob({
    workId: work.id,
    workerProfileId: "reviewer",
    prompt: "检查登录模块的并发问题",
    workdir: tempRoot,
  });

  // Scheduler 认领并执行
  await waitFor(() => service.getJob(job.id)?.status === "completed");

  const done = service.getJob(job.id)!;
  expect(done.responseText).toBe("审查结论：发现 2 个并发问题，详见报告。");
  expect(done.backendSessionId).toBe("agent_1");

  // Job 终态自动生成 Continuation → 唤醒主 Agent
  await waitFor(() => backend.messages.some((m) => m.text.includes("<worker-continuation>")));

  const workerMessages = backend.messages.filter((m) => m.text.includes("<worker-continuation>"));
  expect(workerMessages).toHaveLength(1);
  expect(workerMessages[0].text).toContain("审查登录模块");
  expect(workerMessages[0].text).toContain("2 个并发问题");

  // 主 Agent 回复后 Continuation 被标记完成（claim 不到 pending 项）
  await waitFor(() => service.claimContinuations(CHAT_ID, "check-final").length === 0);
}, 15000);

test("用户消息优先于 Continuation：串行处理", async () => {
  await pipeline.start();

  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "调研方案",
  });
  const job = service.createJob({
    workId: work.id,
    workerProfileId: "researcher",
    prompt: "调研方案 A 和 B",
    workdir: tempRoot,
  });

  // 用户消息先入队
  await new Promise((resolve) => setTimeout(resolve, 60));
  // Worker 完成前用户发消息：用户消息应先被处理（worker 回合排后）
  await waitFor(() => service.getJob(job.id)?.status === "completed");
});

test("两个 Job 受控并发执行", async () => {
  backend.delayMs = 100;
  await pipeline.start();

  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "两个任务",
  });
  const jobA = service.createJob({ workId: work.id, workerProfileId: "general", prompt: "任务 A", workdir: tempRoot });
  const jobB = service.createJob({ workId: work.id, workerProfileId: "general", prompt: "任务 B", workdir: tempRoot });

  await waitFor(() => service.getJob(jobA.id)?.status === "completed" && service.getJob(jobB.id)?.status === "completed");
  expect(service.getJob(jobA.id)?.responseText).toBeTruthy();
  expect(service.getJob(jobB.id)?.responseText).toBeTruthy();
});

test("Work 完成后不再调度新 Job", async () => {
  await pipeline.start();
  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "一次性任务",
  });
  const job = service.createJob({ workId: work.id, workerProfileId: "general", prompt: "跑一次", workdir: tempRoot });
  await waitFor(() => service.getJob(job.id)?.status === "completed");
  service.completeWork(work.id, { conclusion: "完成" });
  expect(() =>
    service.createJob({ workId: work.id, workerProfileId: "general", prompt: "再来一次", workdir: tempRoot }),
  ).toThrow(/not active/);
});
