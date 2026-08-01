import { describe, expect, test } from "vitest";

import { SkillResolver } from "./skills.js";

const resolver = new SkillResolver();

describe("SkillResolver", () => {
  test("无 skills 声明时通过", () => {
    const result = resolver.resolve("general", undefined);
    expect(result.ok).toBe(true);
  });

  test("include + sharedSets 合并为 available", () => {
    const result = resolver.resolve("reviewer", {
      sharedSets: ["engineering-core"],
      include: ["code-review"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.available).toContain("code-review");
      expect(result.policy.available).toContain("code-navigation");
      expect(result.policy.available).toContain("docs-lookup");
    }
  });

  test("未知 shared set 拒绝", () => {
    const result = resolver.resolve("w", { sharedSets: ["no-such-set"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/未知 skill set/);
  });

  test("exclude 从 available 移除", () => {
    const result = resolver.resolve("w", {
      include: ["code-review", "web-research"],
      exclude: ["web-research"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.available).not.toContain("web-research");
      expect(result.policy.denied).toContain("web-research");
    }
  });

  test("未知 skill 拒绝", () => {
    const result = resolver.resolve("w", { include: ["not-a-real-skill"] });
    expect(result.ok).toBe(false);
  });

  test("required 缺失拒绝", () => {
    const result = resolver.resolve("w", { required: ["code-review"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/required skill 缺失/);
  });
});
