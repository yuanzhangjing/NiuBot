/**
 * WorkspaceProvider：Job 工作区准备（§12）。
 *
 * 策略：
 * - read_only：直接使用目标目录（校验存在且是目录），不做任何写操作；
 * - scratch：在 scratchRoot 下创建独立临时目录（带 marker）。写任务的 git 操作
 *   （clone/checkout/分支）由 Worker 按任务指引自行执行，base 提交由任务内容指定。
 *
 * 保留策略：失败/取消/完成后工作区默认保留（marker 标记来源），安全确认前不自动删除。
 */

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
  /** 是否由 Runtime 管理（scratch） */
  managed: boolean;
  /** 产物目录（read_only 策略：工作目录只读，落盘内容写这里） */
  artifactDir?: string;
}

export interface WorkspaceProviderOptions {
  /** scratch 工作区根目录（默认 $NIUBOT_HOME/worker-workspaces） */
  rootDir: string;
}

export class WorkspaceProvider {
  constructor(private readonly options: WorkspaceProviderOptions) {}

  /**
   * 准备 Job 工作区。目标路径必须存在且为绝对路径。
   * 未知/非法策略（存量数据）按 scratch 处理，避免静默落到目标目录。
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
      case "scratch":
      default: {
        const dir = path.join(this.options.rootDir, `job-${jobId}`);
        mkdirSync(dir, { recursive: true });
        writeMarker(dir, { jobId, policy, createdAt: new Date().toISOString() });
        log.info("worker scratch workspace prepared", { jobId, policy, dir });
        return { execDir: dir, markerPath: path.join(dir, WORKER_MARKER_FILENAME), managed: true };
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

function writeMarker(dir: string, info: Record<string, unknown>): void {
  writeFileSync(path.join(dir, WORKER_MARKER_FILENAME), JSON.stringify(info, null, 2), "utf8");
}
