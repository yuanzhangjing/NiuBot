/**
 * nbt worker — 主 Agent 派工与验收的 Worker CLI（方案 §7.1）。
 *
 * 实现边界：
 * - 查询使用只读数据库连接；所有 Worker 状态写入通过本地 IPC 交给 Pipeline。
 * - 身份来自 Engine 注入的环境变量（NIUBOT_BOT_ID / NIUBOT_CHAT_ID / NIUBOT_USER_ID），
 *   不接受命令行参数覆盖。
 * - Work/Job 内容使用自由 Markdown 文件，避免复杂 shell 转义。
 * - Job 幂等键由 CLI 自动派生（chatId + 命令 + 规范化内容 hash），重复执行返回原 Job。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { localApiRequest } from "../local-api/client.js";
import { SqliteJobService } from "../worker/job-service.js";
import { TeamConfigStore } from "../worker/team-config.js";
import type { WorkerAgentCommand, WorkerAgentCommandResult } from "../worker/agent-command.js";
import { resolveSendEndpoint } from "./send.js";

interface WorkerCliContext {
  db: Database.Database;
  botId: string;
  chatId: string;
  userId: string;
  chatType: string;
  workDir: string;
}

export type WorkerCommandExecutor = (
  chatId: string,
  command: WorkerAgentCommand,
) => Promise<WorkerAgentCommandResult>;

async function executeViaPipeline(chatId: string, command: WorkerAgentCommand): Promise<WorkerAgentCommandResult> {
  let response;
  try {
    response = await localApiRequest(resolveSendEndpoint(), "/worker", {
      method: "POST",
      body: {
        chat_id: chatId,
        command,
        schedule_token: process.env.NIUBOT_SCHEDULE_TOKEN ?? undefined,
      },
      timeoutMs: 30_000,
    });
  } catch (error) {
    throw new Error(`无法连接 NiuBot Pipeline: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.statusCode >= 400) {
    let detail = response.body;
    try {
      const parsed = JSON.parse(response.body) as { error?: string };
      detail = parsed.error ?? detail;
    } catch { /* 保留原始响应 */ }
    throw new Error(`Pipeline 拒绝 Worker 操作 (${response.statusCode}): ${detail}`);
  }
  const result = JSON.parse(response.body) as WorkerAgentCommandResult;
  if (!result || typeof result.output !== "string") throw new Error("Pipeline 返回了无效的 Worker 响应");
  return result;
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

function assertReadableWork(ctx: WorkerCliContext, service: SqliteJobService, workId: string) {
  const work = service.getWork(workId);
  if (!work) fail(`Work 不存在: ${workId}`);
  if (work.sourceChatId !== ctx.chatId || (work.visibility === "private" && work.ownerUserId !== ctx.userId)) {
    fail(`无权读取 Work: ${workId}`);
  }
  return work;
}

function printWork(ctx: WorkerCliContext, service: SqliteJobService, workId: string): void {
  const work = assertReadableWork(ctx, service, workId);
  const jobs = service.listJobs(workId);
  console.log(`Work: ${work.id} (${work.status})`);
  console.log(`  需求: ${work.request.slice(0, 120)}${work.request.length > 120 ? "…" : ""}`);
  if (work.finalConclusion) console.log(`  结论: ${work.finalConclusion}`);
  for (const job of jobs) {
    console.log(`  Job: ${job.id} (${job.workerProfileId}, ${job.status})`);
  }
}

/** 校验未知 flag：已删除的参数（如旧版 --workspace）显式报错，避免静默忽略造成行为误解。 */
function rejectUnknownFlags(args: string[], known: string[], command: string): void {
  for (const arg of args) {
    if (arg.startsWith("--") && !known.includes(arg)) {
      fail(`${command} 收到未知参数: ${arg}`);
    }
  }
}

async function handleWorkCreate(ctx: WorkerCliContext, execute: WorkerCommandExecutor, args: string[]): Promise<void> {
  rejectUnknownFlags(args, ["--file"], "work create");
  const fileIndex = args.indexOf("--file");
  const content = readFileOrFail(fileIndex >= 0 ? args[fileIndex + 1] : undefined, "work 文件");
  const result = await execute(ctx.chatId, { type: "work.create", request: content.trim() });
  console.log(result.output);
}

async function handleJobCreate(ctx: WorkerCliContext, execute: WorkerCommandExecutor, args: string[]): Promise<void> {
  rejectUnknownFlags(args, ["--work", "--worker", "--file", "--workdir", "--depends-on"], "job create");
  const workId = args.find((a, i) => args[i - 1] === "--work");
  if (!workId) fail("job create 需要 --work <work-id>");
  const workerId = args.find((a, i) => args[i - 1] === "--worker");
  if (!workerId) fail("job create 需要 --worker <profile-id>");
  const fileIndex = args.indexOf("--file");
  const prompt = readFileOrFail(fileIndex >= 0 ? args[fileIndex + 1] : undefined, "job 文件");
  const workdirIndex = args.indexOf("--workdir");
  const workdir = workdirIndex >= 0 ? args[workdirIndex + 1]! : ctx.workDir;
  const dependsOn = args
    .map((a, i) => (args[i - 1] === "--depends-on" ? a : undefined))
    .filter((a): a is string => !!a)
    .flatMap((v) => v.split(",").map((s) => s.trim()).filter(Boolean));

  const result = await execute(ctx.chatId, {
      type: "job.create",
      workId,
      workerProfileId: workerId,
      prompt: prompt.trim(),
      workdir,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      idempotencyKey: idempotencyKey(
        `job:${workId}:${workerId}:${dependsOn.join(",")}:${path.resolve(workdir)}`,
        prompt,
        ctx.chatId,
      ),
    });
  console.log(result.output);
}

function handleList(ctx: WorkerCliContext, service: SqliteJobService, args: string[]): void {
  const statusIndex = args.indexOf("--status");
  const status = statusIndex >= 0 ? args[statusIndex + 1] : undefined;
  const works = service.listWorks({
    botId: ctx.botId,
    sourceChatId: ctx.chatId,
    status: status as never,
  }).filter((work) => work.visibility === "public" || work.ownerUserId === ctx.userId);
  if (works.length === 0) {
    console.log("(无 Work)");
    return;
  }
  for (const work of works) {
    printWork(ctx, service, work.id);
  }
}

function handleGet(ctx: WorkerCliContext, service: SqliteJobService, id: string): void {
  if (id.startsWith("wrk_")) {
    printWork(ctx, service, id);
    return;
  }
  if (id.startsWith("job_")) {
    const job = service.getJob(id);
    if (!job) fail(`Job 不存在: ${id}`);
    const work = assertReadableWork(ctx, service, job!.workId);
    console.log(`Job: ${job!.id} (${job!.status})`);
    console.log(`  Worker: ${job!.workerProfileId}`);
    console.log(`  Work: ${job!.workId}${work ? ` (${work.request.slice(0, 80)})` : ""}`);
    console.log(`  Prompt: ${job!.prompt.slice(0, 200)}`);
    console.log(`  工作目录: ${job!.workdir}`);
    if (job!.backendSessionId && job!.transcriptSourcesJson !== "[]") {
      console.log(`  Session 日志: nbt sessions get ${job!.id}`);
    } else if (job!.status === "running" || job!.status === "cancelling") {
      console.log("  Session 日志: 正在启动，暂未就绪");
    }
    console.log(`  最终文本: ${(job!.responseText ?? "(无)").slice(0, 2000)}`);
    if (job!.error) console.log(`  错误: ${job!.error}`);
    return;
  }
  fail(`无法识别的 ID: ${id}（work 以 wrk_ 开头，job 以 job_ 开头）`);
}

async function handleCancel(ctx: WorkerCliContext, execute: WorkerCommandExecutor, id: string): Promise<void> {
  const result = await execute(ctx.chatId, { type: "cancel", id });
  console.log(result.output);
}

async function handleComplete(ctx: WorkerCliContext, execute: WorkerCommandExecutor, args: string[]): Promise<void> {
  if (!args.includes("--force")) {
    fail("complete 仅用于人工修复异常悬挂的 Work，确认后请加 --force");
  }
  const workId = args.find((a, i) => args[i - 1] === "--work");
  if (!workId) fail("complete 需要 --work <work-id>");
  const fileIndex = args.indexOf("--file");
  const conclusion = readFileOrFail(fileIndex >= 0 ? args[fileIndex + 1] : undefined, "结论文件");
  const result = await execute(ctx.chatId, {
    type: "work.complete_recovery",
    workId,
    conclusion: conclusion.trim(),
    force: true,
  });
  console.log(result.output);
}

/** nbt worker config：主 Agent 生成配置草案（管理员 /worker config 确认应用）。 */
async function handleConfig(ctx: WorkerCliContext, execute: WorkerCommandExecutor, args: string[]): Promise<void> {
  const sub = args[0];
  const store = new TeamConfigStore(ctx.db, ctx.botId);
  if (sub === "draft") {
    const fileIndex = args.indexOf("--file");
    const yamlText = readFileOrFail(fileIndex >= 0 ? args[fileIndex + 1] : undefined, "配置 yaml");
    const baseVersion = args.find((a, i) => args[i - 1] === "--base") ?? store.getActiveConfig().version;
    const result = await execute(ctx.chatId, { type: "config.draft", yamlText, baseVersion });
    console.log(result.output);
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
  if (sub === "apply") {
    const draftId = args[1];
    if (!draftId) fail("config apply 需要 <draft-id>");
    const result = await execute(ctx.chatId, { type: "config.apply", draftId });
    console.log(result.output);
    return;
  }
  if (sub === "rollback") {
    const version = args[1];
    if (!version) fail("config rollback 需要 <version>");
    const result = await execute(ctx.chatId, { type: "config.rollback", version });
    console.log(result.output);
    return;
  }
  fail("config 子命令仅支持 draft --file <yaml> | show | drafts | apply <draft-id> | rollback <version>");
}

export async function handleWorker(
  db: Database.Database,
  args: string[],
  execute: WorkerCommandExecutor = executeViaPipeline,
): Promise<void> {
  const sub = args[0];
  if (sub === "--help" || sub === "help" || sub === undefined) {
    console.log(`nbt worker — Worker 派工与验收

用法：
  nbt worker work create --file <work.md>       创建 Work（来源自动绑定当前会话）
  nbt worker job create --work <id> --worker <profile> --file <job.md> [--workdir <dir>] [--depends-on <job-id>[,<job-id>...]]
  nbt worker list [--status <status>]           列出当前会话的 Work 和 Job
  nbt worker get <work-or-job-id>               查看详情
  nbt sessions get <job-id>                     查看 Worker 运行中或已结束的 session 日志
  nbt worker cancel <work-or-job-id>            取消 Work 或 Job
  nbt worker complete --force --work <id> --file <result.md>   人工修复异常悬挂的 Work
  nbt worker config draft --file <yaml> [--base <v>]   生成配置草案（主 Agent 用）
  nbt worker config drafts                            列出待确认草案
  nbt worker config show                              查看当前配置
  nbt worker config apply <draft-id>                  应用草案（用户确认后）
  nbt worker config rollback <version>                回滚到指定版本

内置 Worker Profile：general / researcher / reviewer / developer / tester
Work/Job 内容使用自由 Markdown 文件；CLI 不接受 --user/--chat 参数。`);
    return;
  }

  // Worker 表按 Bot 配置 ID（bot name）分区；NIUBOT_BOT_ID 是平台机器人 ID，不能混用。
  const botId = process.env["NIUBOT_BOT_NAME"] ?? process.env["NIUBOT_BOT_ID"] ?? "unknown";
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
      if (args[1] === "create") await handleWorkCreate(ctx, execute, args.slice(2));
      else fail("work 子命令仅支持 create");
      break;
    case "job":
      if (args[1] === "create") await handleJobCreate(ctx, execute, args.slice(2));
      else fail("job 子命令仅支持 create");
      break;
    case "list":
    case "ls":
      handleList(ctx, service, args.slice(1));
      break;
    case "get":
      if (!args[1]) fail("get 需要 <id>");
      handleGet(ctx, service, args[1]!);
      break;
    case "cancel":
      if (!args[1]) fail("cancel 需要 <id>");
      await handleCancel(ctx, execute, args[1]!);
      break;
    case "complete":
      await handleComplete(ctx, execute, args.slice(1));
      break;
    case "config":
      await handleConfig(ctx, execute, args.slice(1));
      break;
    default:
      fail(`未知子命令: ${sub}（用 nbt worker help 查看用法）`);
  }
}
