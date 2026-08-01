/**
 * WorkspaceProvider：Job 工作区准备（§12）。
 *
 * 策略：
 * - read_only：直接使用目标目录（校验存在且是目录），不做任何写操作；
 * - scratch：在 scratchRoot 下创建独立临时目录（带 marker）；
 * - git_worktree：目标必须是 git 仓库，创建独立 worktree（分支 niubot-worker/<jobId>），
 *   执行目录与目标仓库隔离，写入不污染主工作区。
 *
 * 保留策略：失败/取消/完成后工作区默认保留（marker 标记来源），安全确认前不自动删除。
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createLogger } from "../logger.js";
import type { WorkspacePolicy } from "./types.js";

const log = createLogger("worker-workspace");

export const WORKER_MARKER_FILENAME = ".niubot-worker";

export interface PreparedWorkspace {
  /** 实际执行目录 */
  execDir: string;
  /** marker 文件路径（managed 工作区） */
  markerPath?: string;
  /** 是否由 Runtime 管理（worktree/scratch） */
  managed: boolean;
  /** git_worktree 时的目标仓库路径 */
  repoPath?: string;
  /** git_worktree 时的分支名 */
  branch?: string;
  /** 产物目录（read_only 策略：工作目录只读，落盘内容写这里） */
  artifactDir?: string;
}

export interface WorkspaceProviderOptions {
  /** scratch 与 worktree 的根目录（默认 $NIUBOT_HOME/worker-workspaces） */
  rootDir: string;
}

export class WorkspaceProvider {
  constructor(private readonly options: WorkspaceProviderOptions) {}

  /**
   * 准备 Job 工作区。目标路径必须存在且为绝对路径；
   * git_worktree 要求目标是 git 仓库。失败抛出带原因的错误。
   */
  async prepare(jobId: string, policy: WorkspacePolicy, targetDir: string): Promise<PreparedWorkspace> {
    switch (policy) {
      case "read_only": {
        const real = resolveExistingDir(targetDir);
        // 只读：工作目录直接使用目标目录，另给独立产物目录用于落盘（报告/生成文件）
        const artifactDir = path.join(this.options.rootDir, `job-${jobId}-artifacts`);
        mkdirSync(artifactDir, { recursive: true });
        writeMarker(artifactDir, { jobId, policy, createdAt: new Date().toISOString() });
        return { execDir: real, artifactDir, managed: false };
      }
      case "scratch": {
        const dir = path.join(this.options.rootDir, `job-${jobId}`);
        mkdirSync(dir, { recursive: true });
        writeMarker(dir, { jobId, policy, createdAt: new Date().toISOString() });
        return { execDir: dir, markerPath: path.join(dir, WORKER_MARKER_FILENAME), managed: true };
      }
      case "git_worktree": {
        const repo = resolveExistingDir(targetDir);
        assertGitRepo(repo);
        const branch = `niubot-worker/${jobId}`;
        const worktreeDir = path.join(this.options.rootDir, `worktree-${jobId}`);
        runGit(repo, ["worktree", "add", "-b", branch, worktreeDir, "HEAD"]);
        writeMarker(worktreeDir, {
          jobId,
          policy,
          repo,
          branch,
          createdAt: new Date().toISOString(),
        });
        log.info("worker worktree created", { jobId, repo, worktreeDir, branch });
        return {
          execDir: worktreeDir,
          markerPath: path.join(worktreeDir, WORKER_MARKER_FILENAME),
          managed: true,
          repoPath: repo,
          branch,
        };
      }
    }
  }
}

function resolveExistingDir(target: string): string {
  if (!path.isAbsolute(target)) {
    throw new Error(`workdir 必须是绝对路径: ${target}`);
  }
  try {
    const real = realpathSync(target);
    const stat = statSync(real);
    if (!stat.isDirectory()) {
      throw new Error(`workdir 不是目录: ${target}`);
    }
    return real;
  } catch (err) {
    throw new Error(`workdir 不可访问: ${target} (${String(err)})`);
  }
}

function assertGitRepo(repo: string): void {
  try {
    runGit(repo, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new Error(`git_worktree 要求目标是 git 仓库: ${repo}`);
  }
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeMarker(dir: string, info: Record<string, unknown>): void {
  writeFileSync(path.join(dir, WORKER_MARKER_FILENAME), JSON.stringify(info, null, 2), "utf8");
}
