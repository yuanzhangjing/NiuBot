/**
 * nbt worker — 主 Agent 派工与验收的内部 Worker CLI（方案 §7.1）。
 *
 * 第一版说明：
 * - CLI 直接打开 NIUBOT_DB_PATH 使用 SqliteJobService（本地 API 化列入后续阶段）。
 * - 身份来自 Engine 注入的环境变量（NIUBOT_BOT_ID / NIUBOT_CHAT_ID / NIUBOT_USER_ID），
 *   不接受命令行参数覆盖。
 * - Work/Job 内容使用自由 Markdown 文件，避免复杂 shell 转义。
 * - Job 幂等键由 CLI 自动派生（chatId + 命令 + 规范化内容 hash），重复执行返回原 Job。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type Database from "better-sqlite3";

import { SqliteJobService } from "../worker/job-service.js";
import { WorkerProfileRegistry } from "../worker/profiles.js";
import { TeamConfigStore } from "../worker/team-config.js";
import type { WorkVisibility } from "../worker/types.js";

interface WorkerCliContext {
  db: Database.Database;
  botId: string;
  chatId: string;
  userId: string;
  chatType: string;
  workDir: string;
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function readFileOrFail(filePath: string | undefined, label: string): string {
  if (!filePath) fail(`${label} 需要 --file <path>`);
  try {
    return readFileSync(filePath, "utf8");
  } catch (err) {
    fail(`读取 ${label} 失败: ${String(err)}`);
  }
}

function idempotencyKey(prefix: string, text: string, chatId: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return `${chatId}:${prefix}:${createHash("sha256").update(normalized).digest("hex").slice(0, 32)}`;
}

function printWork(service: SqliteJobService, workId: string): void {
  const work = service.getWork(workId);
  if (!work) fail(`Work 不存在: ${workId}`);
  const jobs = service.listJobs(workId);
  console.log(`Work: ${work.id} (${work.status})`);
  console.log(`  需求: ${work.request.slice(0, 120)}${work.request.length > 120 ? "…" : ""}`);
  if (work.finalConclusion) console.log(`  结论: ${work.finalConclusion}`);
  for (const job of jobs) {
    console.log(`  Job: ${job.id} (${job.workerProfileId}, ${job.status})`);
  }
}

function handleWorkCreate(ctx: WorkerCliContext, service: SqliteJobService, args: string[]): void {
  const fileIndex = args.indexOf("--file");
  const content = readFileOrFail(fileIndex >= 0 ? args[fileIndex + 1] : undefined, "work 文件");
  const visibility: WorkVisibility = ctx.chatType === "group" ? "public" : "private";
  const work = service.createWork({
    botId: ctx.botId,
    ownerUserId: ctx.userId,
    sourceChatId: ctx.chatId,
    visibility,
    request: content.trim(),
  });
  console.log(work.id);
}

function handleJobCreate(ctx: WorkerCliContext, service: SqliteJobService, args: string[]): void {
  const workId = args.find((a, i) => args[i - 1] === "--work");
  if (!workId) fail("job create 需要 --work <work-id>");
  const workerId = args.find((a, i) => args[i - 1] === "--worker");
  if (!workerId) fail("job create 需要 --worker <profile-id>");
  const fileIndex = args.indexOf("--file");
  const prompt = readFileOrFail(fileIndex >= 0 ? args[fileIndex + 1] : undefined, "job 文件");
  const workdirIndex = args.indexOf("--workdir");
  const workdir = workdirIndex >= 0 ? args[workdirIndex + 1]! : ctx.workDir;
  const workspaceIndex = args.indexOf("--workspace");
  const workspacePolicy = workspaceIndex >= 0 ? args[workspaceIndex + 1] : undefined;
  if (workspacePolicy && !["read_only", "scratch", "git_worktree"].includes(workspacePolicy)) {
    fail(`--workspace 必须是 read_only / scratch / git_worktree，收到: ${workspacePolicy}`);
  }

  const registry = new WorkerProfileRegistry();
  if (!registry.get(workerId)) {
    fail(`未知 Worker Profile: ${workerId}（可用: ${registry.list().map((p) => p.id).join(", ")}）`);
  }

  const job = service.createJob(
    {
      workId,
      workerProfileId: workerId,
      prompt: prompt.trim(),
      workdir,
      workspacePolicy: workspacePolicy as never,
    },
    idempotencyKey("job", prompt, ctx.chatId),
  );
  console.log(job.id);
}

function handleList(ctx: WorkerCliContext, service: SqliteJobService, args: string[]): void {
  const statusIndex = args.indexOf("--status");
  const status = statusIndex >= 0 ? args[statusIndex + 1] : undefined;
  const works = service.listWorks({
    botId: ctx.botId,
    ownerUserId: ctx.userId,
    status: status as never,
  });
  if (works.length === 0) {
    console.log("(无 Work)");
    return;
  }
  for (const work of works) {
    printWork(service, work.id);
  }
}

function handleGet(service: SqliteJobService, id: string): void {
  if (id.startsWith("wrk_")) {
    printWork(service, id);
    return;
  }
  if (id.startsWith("job_")) {
    const job = service.getJob(id);
    if (!job) fail(`Job 不存在: ${id}`);
    const work = service.getWork(job!.workId);
    console.log(`Job: ${job!.id} (${job!.status})`);
    console.log(`  Worker: ${job!.workerProfileId}`);
    console.log(`  Work: ${job!.workId}${work ? ` (${work.request.slice(0, 80)})` : ""}`);
    console.log(`  Prompt: ${job!.prompt.slice(0, 200)}`);
    console.log(`  工作目录: ${job!.workdir}`);
    console.log(`  最终文本: ${(job!.responseText ?? "(无)").slice(0, 2000)}`);
    if (job!.error) console.log(`  错误: ${job!.error}`);
    return;
  }
  fail(`无法识别的 ID: ${id}（work 以 wrk_ 开头，job 以 job_ 开头）`);
}

function handleCancel(service: SqliteJobService, id: string): void {
  if (id.startsWith("wrk_")) {
    const work = service.cancelWork(id);
    if (!work) fail(`Work 不存在: ${id}`);
    console.log(`Work ${id} 已请求取消（cancelling），运行中 Job 确认退出后进入 cancelled`);
    return;
  }
  if (id.startsWith("job_")) {
    const job = service.requestCancel(id);
    if (!job) fail(`Job 不存在或不可取消: ${id}`);
    console.log(`Job ${id} 已请求取消（cancelling），确认退出后进入 cancelled`);
    return;
  }
  fail(`无法识别的 ID: ${id}`);
}

function handleComplete(ctx: WorkerCliContext, service: SqliteJobService, args: string[]): void {
  const workId = args.find((a, i) => args[i - 1] === "--work");
  if (!workId) fail("complete 需要 --work <work-id>");
  const fileIndex = args.indexOf("--file");
  const conclusion = readFileOrFail(fileIndex >= 0 ? args[fileIndex + 1] : undefined, "结论文件");
  const work = service.completeWork(workId, { conclusion: conclusion.trim() });
  if (!work) fail(`Work 不存在或不可完成: ${workId}`);
  console.log(`Work ${workId} 已完成`);
}

/** nbt worker config：主 Agent 生成配置草案（管理员 /teams config 确认应用）。 */
function handleConfig(ctx: WorkerCliContext, args: string[]): void {
  const sub = args[0];
  const store = new TeamConfigStore(ctx.db, ctx.botId);
  if (sub === "draft") {
    const fileIndex = args.indexOf("--file");
    const yamlText = readFileOrFail(fileIndex >= 0 ? args[fileIndex + 1] : undefined, "配置 yaml");
    const baseVersion = args.find((a, i) => args[i - 1] === "--base") ?? store.getActiveConfig().version;
    const result = store.createDraft(yamlText, ctx.userId, baseVersion);
    if (!result.ok) {
      fail(result.error);
    }
    console.log(result.draftId);
    return;
  }
  if (sub === "show") {
    const active = store.getActiveConfig();
    console.log(`version: ${active.version ?? "(默认)"}`);
    console.log(`maxConcurrent: ${active.config.maxConcurrent}`);
    console.log(`maxJobsPerWork: ${active.config.maxJobsPerWork}`);
    for (const p of active.config.profiles) {
      console.log(`- ${p.id} (${p.access}) ${p.description ?? ""}`);
    }
    return;
  }
  if (sub === "drafts") {
    const drafts = store.listPendingDrafts();
    if (drafts.length === 0) {
      console.log("(无待确认草案)");
      return;
    }
    for (const d of drafts) {
      console.log(`${d.id}（基准 ${d.baseVersion ?? "(默认)"}）: ${d.configYaml.split("\n")[0]}`);
    }
    return;
  }
  fail("config 子命令仅支持 draft --file <yaml> | show | drafts");
}

export function handleWorker(db: Database.Database, args: string[]): void {
  const sub = args[0];
  if (sub === "--help" || sub === "help" || sub === undefined) {
    console.log(`nbt worker — 内部 Worker 派工与验收

用法：
  nbt worker work create --file <work.md>       创建 Work（来源自动绑定当前会话）
  nbt worker job create --work <id> --worker <profile> --file <job.md> [--workdir <dir>] [--workspace read_only|scratch|git_worktree]
  nbt worker list [--status <status>]           列出当前会话的 Work 和 Job
  nbt worker get <work-or-job-id>               查看详情
  nbt worker cancel <work-or-job-id>            取消 Work 或 Job
  nbt worker complete --work <id> --file <result.md>   主 Agent 验收完成

内置 Worker Profile：general / researcher / reviewer
Work/Job 内容使用自由 Markdown 文件；CLI 不接受 --user/--chat 参数。`);
    return;
  }

  const botId = process.env["NIUBOT_BOT_ID"] ?? "unknown";
  const chatId = process.env["NIUBOT_CHAT_ID"];
  const userId = process.env["NIUBOT_USER_ID"];
  if (!chatId || !userId) {
    fail("NIUBOT_CHAT_ID / NIUBOT_USER_ID 未设置（仅限 agent session 使用）");
  }
  const ctx: WorkerCliContext = {
    db,
    botId,
    chatId,
    userId,
    chatType: process.env["NIUBOT_CHAT_TYPE"] ?? "p2p",
    workDir: process.env["NIUBOT_WORK_DIR"] ?? process.cwd(),
  };
  const service = new SqliteJobService(db, botId);

  switch (sub) {
    case "work":
      if (args[1] === "create") handleWorkCreate(ctx, service, args.slice(2));
      else fail("work 子命令仅支持 create");
      break;
    case "job":
      if (args[1] === "create") handleJobCreate(ctx, service, args.slice(2));
      else fail("job 子命令仅支持 create");
      break;
    case "list":
    case "ls":
      handleList(ctx, service, args.slice(1));
      break;
    case "get":
      if (!args[1]) fail("get 需要 <id>");
      handleGet(service, args[1]!);
      break;
    case "cancel":
      if (!args[1]) fail("cancel 需要 <id>");
      handleCancel(service, args[1]!);
      break;
    case "complete":
      handleComplete(ctx, service, args.slice(1));
      break;
    case "config":
      handleConfig(ctx, args.slice(1));
      break;
    default:
      fail(`未知子命令: ${sub}（用 nbt worker help 查看用法）`);
  }
}
