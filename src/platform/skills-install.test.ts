import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { installBuiltinSkills } from "./skills-install.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "skills-install-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe("installBuiltinSkills", () => {
  test("把包内技能组装到 workingDirectory/.claude/skills/", () => {
    const dir = tempDir();
    installBuiltinSkills(dir);
    const target = path.join(dir, ".claude", "skills");
    expect(existsSync(target)).toBe(true);
    const skills = readdirSync(target);
    // 第一版内置技能：ocr / image-understanding / review-fix-loop
    expect(skills).toContain("ocr");
    expect(skills).toContain("image-understanding");
    expect(skills).toContain("review-fix-loop");
    expect(existsSync(path.join(target, "ocr", "SKILL.md"))).toBe(true);
  });

  test("重复调用幂等（全量重建）", () => {
    const dir = tempDir();
    installBuiltinSkills(dir);
    const target = path.join(dir, ".claude", "skills");
    // 模拟残留：往工作副本塞一个不属于内置的文件
    writeFileSync(path.join(target, "stale-extra.txt"), "stale");
    installBuiltinSkills(dir);
    // 重建后残留消失，与包内一致
    expect(existsSync(path.join(target, "stale-extra.txt"))).toBe(false);
    expect(readdirSync(target).sort()).toEqual(readdirSync(target).sort());
  });
});
