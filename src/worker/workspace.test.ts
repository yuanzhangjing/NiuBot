import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { WorkspaceProvider, WORKER_MARKER_FILENAME } from "./workspace.js";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "worker-workspace-"));
});

afterEach(() => {
  // 无 db 需要关闭
});

describe("WorkspaceProvider", () => {
  const provider = () => new WorkspaceProvider({ rootDir: path.join(tempRoot, "ws") });

  test("read_only：直接使用目标目录（realpath），并提供独立产物目录", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tempRoot, "target-")));
    const prepared = await provider().prepare("job-1", "read_only", dir);
    expect(prepared.execDir).toBe(dir);
    expect(prepared.managed).toBe(false);
    expect(prepared.artifactDir).toBeTruthy();
    expect(prepared.artifactDir).not.toBe(dir);
    expect(existsSync(prepared.artifactDir!)).toBe(true);
  });

  test("read_only：不存在或非绝对路径拒绝", async () => {
    await expect(provider().prepare("job-1", "read_only", "/no/such/dir/xyz")).rejects.toThrow(/不可访问/);
    await expect(provider().prepare("job-1", "read_only", "relative/path")).rejects.toThrow(/绝对路径/);
  });

  test("scratch：创建独立目录并写 marker", async () => {
    const prepared = await provider().prepare("job-scratch", "scratch", "/ignored");
    expect(prepared.managed).toBe(true);
    expect(existsSync(path.join(prepared.execDir, WORKER_MARKER_FILENAME))).toBe(true);
  });

  test("未知策略（存量数据防御）：按 scratch 处理，不静默落到目标目录", async () => {
    const dir = mkdtempSync(path.join(tempRoot, "not-repo-"));
    const prepared = await provider().prepare("job-x", "git_worktree" as never, dir);
    expect(prepared.managed).toBe(true);
    expect(prepared.execDir).toBe(path.join(tempRoot, "ws", "job-job-x"));
  });
});
