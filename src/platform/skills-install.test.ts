import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    // 第一版内置技能：ocr / image-understanding / cr-fix-loop
    expect(skills).toContain("ocr");
    expect(skills).toContain("image-understanding");
    expect(skills).toContain("cr-fix-loop");
    expect(existsSync(path.join(target, "ocr", "SKILL.md"))).toBe(true);
  });

  test("技能内额外文件保留（installer 产物如 .env 不被清），被移除技能目录删除", () => {
    const dir = tempDir();
    installBuiltinSkills(dir);
    const target = path.join(dir, ".claude", "skills");
    // 模拟 installer 产物：技能目录内的 .env（包内没有）
    const envPath = path.join(target, "image-understanding", "scripts", ".env");
    writeFileSync(envPath, "GEMINI_API_KEY=test");
    // 模拟残留技能目录（包内没有）
    const staleDir = path.join(target, "stale-skill");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(path.join(staleDir, "SKILL.md"), "stale");

    installBuiltinSkills(dir);

    // installer 产物保留，残留技能目录被删
    expect(existsSync(envPath)).toBe(true);
    expect(existsSync(staleDir)).toBe(false);
    // 内置技能仍在
    expect(readdirSync(target)).toContain("ocr");
  });

  test("文件级镜像：技能子目录内被删的旧文件被清理（升级不残留）", () => {
    const dir = tempDir();
    installBuiltinSkills(dir);
    const target = path.join(dir, ".claude", "skills");
    // 模拟旧版本残留：技能 scripts 子目录里一个包内不存在的旧脚本
    const staleFile = path.join(target, "image-understanding", "scripts", "gemini_vision_old.sh");
    writeFileSync(staleFile, "old version");
    // 非 .env 命名 → 应被清理
    const nonEnvArtifact = path.join(target, "ocr", "scripts", "config.json");
    writeFileSync(nonEnvArtifact, "{}");

    installBuiltinSkills(dir);

    expect(existsSync(staleFile)).toBe(false);
    expect(existsSync(nonEnvArtifact)).toBe(false);
    // 包内文件仍在
    expect(existsSync(path.join(target, "image-understanding", "scripts", "gemini_vision.mjs"))).toBe(true);
  });

  test("同名覆盖：包内文件更新后覆盖目标旧版本", () => {
    const dir = tempDir();
    installBuiltinSkills(dir);
    const target = path.join(dir, ".claude", "skills");
    const sk = path.join(target, "ocr", "SKILL.md");
    // 篡改目标内容模拟旧版本
    writeFileSync(sk, "stale content");
    installBuiltinSkills(dir);
    // 同步后与包内一致（不是 stale content）
    expect(readFileSync(sk, "utf8")).toContain("name: ocr");
  });

  test("类型冲突与 .env 覆盖防御：同名目录/文件冲突不崩溃，包内 .env 不覆盖用户配置", () => {
    const dir = tempDir();
    installBuiltinSkills(dir);
    const target = path.join(dir, ".claude", "skills");
    // 目标里与包内文件同名的目录（类型冲突）→ 同步不应崩溃
    const conflictDir = path.join(target, "image-understanding", "scripts", "gemini_vision.mjs");
    rmSync(conflictDir, { force: true });
    mkdirSync(conflictDir, { recursive: true });
    writeFileSync(path.join(conflictDir, "junk.txt"), "junk");
    // 用户配置的 .env（installer 产物）
    const envFile = path.join(target, "image-understanding", "scripts", ".env");
    writeFileSync(envFile, "GEMINI_API_KEY=user-secret");

    expect(() => installBuiltinSkills(dir)).not.toThrow();

    // 冲突目录被清理（恢复为包内文件）
    expect(statSync(conflictDir).isFile()).toBe(true);
    // .env 保留（不被覆盖/删除）
    expect(readFileSync(envFile, "utf8")).toBe("GEMINI_API_KEY=user-secret");
  });
});
