import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { installBuiltinSkills, syncMountLinks } from "./skills-install.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "skills-install-"));
  tempDirs.push(dir);
  return dir;
}

/** 构造一个 bot 工作目录（.claude/.agents 在其中）。 */
function setupBot(backupRoot: string): { dir: string; claudeMount: string; agentsMount: string } {
  const dir = tempDir();
  installBuiltinSkills(dir, backupRoot);
  return {
    dir,
    claudeMount: path.join(dir, ".claude", "skills"),
    agentsMount: path.join(dir, ".agents", "skills"),
  };
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

describe("installBuiltinSkills（备份源 + 双挂载软链接）", () => {
  test("备份源镜像 + .claude/.agents 双挂载软链接", () => {
    const backupRoot = tempDir();
    const { dir, claudeMount, agentsMount } = setupBot(backupRoot);
    // 备份源：真实目录
    for (const name of ["ocr", "image-understanding", "cr-fix-loop"]) {
      expect(existsSync(path.join(backupRoot, name, "SKILL.md"))).toBe(true);
    }
    // 双挂载点：软链接指向备份源
    for (const mount of [claudeMount, agentsMount]) {
      for (const name of ["ocr", "image-understanding", "cr-fix-loop"]) {
        const link = path.join(mount, name);
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readlinkSync(link)).toBe(path.join(backupRoot, name));
      }
    }
  });

  test("用户自装 skill（真实目录）保留不动", () => {
    const backupRoot = tempDir();
    const { dir, claudeMount, agentsMount } = setupBot(backupRoot);
    // 用户往两个挂载点放自己的 skill（真实目录）
    for (const mount of [claudeMount, agentsMount]) {
      mkdirSync(path.join(mount, "user-skill"), { recursive: true });
      writeFileSync(path.join(mount, "user-skill", "SKILL.md"), "user skill");
    }
    installBuiltinSkills(dir, backupRoot);
    for (const mount of [claudeMount, agentsMount]) {
      expect(existsSync(path.join(mount, "user-skill", "SKILL.md"))).toBe(true);
      expect(lstatSync(path.join(mount, "user-skill")).isSymbolicLink()).toBe(false);
    }
  });

  test("备份源删除技能 → 挂载点软链接被清理（用户 skill 不受影响）", () => {
    const backupRoot = tempDir();
    const { claudeMount } = setupBot(backupRoot);
    // 挂载点已有内置链接 + 用户 skill（真实目录）+ 用户自建链接（指向别处）
    mkdirSync(path.join(claudeMount, "user-skill"), { recursive: true });
    writeFileSync(path.join(claudeMount, "user-skill", "SKILL.md"), "user");
    const elsewhere = tempDir();
    symlinkSync(elsewhere, path.join(claudeMount, "user-link"), "dir");
    // 模拟升级移除：备份源里 cr-fix-loop 已不存在（真实链路：mirrorTree 已同步）
    rmSync(path.join(backupRoot, "cr-fix-loop"), { recursive: true, force: true });
    syncMountLinks(claudeMount, backupRoot);
    // 指向备份源但源里没有的链接被清理
    expect(existsSync(path.join(claudeMount, "cr-fix-loop"))).toBe(false);
    // 用户 skill（真实目录）与用户自建链接保留
    expect(existsSync(path.join(claudeMount, "user-skill", "SKILL.md"))).toBe(true);
    expect(lstatSync(path.join(claudeMount, "user-link")).isSymbolicLink()).toBe(true);
    // 其余内置技能链接不受影响
    expect(lstatSync(path.join(claudeMount, "ocr")).isSymbolicLink()).toBe(true);
  });

  test("旧版复制残留（真实目录与备份同名）迁移为软链接", () => {
    const backupRoot = tempDir();
    const { dir, claudeMount, agentsMount } = setupBot(backupRoot);
    // 模拟旧版复制残留：把 .claude 挂载点的 ocr 换成真实目录（旧版复制）
    rmSync(path.join(claudeMount, "ocr"), { force: true });
    mkdirSync(path.join(claudeMount, "ocr"), { recursive: true });
    writeFileSync(path.join(claudeMount, "ocr", "SKILL.md"), "old copy");
    installBuiltinSkills(dir, backupRoot);
    // 迁移：真实目录被替换为软链接
    expect(lstatSync(path.join(claudeMount, "ocr")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(claudeMount, "ocr"))).toBe(path.join(backupRoot, "ocr"));
    expect(existsSync(path.join(backupRoot, "ocr", "SKILL.md"))).toBe(true);
  });

  test("重复安装幂等：链接稳定指向备份源，内容来自备份源（包内即真相）", () => {
    const backupRoot = tempDir();
    const { dir, claudeMount } = setupBot(backupRoot);
    // 再次安装（模拟下次启动）
    installBuiltinSkills(dir, backupRoot);
    // 链接不变（无累积、无重建），内容 = 备份源（= 包内当前版本）
    expect(readlinkSync(path.join(claudeMount, "ocr"))).toBe(path.join(backupRoot, "ocr"));
    expect(readFileSync(path.join(claudeMount, "ocr", "SKILL.md"), "utf8"))
      .toContain("name: ocr");
  });

  test("installer 产物（.env）在备份源保留", () => {
    const backupRoot = tempDir();
    const { dir, claudeMount } = setupBot(backupRoot);
    // installer 产物写入备份源
    const envPath = path.join(backupRoot, "image-understanding", "scripts", ".env");
    writeFileSync(envPath, "GEMINI_API_KEY=secret");
    installBuiltinSkills(dir, backupRoot);
    expect(readFileSync(envPath, "utf8")).toBe("GEMINI_API_KEY=secret");
  });
});
