import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { WorkspaceProvider } from "./workspace.js";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "worker-workspace-"));
});

afterEach(() => {
  // 无 db 需要关闭
});

describe("WorkspaceProvider", () => {
  const provider = () => new WorkspaceProvider({ tmpRoot: path.join(tempRoot, "tmp") });

  test("read_only：直接使用目标目录（realpath），并在 tmp 下提供独立产物目录", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tempRoot, "target-")));
    const prepared = await provider().prepare("job-1", "read_only", dir);
    expect(prepared.execDir).toBe(dir);
    expect(prepared.artifactDir).toBeTruthy();
    expect(prepared.artifactDir).not.toBe(dir);
    expect(prepared.artifactDir).toContain("tmp");
    expect(existsSync(prepared.artifactDir!)).toBe(true);
  });

  test("read_only：不存在或非绝对路径拒绝", async () => {
    await expect(provider().prepare("job-1", "read_only", "/no/such/dir/xyz")).rejects.toThrow(/不可访问/);
    await expect(provider().prepare("job-1", "read_only", "relative/path")).rejects.toThrow(/绝对路径/);
  });

  test("direct：直接在目标目录修改，不建产物目录", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tempRoot, "target-")));
    const prepared = await provider().prepare("job-1", "direct", dir);
    expect(prepared.execDir).toBe(dir);
    expect(prepared.artifactDir).toBeUndefined();
  });

  test("direct：目标目录不存在拒绝（不静默新建）", async () => {
    await expect(provider().prepare("job-1", "direct", "/no/such/dir/xyz")).rejects.toThrow(/不可访问/);
  });

  test("非 direct 值（未知值防御）：按 read_only 处理", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tempRoot, "not-repo-")));
    const prepared = await provider().prepare("job-x", "git_worktree" as never, dir);
    expect(prepared.execDir).toBe(dir);
    expect(prepared.artifactDir).toBeTruthy();
  });
});
