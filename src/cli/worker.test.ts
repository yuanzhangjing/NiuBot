import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { initDatabase } from "../database/schema.js";
import { handleWorker } from "./worker.js";

const BOT_ID = "test-bot";
const CHAT_ID = "chat-1";
const USER_ID = "user-1";

let db: Database.Database;
let tempRoot: string;
let captured: string[];

function capture(fn: () => void): string[] {
  captured = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
    captured.push(String(line));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return captured;
}

function env(overrides: Record<string, string> = {}) {
  const base = {
    NIUBOT_BOT_ID: BOT_ID,
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
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

function writeDoc(name: string, content: string): string {
  const file = path.join(tempRoot, name);
  writeFileSync(file, content);
  return file;
}

test("work create → job create → list → get → complete 完整链路", () => {
  // 当前 chat 最近一条用户消息（有平台侧 ID）应被记为 Work 的触发消息
  db.prepare(
    `INSERT INTO messages (chat_id, sender_id, role, content_text, platform, platform_msg_id, created_at)
     VALUES (?, ?, 'user', '审查登录模块的并发问题', 'feishu', 'om_trigger_1', datetime('now'))`,
  ).run(CHAT_ID, USER_ID);

  const workFile = writeDoc("work.md", "审查登录模块的并发问题");
  const out1 = capture(() => handleWorker(db, ["work", "create", "--file", workFile]));
  const workId = out1[0]!;
  expect(workId).toMatch(/^wrk_/);
  const workRow = db.prepare("SELECT trigger_msg_platform_id FROM worker_works WHERE id = ?").get(workId) as
    | { trigger_msg_platform_id: string | null }
    | undefined;
  expect(workRow?.trigger_msg_platform_id).toBe("om_trigger_1");

  const jobFile = writeDoc("job.md", "检查 handleLogin 的竞态，给出证据");
  const out2 = capture(() => handleWorker(db, ["job", "create", "--work", workId, "--worker", "reviewer", "--file", jobFile]));
  const jobId = out2[0]!;
  expect(jobId).toMatch(/^job_/);

  // 相同内容重复创建返回原 Job（幂等）
  const out3 = capture(() => handleWorker(db, ["job", "create", "--work", workId, "--worker", "reviewer", "--file", jobFile]));
  expect(out3[0]).toBe(jobId);

  // list 能看到
  const listOut = capture(() => handleWorker(db, ["list"]));
  expect(listOut.join("\n")).toContain(workId);
  expect(listOut.join("\n")).toContain(jobId);

  // get job 详情
  const getOut = capture(() => handleWorker(db, ["get", jobId]));
  expect(getOut.join("\n")).toContain("检查 handleLogin");

  // complete work
  const resultFile = writeDoc("result.md", "已完成审查，无阻塞问题");
  const doneOut = capture(() => handleWorker(db, ["complete", "--work", workId, "--file", resultFile]));
  expect(doneOut.join("\n")).toContain("已完成");
});

test("群聊中触发消息限定发送者：其他成员的最新消息不被选中", () => {
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
  const workId = capture(() => handleWorker(db, ["work", "create", "--file", workFile]))[0]!;
  const workRow = db.prepare("SELECT trigger_msg_platform_id FROM worker_works WHERE id = ?").get(workId) as
    | { trigger_msg_platform_id: string | null }
    | undefined;
  // 选中自己最近的消息（即使时间上不是 chat 最近）
  expect(workRow?.trigger_msg_platform_id).toBe("om_mine_1");
});

test("未知 worker profile 拒绝创建 Job", () => {
  const workFile = writeDoc("work.md", "任务");
  const workId = capture(() => handleWorker(db, ["work", "create", "--file", workFile]))[0]!;
  const jobFile = writeDoc("job.md", "任务内容");
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
    throw new Error(`exit ${code}`);
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(() => handleWorker(db, ["job", "create", "--work", workId, "--worker", "nope", "--file", jobFile])).toThrow("exit 1");
  expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("未知 Worker Profile"));
  exitSpy.mockRestore();
  errorSpy.mockRestore();
});

test("cancel 请求取消 Work", () => {
  const workFile = writeDoc("work.md", "任务");
  const workId = capture(() => handleWorker(db, ["work", "create", "--file", workFile]))[0]!;
  const out = capture(() => handleWorker(db, ["cancel", workId]));
  expect(out.join("\n")).toContain("已请求取消");
});

test("help 输出用法", () => {
  const out = capture(() => handleWorker(db, ["help"]));
  expect(out.join("\n")).toContain("nbt worker");
  expect(out.join("\n")).toContain("general");
});
