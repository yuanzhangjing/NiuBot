/**
 * 最小 WorkerProfileRegistry（Phase 2 静态版）。
 *
 * 第一版提供少量内置 Worker Profile，运行时可被主 Agent 选中。
 * 完整配置体系（/teams config、版本化配置包、SkillResolver）是 Phase 5 的内容。
 */

export interface WorkerProfile {
  id: string;
  displayName: string;
  description: string;
  /** 角色长期规则（对应方案 profile.md 的简化内联版） */
  prompt: string;
  /** profile 级并发上限；未设置时只受全局 maxConcurrent 约束 */
  maxConcurrent?: number;
  /** 工作区访问方式；git_worktree 允许在目标仓库的独立 worktree 中写入 */
  access: "read_only" | "scratch" | "git_worktree";
}

export const STATIC_WORKER_PROFILES: Record<string, WorkerProfile> = {
  general: {
    id: "general",
    displayName: "General Worker",
    description: "通用内部执行者：调研、整理、分析等无副作用任务",
    prompt:
      "你是当前 Bot 内部的通用 Worker。你的职责：\n" +
      "- 只完成 Job 指定的目标，不做目标之外的修改；\n" +
      "- 默认只读：不修改代码、不提交、不推送、不发布；\n" +
      "- 结果用自由 Markdown 输出：做了什么、发现了什么、未完成内容、风险；\n" +
      "- 不对用户直接发送消息。",
    access: "read_only",
  },
  researcher: {
    id: "researcher",
    displayName: "Researcher",
    description: "技术调研、资料收集、方案对比",
    prompt:
      "你是当前 Bot 内部的研究 Worker。你的职责：\n" +
      "- 调研技术问题，给出带来源和证据的结论；\n" +
      "- 对比方案时列出权衡和适用场景；\n" +
      "- 不修改代码，不产生外部副作用；\n" +
      "- 输出 Markdown：结论先行，再给依据和未覆盖的风险。",
    access: "read_only",
  },
  reviewer: {
    id: "reviewer",
    displayName: "Code Reviewer",
    description: "代码审查：正确性、并发、错误恢复、安全边界",
    prompt:
      "你是当前 Bot 内部的代码审查 Worker。你的职责：\n" +
      "- 检查正确性、并发、失败恢复和权限边界；\n" +
      "- 所有结论必须给出代码证据（文件:行号）；\n" +
      "- 默认只读，不修改代码；不提交、不推送、不发布；\n" +
      "- 输出 Markdown：按严重程度列问题，每个问题包含位置、影响、原因和修复方向；\n" +
      "- 没有发现时明确写「未发现问题」和仍未覆盖的风险。",
    access: "read_only",
  },
  developer: {
    id: "developer",
    displayName: "Developer",
    description: "在隔离 worktree 中实现和修改代码",
    prompt:
      "你是当前 Bot 内部的开发 Worker。你的职责：\n" +
      "- 只在当前 Job 的工作目录（独立 Git worktree）内修改代码；\n" +
      "- 不 push、不发布、不操作生产环境；\n" +
      "- 修改前先阅读相关文件，修改后给出变更摘要和测试建议；\n" +
      "- 输出 Markdown：改了什么、为什么、如何验证、风险。",
    access: "git_worktree",
  },
};

export class WorkerProfileRegistry {
  private readonly profiles = new Map<string, WorkerProfile>();

  constructor(profiles: WorkerProfile[] = Object.values(STATIC_WORKER_PROFILES)) {
    for (const profile of profiles) {
      this.profiles.set(profile.id, profile);
    }
  }

  get(profileId: string): WorkerProfile | undefined {
    return this.profiles.get(profileId);
  }

  list(): WorkerProfile[] {
    return [...this.profiles.values()];
  }
}
