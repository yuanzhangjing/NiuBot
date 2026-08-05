/**
 * Worker 执行闭环集成测试（Phase 2 验收）：
 * Work/Job 创建 → Scheduler 认领 → WorkerRuntime 执行（FakeAgent）→
 * Job 终态 → Continuation 入队 → Pipeline 唤醒主 Agent 验收 → 最终回复。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { AgentBackend, AgentResponse, AgentSession, SessionConfig, SessionTranscript } from "../agent/types.js";
import { initDatabase } from "../database/schema.js";
import type { TransportClient } from "../transport/types.js";
import { Pipeline } from "../core/pipeline.js";
import type { InboundDelivery } from "../transport/types.js";
import { SqliteJobService } from "./job-service.js";
import { WorkerProfileRegistry } from "./profiles.js";
import { TeamConfigStore } from "./team-config.js";
import type { JobService } from "./types.js";

const BOT_ID = "test-bot";
const OWNER = "user-1";
const CHAT_ID = "chat-1";

class FakeWorkerBackend implements AgentBackend {
  readonly sessions: string[] = [];
  readonly sessionModels: string[] = [];
  readonly messages: Array<{ sessionId: string; text: string }> = [];
  readonly sessionDirs = new Map<string, string>();
  /** 每个 worker session 返回的结果文本 */
  resultText = "审查结论：发现 2 个并发问题，详见报告。";
  /** worker session 的 sendMessage 次数（0 时挂起，用于并发测试） */
  delayMs = 0;
  createSessionDelayMs = 0;
  /** 非空时 sendMessage 在工作目录写入该文件（模拟写任务） */
  writeFileOnSend?: string;
  liveTranscriptPath?: string;
  inspectCalls = 0;
  /** 在返回响应前模拟 Agent 的同步副作用（如验收时 complete Work）。 */
  onSendMessage?: (session: AgentSession, message: string) => void | Promise<void>;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async createSession(config: SessionConfig): Promise<AgentSession> {
    if (this.createSessionDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.createSessionDelayMs));
    }
    const id = `agent_${this.sessions.length + 1}`;
    this.sessions.push(id);
    this.sessionModels.push(config.model ?? "");
    this.sessionDirs.set(id, config.workingDirectory ?? process.cwd());
    return { id };
  }

  async sendMessage(session: AgentSession, message: string): Promise<AgentResponse> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.writeFileOnSend) {
      writeFileSync(path.join(this.sessionDirs.get(session.id)!, this.writeFileOnSend), "changed by worker\n");
    }
    this.messages.push({ sessionId: session.id, text: message });
    await this.onSendMessage?.(session, message);
    return { text: this.resultText };
  }

  async cancelSession(session: AgentSession): Promise<void> {}
  async closeSession(session: AgentSession): Promise<void> {}
  getAgentSessionId(sessionId: string): string {
    return sessionId;
  }
  async inspectSessionTranscript(session: AgentSession): Promise<SessionTranscript> {
    this.inspectCalls++;
    if (!this.liveTranscriptPath) throw new Error("transcript not ready");
    return {
      backend: "codex",
      agentSessionId: session.id,
      events: [],
      sources: [{ path: this.liveTranscriptPath, role: "session" }],
    };
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
  failCardAttempts = 0;
  onSendText?: (text: string) => void | Promise<void>;
  private nextMessageId = 1;
  private messageId(): string {
    return `pm_test_${this.nextMessageId++}`;
  }
  async sendText(chatId: string, text: string): Promise<string> {
    this.sent.push({ chatId, text });
    await this.onSendText?.(text);
    return this.messageId();
  }
  async sendReply(chatId: string, text: string, _replyTo: string): Promise<string> {
    this.sent.push({ chatId, text });
    return this.messageId();
  }
  async sendMarkdownCard(chatId: string, text: string): Promise<string> {
    this.sent.push({ chatId, text });
    return this.messageId();
  }
  async sendCard(chatId: string, _header: string, text: string, _footer?: string, _replyTo?: string): Promise<string> {
    if (this.failCardAttempts > 0) {
      this.failCardAttempts--;
      throw new Error("card send failed");
    }
    this.sent.push({ chatId, text });
    return this.messageId();
  }
  async sendFile(_chatId: string, _filePath: string, _fileName?: string): Promise<string> {
    return this.messageId();
  }
  async editMessage(): Promise<void> {}
  async addReaction(_chatId: string, _msgId: string, _type: string): Promise<void> {}
  async removeReaction(_chatId: string, _msgId: string, _type: string): Promise<void> {}
  async getBotOpenId(): Promise<string> { return "bot"; }
  async getBotName(): Promise<string> { return "NiuBot"; }
  async getChatName(): Promise<string> { return "test-chat"; }
  async getMessageContent(): Promise<string | undefined> { return undefined; }
  async getAppCreatorId(): Promise<string | undefined> { return undefined; }
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
let teamConfig: TeamConfigStore;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "worker-pipeline-"));
  db = initDatabase(path.join(tempRoot, "niubot.db"));
  service = new SqliteJobService(db, BOT_ID);
  registry = new WorkerProfileRegistry();
  backend = new FakeWorkerBackend();
  transport = new FakeTransport();
  teamConfig = new TeamConfigStore(db, BOT_ID);
  teamConfig.setEnabled(true);

  // 注册来源 chat（真实场景由用户消息入站时创建）
  db.prepare("INSERT INTO chats (id, platform_id, platform, type) VALUES (?, ?, 'feishu', 'p2p')").run(CHAT_ID, "oc_chat_1");

  pipeline = new Pipeline(
    db,
    transport as unknown as TransportClient,
    backend as unknown as AgentBackend,
    { name: BOT_ID, platform: "feishu", platformBotId: "bot" },
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
      workspaceRoot: path.join(tempRoot, "ws"),
      teamConfigStore: teamConfig,
    },
  );
  // 集成测试不经过真实 agent 环境注入，直接预置主会话能力令牌。
  (pipeline as any).chatScheduleTokens.set(CHAT_ID, "integration-token");
});

afterEach(async () => {
  pipeline.stop();
  await waitFor(() => ((pipeline as any).workerRuntime?.runningCount() ?? 0) === 0, 5000);
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
  await waitFor(() => backend.messages.some((m) => m.text.startsWith("<worker-continuation>")));

  const workerMessages = backend.messages.filter((m) => m.text.includes("<worker-continuation>"));
  expect(workerMessages).toHaveLength(1);
  expect(workerMessages[0].text).toContain("审查登录模块");
  expect(workerMessages[0].text).toContain("2 个并发问题");

  // 主 Agent 回复后 Continuation 必须真正进入 completed，而不只是 claimed。
  await waitFor(() => service.listEvents(work.id).some((event) => event.event === "continuation_completed"));
  // Worker 结果交付：末尾带固定标识（不依赖 LLM 自觉）
  expect(transport.sent.some((m) => m.text.includes("⚙️ 本回复基于 Worker 后台任务结果整理"))).toBe(true);
  expect(service.getWork(work.id)?.status).toBe("completed");
  expect(service.getWork(work.id)?.finalConclusion).toContain("审查结论");
}, 15000);

test("验收回合创建后续 Job 时 Work 保持 active，最后一次交付后自动完成", async () => {
  await pipeline.start();
  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "分两步处理",
  });
  const firstJob = service.createJob({
    workId: work.id,
    workerProfileId: "researcher",
    prompt: "先调查",
    workdir: tempRoot,
  });
  let followupJobId: string | undefined;
  let releaseFirstReview!: () => void;
  const firstReviewGate = new Promise<void>((resolve) => { releaseFirstReview = resolve; });
  backend.onSendMessage = async (_session, message) => {
    if (!message.includes("<worker-continuation>") || followupJobId) return;
    const followup = service.createJob({
      workId: work.id,
      workerProfileId: "tester",
      prompt: "根据调查结果复核",
      workdir: tempRoot,
    });
    followupJobId = followup.id;
    await firstReviewGate;
  };

  await waitFor(() => service.getJob(firstJob.id)?.status === "completed");
  await waitFor(() => !!followupJobId);
  expect(service.getWork(work.id)?.status).toBe("active");
  releaseFirstReview();

  await waitFor(() => service.getJob(followupJobId!)?.status === "completed");
  await waitFor(() => service.getWork(work.id)?.status === "completed", 8_000);
  expect(service.listEvents(work.id).filter((event) => event.event === "continuation_completed")).toHaveLength(2);
}, 15_000);

test("Worker 运行中持久化 session 日志引用，短任务结束前也会最后捕获", async () => {
  backend.delayMs = 1_300;
  backend.liveTranscriptPath = path.join(tempRoot, "worker-live.jsonl");
  writeFileSync(backend.liveTranscriptPath, "{\"type\":\"response_item\"}\n");
  await pipeline.start();
  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "观察 Worker 进展",
  });
  const job = service.createJob({
    workId: work.id,
    workerProfileId: "researcher",
    prompt: "运行一会儿并保留日志",
    workdir: tempRoot,
  });

  await waitFor(() => service.getJob(job.id)?.status === "running");
  await waitFor(() => !!service.getJob(job.id)?.backendSessionId, 3_000);
  const running = service.getJob(job.id)!;
  expect(running.status).toBe("running");
  expect(running.backendType).toBe("codex");
  expect(JSON.parse(running.transcriptSourcesJson)).toEqual([
    expect.objectContaining({ path: backend.liveTranscriptPath, role: "session" }),
  ]);
  expect(backend.inspectCalls).toBeGreaterThan(0);
  await waitFor(() => service.getJob(job.id)?.status === "completed", 5_000);
  expect(service.getJob(job.id)?.backendSessionId).toBe("agent_1");
}, 10_000);

test("存在运行中的 Work 时，普通用户消息回复不带 Worker 交付标识", async () => {
  await pipeline.start();
  service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "后台调研",
  });

  (pipeline as any).handleMessage({
    senderPlatformId: "user-open-id",
    senderName: "admin",
    chatPlatformId: "oc_chat_1",
    chatType: "p2p",
    contentText: "普通问题",
    contentType: "text",
    timestamp: new Date(),
    platformMsgId: "ordinary-user-message",
    platformTs: Date.now(),
    raw: {},
  } as any);

  await waitFor(() => transport.sent.length > 0);
  expect(transport.sent.every((m) => !m.text.includes("⚙️ 本回复基于 Worker 后台任务结果整理"))).toBe(true);
  expect(transport.sent.every((m) => !m.text.includes("⚙️ 已交由 Worker 后台执行"))).toBe(true);
}, 15000);

test("普通用户回合中给已有 Work 新建 Job 时，派工回复带派工标识", async () => {
  // 本测试只验证出站识别；暂停 Scheduler，避免新 Job 在断言期间异步执行。
  teamConfig.setEnabled(false);
  const existingWork = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "已有后台任务",
  });
  service.createJob({
    workId: existingWork.id,
    workerProfileId: "general",
    prompt: "已有 Job",
    workdir: tempRoot,
  });
  await pipeline.start();
  backend.onSendMessage = (_session, message) => {
    if (!message.includes("<worker-continuation>")) {
      service.createJob({
        workId: existingWork.id,
        workerProfileId: "general",
        prompt: "本回合追加的 Job",
        workdir: tempRoot,
      });
    }
  };

  (pipeline as any).handleMessage({
    senderPlatformId: "user-open-id",
    senderName: "admin",
    chatPlatformId: "oc_chat_1",
    chatType: "p2p",
    contentText: "请派 Worker 调研",
    contentType: "text",
    timestamp: new Date(),
    platformMsgId: "dispatch-user-message",
    platformTs: Date.now(),
    raw: {},
  } as any);

  await waitFor(() => transport.sent.length > 0);
  const response = transport.sent.at(-1)?.text ?? "";
  expect(response).toContain("⚙️ 已交由 Worker 后台执行");
  expect(response).not.toContain("⚙️ 本回复基于 Worker 后台任务结果整理");
}, 15000);

test("普通用户回合只创建空 Work 时，不追加派工标识", async () => {
  teamConfig.setEnabled(false);
  await pipeline.start();
  backend.onSendMessage = (_session, message) => {
    if (!message.includes("<worker-continuation>")) {
      service.createWork({
        botId: BOT_ID,
        ownerUserId: OWNER,
        sourceChatId: CHAT_ID,
        visibility: "private",
        request: "只有 Work，没有 Job",
      });
    }
  };

  (pipeline as any).handleMessage({
    senderPlatformId: "user-open-id",
    senderName: "admin",
    chatPlatformId: "oc_chat_1",
    chatType: "p2p",
    contentText: "创建空 Work",
    contentType: "text",
    timestamp: new Date(),
    platformMsgId: "empty-work-message",
    platformTs: Date.now(),
    raw: {},
  } as any);

  await waitFor(() => transport.sent.length > 0);
  expect(transport.sent.at(-1)?.text).not.toContain("⚙️ 已交由 Worker 后台执行");
}, 15000);

test("主 Agent 的 Worker 写操作由 Pipeline 活动回合统一校验和执行", async () => {
  await pipeline.start();
  let workId: string | undefined;
  let jobId: string | undefined;
  backend.onSendMessage = async (_session, message) => {
    if (!message.includes("请通过 Pipeline 派工") || message.includes("<worker-continuation>")) return;
    const work = await pipeline.executeWorkerAgentCommand({
      chatId: CHAT_ID,
      scheduleToken: "integration-token",
      command: { type: "work.create", request: "统一写入口验证" },
    });
    workId = work.output;
    const duplicateWork = await pipeline.executeWorkerAgentCommand({
      chatId: CHAT_ID,
      scheduleToken: "integration-token",
      command: { type: "work.create", request: "统一写入口验证" },
    });
    expect(duplicateWork.output).toBe(workId);
    const job = await pipeline.executeWorkerAgentCommand({
      chatId: CHAT_ID,
      scheduleToken: "integration-token",
      command: {
        type: "job.create",
        workId,
        workerProfileId: "reviewer",
        prompt: "检查状态流转",
        idempotencyKey: `test:${workId}:review`,
      },
    });
    jobId = job.output;
  };

  (pipeline as any).handleMessage({
    senderPlatformId: "user-open-id",
    senderName: "admin",
    chatPlatformId: "oc_chat_1",
    chatType: "p2p",
    contentText: "请通过 Pipeline 派工",
    contentType: "text",
    timestamp: new Date(),
    platformMsgId: "pipeline-dispatch-message",
    platformTs: Date.now(),
    raw: {},
  } as any);

  await waitFor(() => !!jobId);
  expect(service.getWork(workId!)).toMatchObject({ sourceChatId: CHAT_ID, visibility: "private" });
  expect(service.getJob(jobId!)).toMatchObject({
    workId,
    workerProfileId: "reviewer",
    workspacePolicy: "read_only",
  });
  await waitFor(() => transport.sent.some((message) => message.text.includes("⚙️ 已交由 Worker 后台执行")));
}, 15_000);

test("Pipeline 拒绝活动回合外写入和提升 Worker 工作区权限", async () => {
  await expect(pipeline.executeWorkerAgentCommand({
    chatId: CHAT_ID,
      scheduleToken: "integration-token",
    command: { type: "work.create", request: "绕过活动回合" },
  })).rejects.toThrow(/活动 Agent 回合/);

  await pipeline.start();
  let policyError: string | undefined;
  let accessError: string | undefined;
  let policyWorkId: string | undefined;
  const foreignWork = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: "other-chat",
    visibility: "public",
    request: "其他会话的任务",
  });
  backend.onSendMessage = async (_session, message) => {
    if (!message.includes("测试权限提升") || message.includes("<worker-continuation>")) return;
    const work = await pipeline.executeWorkerAgentCommand({
      chatId: CHAT_ID,
      scheduleToken: "integration-token",
      command: { type: "work.create", request: "权限边界验证" },
    });
    policyWorkId = work.output;
    try {
      await pipeline.executeWorkerAgentCommand({
        chatId: CHAT_ID,
      scheduleToken: "integration-token",
        command: {
          type: "job.create",
          workId: work.output,
          workerProfileId: "reviewer",
          prompt: "不应获得写权限",
          workspacePolicy: "git_worktree",
          idempotencyKey: `test:${work.output}:escalation`,
        },
      });
    } catch (error) {
      policyError = String(error);
    }
    try {
      await pipeline.executeWorkerAgentCommand({
        chatId: CHAT_ID,
      scheduleToken: "integration-token",
        command: { type: "cancel", id: foreignWork.id },
      });
    } catch (error) {
      accessError = String(error);
    }
  };

  (pipeline as any).handleMessage({
    senderPlatformId: "user-open-id",
    senderName: "admin",
    chatPlatformId: "oc_chat_1",
    chatType: "p2p",
    contentText: "测试权限提升",
    contentType: "text",
    timestamp: new Date(),
    platformMsgId: "pipeline-policy-message",
    platformTs: Date.now(),
    raw: {},
  } as any);

  await waitFor(() => !!policyError && !!accessError);
  expect(policyError).toMatch(/不能使用 git_worktree/);
  expect(accessError).toMatch(/不属于当前会话/);
  await waitFor(() => service.getWork(policyWorkId!)?.status === "failed");
  expect(service.getWork(policyWorkId!)?.finalConclusion).toContain("空 Work");
}, 15_000);

test("Pipeline 人工完成入口必须在服务端再次确认 force", async () => {
  await pipeline.start();
  let forceError: string | undefined;
  backend.onSendMessage = async (_session, message) => {
    if (!message.includes("测试人工完成确认") || message.includes("<worker-continuation>")) return;
    const work = await pipeline.executeWorkerAgentCommand({
      chatId: CHAT_ID,
      scheduleToken: "integration-token",
      command: { type: "work.create", request: "人工完成确认" },
    });
    try {
      await pipeline.executeWorkerAgentCommand({
        chatId: CHAT_ID,
      scheduleToken: "integration-token",
        command: { type: "work.complete_recovery", workId: work.output, conclusion: "不应完成" } as any,
      });
    } catch (error) {
      forceError = String(error);
    }
  };

  (pipeline as any).handleMessage({
    senderPlatformId: "user-open-id",
    senderName: "admin",
    chatPlatformId: "oc_chat_1",
    chatType: "p2p",
    contentText: "测试人工完成确认",
    contentType: "text",
    timestamp: new Date(),
    platformMsgId: "pipeline-force-message",
    platformTs: Date.now(),
    raw: {},
  } as any);

  await waitFor(() => !!forceError);
  expect(forceError).toMatch(/force=true/);
}, 15_000);

test("Pipeline 取消排队 Job 时立即确认终态，不等待调度轮询", async () => {
  teamConfig.setEnabled(false);
  await pipeline.start();
  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "public",
    request: "取消排队任务",
  });
  const job = service.createJob({
    workId: work.id,
    workerProfileId: "reviewer",
    prompt: "尚未开始",
    workdir: tempRoot,
  });
  backend.onSendMessage = async (_session, message) => {
    if (!message.includes("取消后台任务")) return;
    await pipeline.executeWorkerAgentCommand({
      chatId: CHAT_ID,
      scheduleToken: "integration-token",
      command: { type: "cancel", id: work.id },
    });
  };

  (pipeline as any).handleMessage({
    senderPlatformId: "user-open-id",
    senderName: "admin",
    chatPlatformId: "oc_chat_1",
    chatType: "p2p",
    contentText: "取消后台任务",
    contentType: "text",
    timestamp: new Date(),
    platformMsgId: "pipeline-cancel-message",
    platformTs: Date.now(),
    raw: {},
  } as any);

  await waitFor(() => service.getJob(job.id)?.status === "cancelled");
  expect(service.getWork(work.id)?.status).toBe("cancelled");
}, 15_000);

test("多 Job Work：中间 Job 完成时验收回合静默，全部完成后统一交付", async () => {
  backend.delayMs = 400;
  await pipeline.start();

  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "多 Job 验证",
  });
  const jobA = service.createJob({
    workId: work.id,
    workerProfileId: "researcher",
    prompt: "第一步",
    workdir: tempRoot,
  });
  // jobB/jobC 依赖 jobA：jobA 完成时它们还在 queued → jobA 的验收回合应静默
  const jobB = service.createJob({
    workId: work.id,
    workerProfileId: "researcher",
    prompt: "第二步",
    workdir: tempRoot,
    dependsOn: [jobA.id],
  });
  const jobC = service.createJob({
    workId: work.id,
    workerProfileId: "researcher",
    prompt: "第三步",
    workdir: tempRoot,
    dependsOn: [jobB.id],
  });

  // jobA 完成 → 其 Continuation 回合静默（Work 还有 queued Job），不向用户发消息
  await waitFor(() => service.getJob(jobA.id)?.status === "completed");
  await waitFor(() => service.claimContinuations(CHAT_ID, "check-silent").length === 0);
  const sentAfterFirst = transport.sent.length;

  // jobB、jobC 依次完成后，最终回合才交付（等 transport 收到新消息）
  await waitFor(() => service.getJob(jobB.id)?.status === "completed");
  await waitFor(() => service.getJob(jobC.id)?.status === "completed");
  await waitFor(() => transport.sent.length > sentAfterFirst);
  expect(transport.sent.length).toBeGreaterThan(sentAfterFirst);
}, 20000);

test("同批多个 Work 混合完成状态时交付已完成 Work，不被运行中 Work 整批静默", async () => {
  await pipeline.start();

  const workA = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "仍在执行的任务",
  });
  const jobAResult = service.createJob({
    workId: workA.id,
    workerProfileId: "researcher",
    prompt: "已完成的阶段",
    workdir: tempRoot,
  });
  const jobARunning = service.createJob({
    workId: workA.id,
    workerProfileId: "tester",
    prompt: "仍在运行的阶段",
    workdir: tempRoot,
  });
  service.claimJob({ jobId: jobAResult.id, claimToken: "manual-a-result" });
  service.claimJob({ jobId: jobARunning.id, claimToken: "manual-a-running" });
  service.completeJob(jobAResult.id, {
    status: "completed",
    responseText: "A 的阶段结果",
    changedFiles: [],
    artifacts: [],
    startedAt: "2026-08-03 13:00:00",
    endedAt: "2026-08-03 13:01:00",
  });

  const workB = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "已经完成的任务",
  });
  const jobB = service.createJob({
    workId: workB.id,
    workerProfileId: "researcher",
    prompt: "完整结果",
    workdir: tempRoot,
  });
  service.claimJob({ jobId: jobB.id, claimToken: "manual-b" });
  service.completeJob(jobB.id, {
    status: "completed",
    responseText: "B 的最终结果",
    changedFiles: [],
    artifacts: [],
    startedAt: "2026-08-03 13:00:00",
    endedAt: "2026-08-03 13:01:00",
  });

  await waitFor(() => service.getWork(workB.id)?.status === "completed", 8_000);
  expect(transport.sent.some((message) => message.text.includes("⚙️ 本回复基于 Worker 后台任务结果整理"))).toBe(true);
  expect(service.getWork(workA.id)?.status).toBe("active");
  expect(service.getJob(jobARunning.id)?.status).toBe("running");
}, 15_000);

test("用户消息与 Continuation 由同一队列串行处理", async () => {
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

  // 保持任务运行一段时间，确认 Worker 完成后 Continuation 可进入同一串行队列
  await new Promise((resolve) => setTimeout(resolve, 60));
  await waitFor(() => service.getJob(job.id)?.status === "completed");
});

test("Worker 正文发送失败时不完成 Continuation，后续重试成功后才完成", async () => {
  transport.failCardAttempts = 1;
  let fallbackStarted = false;
  let releaseFallback!: () => void;
  const fallbackGate = new Promise<void>((resolve) => { releaseFallback = resolve; });
  transport.onSendText = async (text) => {
    if (!text.startsWith("发送失败：")) return;
    fallbackStarted = true;
    await fallbackGate;
  };
  await pipeline.start();

  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "发送失败重试",
  });
  const job = service.createJob({
    workId: work.id,
    workerProfileId: "researcher",
    prompt: "生成结果",
    workdir: tempRoot,
  });

  await waitFor(() => service.getJob(job.id)?.status === "completed");
  await waitFor(() => fallbackStarted);
  expect(service.getWork(work.id)?.status).toBe("active");
  releaseFallback();
  await waitFor(() => {
    const row = db.prepare("SELECT status FROM agent_continuations WHERE work_id = ?").get(work.id) as { status: string } | undefined;
    return row?.status === "completed";
  }, 5000);

  expect(transport.sent.some((m) => m.text.startsWith("发送失败："))).toBe(true);
  expect(transport.sent.some((m) => m.text.includes("⚙️ 本回复基于 Worker 后台任务结果整理"))).toBe(true);
  expect(service.getWork(work.id)?.status).toBe("completed");
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

test("Worker 在 session 创建前也计入 busy，关闭流程不会提前关 DB", async () => {
  backend.createSessionDelayMs = 500;
  await pipeline.start();

  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "pre-session busy",
  });
  const job = service.createJob({
    workId: work.id,
    workerProfileId: "general",
    prompt: "慢速创建 session",
    workdir: tempRoot,
  });

  await waitFor(() => service.getJob(job.id)?.status === "running");
  expect(backend.sessions).toHaveLength(0);
  expect(pipeline.hasBusyChats()).toBe(true);
  await waitFor(() => service.getJob(job.id)?.status === "completed", 5000);
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

test("重启恢复：running Job 标记 interrupted，claimed Continuation 重新投递", async () => {
  backend.delayMs = 5000;
  await pipeline.start();

  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "重启恢复任务",
  });
  const job = service.createJob({ workId: work.id, workerProfileId: "general", prompt: "慢任务", workdir: tempRoot });

  // 等 Job 进入 running（Fake 挂起 5s，保证 Engine "重启" 时仍 running）
  await waitFor(() => service.getJob(job.id)?.status === "running");
  // 模拟主 Agent 回合被中断：伪造一条 claimed 状态的 Continuation
  db.prepare(`
    INSERT INTO agent_continuations (id, bot_id, chat_id, dedupe_key, kind, work_id, job_ids_json, status, created_at)
    VALUES (?, ?, ?, ?, 'job_terminal', ?, ?, 'claimed', datetime('now'))
  `).run("ctn_interrupted", BOT_ID, CHAT_ID, `work:${work.id}:job:${job.id}:terminal`, work.id, JSON.stringify([job.id]));
  const messagesBefore = backend.messages.length;

  // 模拟重启：停掉第一个 Pipeline（挂着的 worker 回合仍会完成，但终态已被 recover 接管）
  pipeline.stop();
  backend.delayMs = 0;

  // 新 Pipeline 实例（同一数据库）→ 启动恢复
  const pipeline2 = new Pipeline(
    db,
    transport as unknown as TransportClient,
    backend as unknown as AgentBackend,
    { name: BOT_ID, platform: "feishu", platformBotId: "bot" },
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
    { jobService: service, registry, maxConcurrent: 2, tickMs: 50, workspaceRoot: path.join(tempRoot, "ws") },
  );
  await pipeline2.start();

  try {
    // running Job → interrupted，Work 计数 +1
    await waitFor(() => service.getJob(job.id)?.status === "interrupted");
    expect(service.getWork(work.id)?.interruptedCount).toBe(1);

    // claimed Continuation → pending → 重新投递 → 主 Agent 验收回合
    await waitFor(() => backend.messages.length > messagesBefore);
    const redelivered = backend.messages
      .slice(messagesBefore)
      .some((m) => m.text.includes("<worker-continuation>"));
    expect(redelivered).toBe(true);

    // 验收完成后 Continuation 被标记完成
    await waitFor(() => service.claimContinuations(CHAT_ID, "final").length === 0);
  } finally {
    pipeline2.stop();
  }
}, 20000);

function makeGitRepo(): string {
  mkdirSync(path.join(tempRoot, "repo"), { recursive: true });
  const repo = realpathSync(path.join(tempRoot, "repo"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
  writeFileSync(path.join(repo, "a.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  return repo;
}

test("写任务：developer 在独立工作目录修改代码，不污染目标仓库", async () => {
  const repo = makeGitRepo();
  backend.writeFileOnSend = "b.txt";
  await pipeline.start();

  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "在 repo 里新增 b.txt",
  });
  const job = service.createJob({
    workId: work.id,
    workerProfileId: "developer",
    prompt: "新增 b.txt 文件",
    workdir: repo,
    workspacePolicy: "git_worktree",
  });

  await waitFor(() => service.getJob(job.id)?.status === "completed");
  expect(service.getJob(job.id)?.responseText).toBeTruthy();

  // 目标仓库主工作区没有 b.txt（写入发生在独立工作目录）
  expect(existsSync(path.join(repo, "b.txt"))).toBe(false);

  // 独立工作目录保留且包含写入的文件 + marker（git_worktree 已废弃自动 worktree，按 scratch 处理）
  const workDir = path.join(tempRoot, "ws", `job-${job.id}`);
  expect(existsSync(path.join(workDir, "b.txt"))).toBe(true);
  expect(existsSync(path.join(workDir, ".niubot-worker"))).toBe(true);
}, 15000);

test("两个写 Job 在独立工作目录并行执行，互不污染目标仓库", async () => {
  const repo = makeGitRepo();
  backend.delayMs = 3000;
  await pipeline.start();

  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "两个写任务",
  });
  const jobA = service.createJob({
    workId: work.id,
    workerProfileId: "developer",
    prompt: "任务 A",
    workdir: repo,
    workspacePolicy: "git_worktree",
  });
  const jobB = service.createJob({
    workId: work.id,
    workerProfileId: "developer",
    prompt: "任务 B",
    workdir: repo,
    workspacePolicy: "git_worktree",
  });

  // 各自独立工作目录，可并行执行，均正常完成
  await waitFor(() => service.getJob(jobA.id)?.status === "completed");
  await waitFor(() => service.getJob(jobB.id)?.status === "completed");
  // 目标仓库主工作区不受污染
  expect(existsSync(path.join(repo, "b.txt"))).toBe(false);
}, 15000);

test("Worker 暂停时 queued Job 不调度，开启后执行", async () => {
  teamConfig.setEnabled(false);
  await pipeline.start();

  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "开关测试",
  });
  const job = service.createJob({ workId: work.id, workerProfileId: "general", prompt: "任务", workdir: tempRoot });

  // 关闭状态：等待数个 tick 仍是 queued
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(service.getJob(job.id)?.status).toBe("queued");

  // 开启后调度执行
  teamConfig.setEnabled(true);
  await waitFor(() => service.getJob(job.id)?.status === "completed");
});

function userDelivery(chatId: string, text: string, seq: number): InboundDelivery {
  return {
    inboxId: seq,
    claimToken: `claim-${seq}`,
    replayed: false,
    message: {
      senderPlatformId: "ou_user",
      senderName: "User",
      chatPlatformId: `oc_${chatId}`,
      chatType: "p2p",
      contentText: text,
      contentType: "text",
      timestamp: new Date(),
      platformMsgId: `msg-${seq}`,
      platformTs: Date.now(),
    },
  };
}

test("延续性 Job 自动注入同 Work 前序结果和检索入口", async () => {
  await pipeline.start();

  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "延续任务",
  });
  const workerMessagesBefore = backend.messages.length;
  const jobA = service.createJob({ workId: work.id, workerProfileId: "researcher", prompt: "第一步调研", workdir: tempRoot });
  const jobB = service.createJob({
    workId: work.id,
    workerProfileId: "researcher",
    prompt: "基于第一步继续",
    workdir: tempRoot,
    dependsOn: [jobA.id],
  });
  await waitFor(() => service.getJob(jobA.id)?.status === "completed");

  await waitFor(() => service.getJob(jobB.id)?.status === "completed");

  const jobBPrompt = backend.messages.slice(workerMessagesBefore).find((m) => m.text.includes("基于第一步继续"));
  expect(jobBPrompt).toBeTruthy();
  expect(jobBPrompt!.text).toContain("<previous-work>");
  expect(jobBPrompt!.text).toContain(jobA.id);
  expect(jobBPrompt!.text).toContain(backend.resultText);
  expect(jobBPrompt!.text).toContain("<history-access>");
  expect(jobBPrompt!.text).toContain("nbt sessions search");
});

test("Worker 暂停时注入停用指令；开启时派工说明走技能不再注入", async () => {
  teamConfig.setEnabled(false);
  await pipeline.start();

  // 暂停状态：注入停用指令（不包含派工命令）
  pipeline.handleInbound(userDelivery(CHAT_ID, "你好", 1));
  await waitFor(() => backend.messages.some((m) => m.text.includes("你好")));
  const first = backend.messages.find((m) => m.text.includes("你好"))!;
  expect(first.text).toContain("Worker 当前已暂停");
  expect(first.text).not.toContain("nbt worker job create");

  // 开启：派工说明已 skill 化（skills/nbt-tools），不注入，由 agent CLI 按需加载
  teamConfig.setEnabled(true);
  pipeline.handleInbound(userDelivery(CHAT_ID, "帮我调研一下", 2));
  await waitFor(() => backend.messages.some((m) => m.text.includes("帮我调研一下")));
  const second = backend.messages.find((m) => m.text.includes("帮我调研一下"))!;
  expect(second.text).not.toContain("nbt worker job create");
  expect(second.text).not.toContain("Worker 当前已暂停");
});

test("配置应用后 registry 热更新（新 profile 可用）", async () => {
  teamConfig.setEnabled(true);
  await pipeline.start();
  expect(registry.list().some((p) => p.id === "custom-reviewer")).toBe(false);

  const draft = teamConfig.createDraft(`maxConcurrent: 2
profiles:
  - id: custom-reviewer
    description: 自定义审查
    access: read_only
    prompt: 审查。
`, "u1");
  expect(draft.ok).toBe(true);
  const applied = teamConfig.applyDraft(draft.ok ? draft.draftId : "", "u1");
  expect(applied.ok).toBe(true);

  // 配置版本变化后热更新（等价于 watchdog 轮询感知 CLI apply）
  pipeline.reloadTeamConfigIfChanged();
  expect(registry.list().some((p) => p.id === "custom-reviewer")).toBe(true);
  expect(registry.get("custom-reviewer")?.access).toBe("read_only");
});

test("角色配置 backend 时使用专属 backend，否则复用主 Agent backend", async () => {
  // 专属 backend：独立的 FakeWorkerBackend 实例
  const specialBackend = new FakeWorkerBackend();
  specialBackend.resultText = "专属后端结果";
  pipeline.stop();
  pipeline = new Pipeline(
    db,
    transport as unknown as TransportClient,
    backend as unknown as AgentBackend,
    { name: BOT_ID, platform: "feishu", platformBotId: "bot" },
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
      workspaceRoot: path.join(tempRoot, "ws"),
      teamConfigStore: teamConfig,
      resolveBackend: async (type) => (type === "special" ? specialBackend : backend),
    },
  );
  // 注册一个配置了 backend + model 的自定义角色
  registry.setProfiles([
    ...registry.list(),
    {
      id: "special-role",
      displayName: "Special",
      description: "",
      prompt: "你是专用后端角色",
      access: "read_only",
      backend: "special",
      model: "special-model",
    },
  ]);
  await pipeline.start();

  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "验证 backend 解析",
  });
  // 专属角色 Job → specialBackend；普通角色 Job → 主 backend
  const specialJob = service.createJob({
    workId: work.id,
    workerProfileId: "special-role",
    prompt: "用专属后端执行",
    workdir: tempRoot,
  });
  const normalJob = service.createJob({
    workId: work.id,
    workerProfileId: "researcher",
    prompt: "用主后端执行",
    workdir: tempRoot,
  });

  await waitFor(() => service.getJob(specialJob.id)?.status === "completed");
  await waitFor(() => service.getJob(normalJob.id)?.status === "completed");

  expect(service.getJob(specialJob.id)?.responseText).toBe("专属后端结果");
  expect(service.getJob(normalJob.id)?.responseText).toBe(backend.resultText);
  // 专属 backend 确实被使用（session 被创建），且收到角色配置的 model；
  // 普通角色走主 backend（session 模型为全局 model——本测试 botIdentity 无 model → 空）
  expect(specialBackend.sessions).toHaveLength(1);
  expect(specialBackend.sessionModels).toEqual(["special-model"]);
  expect(backend.sessions).toContain(service.getJob(normalJob.id)?.backendSessionId);
}, 15000);

test("未知 backend 类型：Job 失败且错误带角色上下文", async () => {
  pipeline.stop();
  pipeline = new Pipeline(
    db,
    transport as unknown as TransportClient,
    backend as unknown as AgentBackend,
    { name: BOT_ID, platform: "feishu", platformBotId: "bot" },
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
      workspaceRoot: path.join(tempRoot, "ws"),
      teamConfigStore: teamConfig,
      resolveBackend: async (type) => {
        throw new Error(`Backend '${type}' is unavailable`);
      },
    },
  );
  registry.setProfiles([
    ...registry.list(),
    {
      id: "broken-role",
      displayName: "Broken",
      description: "",
      prompt: "坏角色",
      access: "read_only",
      backend: "nope",
    },
  ]);
  await pipeline.start();

  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "验证 backend 解析失败",
  });
  const brokenJob = service.createJob({
    workId: work.id,
    workerProfileId: "broken-role",
    prompt: "不该执行",
    workdir: tempRoot,
  });

  await waitFor(() => service.getJob(brokenJob.id)?.status === "failed");
  const failed = service.getJob(brokenJob.id)!;
  // 错误信息带 profile id，便于定位配置问题
  expect(failed.error).toContain("broken-role");
  expect(failed.error).toContain("nope");
  // Worker backend 在创建 session 前失败；主 backend 仅创建一个 session 用于交付失败结果
  await waitFor(() => backend.messages.some((m) => m.text.startsWith("<worker-continuation>")));
  expect(backend.sessions).toHaveLength(1);
}, 15000);

test("active continuation 回合按 FIFO 完成后再处理用户消息", async () => {
  // 主 backend 处理消息时延迟，模拟 continuation 验收回合进行中
  backend.delayMs = 800;
  await pipeline.start();

  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "FIFO 验证",
  });
  const job = service.createJob({
    workId: work.id,
    workerProfileId: "general",
    prompt: "任务内容",
    workdir: tempRoot,
  });

  // Job 完成 → 生成 continuation（不手动 claim，让 pipeline 自动投递）
  const jobDeadline = Date.now() + 5000;
  while (Date.now() < jobDeadline && service.getJob(job.id)?.status !== "completed") {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const afterJob = service.getJob(job.id)!;
  expect(afterJob.status).toBe("completed");

  // continuation 已先进入主 backend（busy 处理中）
  await waitFor(() => (pipeline as any).queue.isBusy(CHAT_ID));

  // 用户消息后到：只能排在 continuation 后面，不能取消当前验收回合
  const userMsgText = `插一句-${Date.now()}`;
  (pipeline as any).handleMessage({
    senderPlatformId: "user-open-id",
    senderName: "admin",
    chatPlatformId: "oc_chat_1",
    chatType: "p2p",
    contentText: userMsgText,
    contentType: "text",
    timestamp: new Date(),
    platformMsgId: `user-msg-${Date.now()}`,
    platformTs: Date.now(),
    raw: {},
  } as any);

  // 用户消息最终被处理，且调用顺序严格晚于 continuation
  await waitFor(() => backend.messages.some((m) => m.text.includes(userMsgText)), 8000);
  const continuationIndex = backend.messages.findIndex((m) => m.text.startsWith("<worker-continuation>"));
  const userIndex = backend.messages.findIndex((m) => m.text.includes(userMsgText));
  expect(continuationIndex).toBeGreaterThanOrEqual(0);
  expect(userIndex).toBeGreaterThan(continuationIndex);
  await waitFor(() => {
    const q = (pipeline as any).queue as { isBusy: (c: string) => boolean };
    return !q.isBusy(CHAT_ID);
  }, 8000);
}, 20000);

test("准备阶段取消：createSession 挂起时取消，job 收敛为 cancelled", async () => {
  backend.createSessionDelayMs = 3000;
  await pipeline.start();

  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "准备阶段取消测试",
  });
  const job = service.createJob({
    workId: work.id,
    workerProfileId: "developer",
    prompt: "任务内容",
    workdir: tempRoot,
  });

  // job 被认领进入准备阶段（session 创建中，createSession 挂起）
  await waitFor(() => service.getJob(job.id)?.status === "running");
  service.requestCancel(job.id);
  expect(service.getJob(job.id)?.status).toBe("cancelling");

  // 不等待 10 分钟兜底：abort 后 runJob 在检查点收敛为 cancelled
  await waitFor(() => service.getJob(job.id)?.status === "cancelled", 8000);
  expect(service.getJob(job.id)?.error).toMatch(/cancelled during preparation/);
  // 终态生成验收 Continuation（可能已被 scheduler 抢先投递为 claimed）
  expect(service.listEvents(work.id).some((e) => e.event === "continuation_created")).toBe(true);
}, 20000);

test("验收回合异常：释放认领重新投递（不卡 claimed）", async () => {
  // 验收回合消息（含 <worker-continuation>）抛异常，模拟主 Agent backend 故障
  backend.onSendMessage = (_session, message) => {
    if (message.includes("<worker-continuation>")) {
      throw new Error("acceptance boom");
    }
  };
  await pipeline.start();

  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "验收异常测试",
  });
  const job = service.createJob({
    workId: work.id,
    workerProfileId: "developer",
    prompt: "任务内容",
    workdir: tempRoot,
  });

  await waitFor(() => service.getJob(job.id)?.status === "completed");

  // 验收投递后主 Agent 回合抛错 → 认领被释放回 pending（可再次投递，不卡 claimed）
  await waitFor(() => service.listPendingContinuations().some((c) => c.workId === work.id), 8000);
  // 至少有一次验收尝试（消息已发给主 Agent）
  expect(backend.messages.some((m) => m.text.includes("<worker-continuation>"))).toBe(true);
}, 20000);

test("运行中取消：sendMessage 正常返回时按取消确认（不落 completed）", async () => {
  backend.delayMs = 2000; // 执行中挂起
  await pipeline.start();

  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "运行中取消测试",
  });
  const job = service.createJob({
    workId: work.id,
    workerProfileId: "developer",
    prompt: "任务内容",
    workdir: tempRoot,
  });

  await waitFor(() => service.getJob(job.id)?.status === "running");
  service.requestCancel(job.id);
  expect(service.getJob(job.id)?.status).toBe("cancelling");

  // sendMessage 正常返回（进程未 spawn 时 cancelSession 是 no-op）→ 终态必须是 cancelled 而非 completed
  await waitFor(() => ["cancelled", "completed"].includes(service.getJob(job.id)?.status ?? ""), 8000);
  expect(service.getJob(job.id)?.status).toBe("cancelled");
}, 20000);

test("CLI cancel 准备中的 Job：abort 而非幽灵执行", async () => {
  backend.createSessionDelayMs = 3000; // 准备阶段挂起
  await pipeline.start();

  const work = service.createWork({
    botId: BOT_ID,
    ownerUserId: OWNER,
    sourceChatId: CHAT_ID,
    visibility: "private",
    request: "CLI 取消准备中测试",
  });
  const job = service.createJob({
    workId: work.id,
    workerProfileId: "developer",
    prompt: "幽灵执行检测任务内容",
    workdir: tempRoot,
  });

  // job 已认领进入准备阶段（createSession 挂起）
  await waitFor(() => service.getJob(job.id)?.status === "running");
  const messagesBefore = backend.messages.length;
  // 伪造主会话活动 Agent 回合（executeWorkerAgentCommand 要求）
  const rs = (pipeline as any).runtimeState;
  const run = rs.createRun({
    chatId: CHAT_ID,
    triggerMessageIds: [],
    triggerPlatformMsgIds: [],
    mergedText: "test turn",
  });
  rs.markRunStage(run.runId, "agent_running");
  const token = "integration-token";
  (pipeline as any).activeWorkerAgentCommands.set(CHAT_ID, {
    runId: run.runId,
    userId: OWNER,
    chatType: "p2p",
    continuationTurn: false,
    createdWorkIds: [],
    token,
  });
  const result = await (pipeline as any).executeWorkerAgentCommand({
    command: { type: "cancel", id: job.id },
    chatId: CHAT_ID,
    userId: OWNER,
    chatType: "p2p",
    scheduleToken: token,
  });
  expect(result.output).toContain("已");
  (pipeline as any).activeWorkerAgentCommands.delete(CHAT_ID);

  // 收敛为 cancelled（不等待 10 分钟兜底）
  await waitFor(() => service.getJob(job.id)?.status === "cancelled", 8000);
  // 无幽灵执行：job prompt 从未发给 backend
  await new Promise((resolve) => setTimeout(resolve, 500));
  const ghostExecuted = backend.messages
    .slice(messagesBefore)
    .some((m) => m.text.includes("幽灵执行检测任务内容"));
  expect(ghostExecuted).toBe(false);
}, 20000);
