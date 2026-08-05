/**
 * WorkspaceProvider：Job 工作区准备（§12）。
 *
 * 访问方式（由 Profile 决定，Job 不再携带）：
 * - read_only：目标目录只读参考（校验存在且是目录），另在 tmp 下建独立产物目录；
 * - direct：直接在目标目录修改（校验存在且是目录），不建隔离目录、不写 marker——
 *   git 操作（clone/checkout/分支/提交）由 Worker 按任务指引自行执行。
 *
 * 产物/临时文件统一放 bot 数据目录的 tmp/ 下，不再使用独立的 worker-workspaces 根。
 */

import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createLogger } from "../logger.js";

const log = createLogger("worker-workspace");

export const WORKER_MARKER_FILENAME = ".niubot-worker";

export interface PreparedWorkspace {
  /** 实际执行目录 */
  execDir: string;
  /** 是否由 Runtime 管理（产物目录等临时文件） */
  managed: boolean;
  /** 产物目录（read_only 访问方式：目标目录只读，落盘内容写这里） */
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
   * 未知访问方式（存量配置防御）按 read_only 处理，避免静默写入。
   */
  async prepare(jobId: string, access: "read_only" | "direct", targetDir: string): Promise<PreparedWorkspace> {
    const real = resolveExistingDir(targetDir);
    if (access === "direct") {
      return { execDir: real, managed: false };
    }
    // read_only（含未知值防御）：目标目录只读，另给独立产物目录用于落盘（报告/生成文件）
    const artifactDir = path.join(this.options.tmpRoot, `job-${jobId}-artifacts`);
    mkdirSync(artifactDir, { recursive: true });
    writeMarker(artifactDir, { jobId, access, createdAt: new Date().toISOString() });
    return { execDir: real, artifactDir, managed: true };
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
