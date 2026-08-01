/**
 * SkillResolver（Phase 5 简化版）。
 *
 * Skill 分层（方案 §11）：系统必需 skill（始终共享，不可禁用）∪ sharedSets ∪
 * profile include ∪ Job 临时 include - profile exclude - Bot hard deny。
 * 第一版没有 Job 临时 include 和 Bot hard deny 的配置来源，只解析 profile 自身。
 */

import type { TeamProfileSkills } from "./team-config.js";

/** 内置可用 skill 清单（Bot 级安装；后续可扩展） */
export const KNOWN_SKILLS = new Set([
  "code-review",
  "web-research",
  "test-inspection",
  "docs-lookup",
  "code-navigation",
]);

/** 共享 skill 集定义（§8）：sharedSets 引用集合名，按此展开 */
export const SHARED_SKILL_SETS: Record<string, string[]> = {
  "engineering-core": ["code-navigation", "test-inspection", "docs-lookup"],
  "research-core": ["web-research", "docs-lookup"],
};

/** 系统必需 skill：所有 Worker 始终拥有，profile 不能排除 */
export const SYSTEM_REQUIRED_SKILLS = new Set<string>([]);

export interface ResolvedSkillPolicy {
  available: string[];
  required: string[];
  denied: string[];
  /** 未识别的 skill 是否被拒绝（严格模式） */
  strict: boolean;
}

export class SkillResolver {
  constructor(
    private readonly knownSkills: Set<string> = KNOWN_SKILLS,
    private readonly systemRequired: Set<string> = SYSTEM_REQUIRED_SKILLS,
    private readonly sharedSets: Record<string, string[]> = SHARED_SKILL_SETS,
  ) {}

  /** 解析 profile 的 skill 声明；返回校验结果，required 缺失时 ok=false。 */
  resolve(profileId: string, skills: TeamProfileSkills | undefined): { ok: true; policy: ResolvedSkillPolicy } | { ok: false; error: string } {
    const include = new Set<string>(this.systemRequired);
    const denied = new Set<string>();
    if (skills) {
      for (const setName of skills.sharedSets ?? []) {
        const expanded = this.sharedSets[setName];
        if (!expanded) {
          return { ok: false, error: `profile ${profileId} 引用未知 skill set: ${setName}` };
        }
        for (const s of expanded) include.add(s);
      }
      for (const s of skills.include ?? []) {
        include.add(s);
      }
      for (const s of skills.exclude ?? []) {
        include.delete(s);
        denied.add(s);
      }
    }
    const unknown = [...include].filter((s) => !this.knownSkills.has(s) && !this.systemRequired.has(s));
    if (unknown.length > 0) {
      return { ok: false, error: `profile ${profileId} 引用未知 skill: ${unknown.join(", ")}` };
    }
    const required = [...(skills?.required ?? [])];
    const missingRequired = required.filter((s) => !include.has(s));
    if (missingRequired.length > 0) {
      return { ok: false, error: `profile ${profileId} 的 required skill 缺失: ${missingRequired.join(", ")}` };
    }
    return {
      ok: true,
      policy: {
        available: [...include].sort(),
        required,
        denied: [...denied].sort(),
        strict: true,
      },
    };
  }
}
