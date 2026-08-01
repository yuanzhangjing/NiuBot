import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { initDatabase } from "../database/schema.js";
import { ResourceLeaseManager } from "./lease.js";
import { WorkspaceProvider, WORKER_MARKER_FILENAME } from "./workspace.js";

let tempRoot: string;
let db: Database.Database;
let leases: ResourceLeaseManager;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "worker-workspace-"));
  db = initDatabase(path.join(tempRoot, "test.db"));
  leases = new ResourceLeaseManager(db, "test-bot", { ttlMs: 60_000 });
});

afterEach(() => {
  db.close();
});

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

  test("git_worktree：创建独立 worktree 和分支，带 marker", async () => {
    const repo = makeGitRepo();
    const prepared = await provider().prepare("job-wt", "git_worktree", repo);
    expect(prepared.managed).toBe(true);
    expect(prepared.repoPath).toBe(repo);
    expect(prepared.branch).toBe("niubot-worker/job-wt");
    expect(existsSync(path.join(prepared.execDir, "a.txt"))).toBe(true);
    expect(existsSync(path.join(prepared.execDir, WORKER_MARKER_FILENAME))).toBe(true);
    // worktree 分支指向独立 HEAD
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: prepared.execDir, encoding: "utf8" }).trim();
    expect(branch).toBe("niubot-worker/job-wt");
  });

  test("git_worktree：非 git 仓库拒绝", async () => {
    const dir = mkdtempSync(path.join(tempRoot, "not-repo-"));
    await expect(provider().prepare("job-x", "git_worktree", dir)).rejects.toThrow(/git 仓库/);
  });
});

describe("ResourceLeaseManager", () => {
  test("同资源互斥：第二个 acquire 返回 held", () => {
    const first = leases.acquire("repo-write:/repo", "job-1");
    expect(first.ok).toBe(true);
    const second = leases.acquire("repo-write:/repo", "job-2");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.holderJobId).toBe("job-1");
  });

  test("release 后可重新获取", () => {
    leases.acquire("repo-write:/repo", "job-1");
    expect(leases.release("job-1")).toBe(true);
    const again = leases.acquire("repo-write:/repo", "job-2");
    expect(again.ok).toBe(true);
  });

  test("不同资源键互不影响", () => {
    expect(leases.acquire("repo-write:/a", "job-1").ok).toBe(true);
    expect(leases.acquire("repo-write:/b", "job-2").ok).toBe(true);
  });

  test("过期租约被清理", () => {
    leases.acquire("repo-write:/repo", "job-1");
    // 直接把过期时间改到过去
    db.prepare("UPDATE worker_resource_leases SET expires_at = datetime('now', '-1 minute')").run();
    expect(leases.cleanupExpired()).toBe(1);
    expect(leases.acquire("repo-write:/repo", "job-2").ok).toBe(true);
  });
});
