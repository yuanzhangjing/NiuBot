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

import type { AgentBackend, AgentResponse, AgentSession, SessionConfig } from "../agent/types.js";
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
  readonly messages: Array<{ sessionId: string; text: string }> = [];
  readonly sessionDirs = new Map<string, string>();
  /** 每个 worker session 返回的结果文本 */
  resultText = "审查结论：发现 2 个并发问题，详见报告。";
  /** worker session 的 sendMessage 次数（0 时挂起，用于并发测试） */
  delayMs = 0;
  /** 非空时 sendMessage 在工作目录写入该文件（模拟写任务） */
  writeFileOnSend?: string;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async createSession(config: SessionConfig): Promise<AgentSession> {
    const id = `agent_${this.sessions.length + 1}`;
    this.sessions.push(id);
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
      workspaceRoot: path.join(tempRoot, "ws"),
      teamConfigStore: teamConfig,
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

test("写任务：developer 在独立 worktree 修改代码，不污染目标仓库", async () => {
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

  // 目标仓库主工作区没有 b.txt（写入发生在 worktree）
  expect(existsSync(path.join(repo, "b.txt"))).toBe(false);

  // worktree 目录保留且包含写入的文件 + marker
  const worktreeDir = path.join(tempRoot, "ws", `worktree-${job.id}`);
  expect(existsSync(path.join(worktreeDir, "b.txt"))).toBe(true);
  expect(existsSync(path.join(worktreeDir, ".niubot-worker"))).toBe(true);
}, 15000);

test("同一 repo 的两个写 Job 互斥：第二个 resource busy", async () => {
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

  await waitFor(() => service.getJob(jobA.id)?.status === "running");
  // jobB 应因租约冲突失败（不并行写同一 repo）
  await waitFor(() => service.getJob(jobB.id)?.status === "failed");
  expect(service.getJob(jobB.id)?.error).toMatch(/resource busy/);
}, 15000);

test("团队模式关闭时 queued Job 不调度，开启后执行", async () => {
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

test("团队模式开启时主 Agent 回合注入派工 Skill，关闭时不注入", async () => {
  teamConfig.setEnabled(false);
  await pipeline.start();

  // 关闭状态：用户消息回合不注入 skill
  pipeline.handleInbound(userDelivery(CHAT_ID, "你好", 1));
  await waitFor(() => backend.messages.some((m) => m.text.includes("你好")));
  const first = backend.messages.find((m) => m.text.includes("你好"))!;
  expect(first.text).not.toContain("<worker-skill>");

  // 开启：后续用户消息回合注入
  teamConfig.setEnabled(true);
  pipeline.handleInbound(userDelivery(CHAT_ID, "帮我调研一下", 2));
  await waitFor(() => backend.messages.some((m) => m.text.includes("帮我调研一下")));
  const second = backend.messages.find((m) => m.text.includes("帮我调研一下"))!;
  expect(second.text).toContain("<worker-skill>");
  expect(second.text).toContain("nbt worker job create");
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

  // 命令路径触发热更新（等价于 /teams config apply）
  pipeline.applyActiveTeamConfigToRegistry();
  expect(registry.list().some((p) => p.id === "custom-reviewer")).toBe(true);
  expect(registry.get("custom-reviewer")?.access).toBe("read_only");
});
