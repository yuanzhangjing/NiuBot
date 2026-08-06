/**
 * WorkspaceProvider：Job 工作区准备（§12）。
 *
 * 访问方式（由 Profile 决定，Job 不携带）：
 * - read_only：目标目录只读参考（校验存在且是目录），另在 tmp 下建独立产物目录；
 * - direct：直接在目标目录修改（校验存在且是目录），不建隔离目录——
 *   git 操作（checkout/分支/提交）由 Worker 按任务指引自行执行。
 *
 * 产物/临时文件统一放 bot 数据目录的 tmp/ 下，Job 终态后由 Runtime 删除。
 */

import { mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { WorkspaceAccess } from "./types.js";

export interface PreparedWorkspace {
  /** 实际执行目录 */
  execDir: string;
  /** 产物目录（read_only 访问方式：目标目录只读，落盘内容写这里；终态后由 Runtime 删除） */
  artifactDir?: string;
}

export interface WorkspaceProviderOptions {
  /** 产物/临时文件根目录（bot 数据目录的 tmp/） */
  tmpRoot: string;
}

export class WorkspaceProvider {
  constructor(private readonly options: WorkspaceProviderOptions) {}

  /**
   * 准备 Job 工作区。目标路径必须存在且为绝对路径。
   * read_only：目标目录只读 + 独立产物目录；direct：直接在目标目录修改。
   */
  async prepare(jobId: string, access: WorkspaceAccess, targetDir: string): Promise<PreparedWorkspace> {
    const real = resolveExistingDir(targetDir);
    if (access === "direct") {
      return { execDir: real };
    }
    // read_only：目标目录只读，另给独立产物目录用于落盘（报告/生成文件）
    const artifactDir = path.join(this.options.tmpRoot, `job-${jobId}-artifacts`);
    mkdirSync(artifactDir, { recursive: true });
    return { execDir: real, artifactDir };
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
