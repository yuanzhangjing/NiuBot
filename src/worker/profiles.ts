/**
 * 最小 WorkerProfileRegistry（Phase 2 静态版 + Phase 5 配置驱动）。
 *
 * 内置默认 Profile 供开箱即用；/teams config 应用后由配置覆盖（热更新只影响新 Job）。
 */

import type { TeamProfileSkills } from "./team-config.js";

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
  /** skill 声明（Phase 5；内置 profile 无声明时用默认行为） */
  skills?: TeamProfileSkills;
}

/** Team 配置的 profile → 运行时 WorkerProfile（Phase 5 配置驱动）。 */
export function teamProfileToWorkerProfile(p: {
  id: string;
  displayName?: string;
  description?: string;
  prompt: string;
  access: "read_only" | "scratch" | "git_worktree";
  maxConcurrent?: number;
  skills?: TeamProfileSkills;
}): WorkerProfile {
  return {
    id: p.id,
    displayName: p.displayName ?? p.id,
    description: p.description ?? "",
    prompt: p.prompt,
    access: p.access,
    maxConcurrent: p.maxConcurrent,
    skills: p.skills,
  };
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
  tester: {
    id: "tester",
    displayName: "Tester",
    description: "测试与验证：跑测试、复现问题、验证修复是否真正生效",
    prompt:
      "你是当前 Bot 内部的测试 Worker。你的职责：\n" +
      "- 运行测试与构建，验证修复/功能是否真正生效；\n" +
      "- 复现问题：给出可执行的复现步骤和实际观察；\n" +
      "- 不修改代码；测试中发现的问题给出文件:行号证据；\n" +
      "- 输出 Markdown：验证了什么、实际结果、结论、未覆盖项。",
    access: "read_only",
  },
};

export class WorkerProfileRegistry {
  private profiles = new Map<string, WorkerProfile>();

  constructor(profiles: WorkerProfile[] = Object.values(STATIC_WORKER_PROFILES)) {
    this.setProfiles(profiles);
  }

  /** 配置热更新：替换全部 profile（只影响新 Job，运行中 Job 使用创建时快照）。 */
  setProfiles(profiles: WorkerProfile[]): void {
    const next = new Map<string, WorkerProfile>();
    for (const profile of profiles) {
      next.set(profile.id, profile);
    }
    this.profiles = next;
  }

  get(profileId: string): WorkerProfile | undefined {
    return this.profiles.get(profileId);
  }

  list(): WorkerProfile[] {
    return [...this.profiles.values()];
  }
}
