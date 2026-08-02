/**
 * 内置技能安装：把包内 skills/ 同步到 bot 工作目录的 .claude/skills/。
 *
 * claude CLI 自动发现会话 cwd 下 .claude/skills/ 目录的技能（Agent 需要时
 * 自动加载 SKILL.md），因此 NiuBot 只需把内置技能放到标准位置，加载完全交给
 * CLI 原生机制。
 *
 * 同步策略（update 策略）：
 * - 目录级镜像：包内没有的技能目录 → 目标里整个删除（技能被移除时自动消失）
 * - 文件级覆盖：包内文件 → 目标里同名覆盖（技能更新自动生效）
 * - 额外文件保留：目标里包内没有的文件（如技能 installer 生成的 .env 配置）
 *   保留不动——技能是自包含单元，install.sh 管理自己的安装状态。
 *
 * 每个技能可带 install.sh（可选）：幂等安装自己的依赖/配置，启动同步后执行。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger } from "../logger.js";

const log = createLogger("skills");

/** 包内内置技能目录（开发与发布一致：包根/skills）。 */
function builtinSkillsDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  // dist/platform/skills-install.js → 包根
  return path.resolve(moduleDir, "..", "..", "skills");
}

/** 复制目录树：文件同名覆盖，保留目标里额外的文件（installer 产物）。 */
function copyTreePreservingExtra(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyTreePreservingExtra(sourcePath, targetPath);
    } else {
      cpSync(sourcePath, targetPath, { force: true });
    }
  }
}

/** 执行技能的 install.sh（可选）：幂等安装自己的配置/依赖。失败不阻断启动。 */
function runSkillInstaller(skillDir: string): void {
  const installer = path.join(skillDir, "install.sh");
  if (!existsSync(installer)) return;
  try {
    execFileSync("bash", [installer], { cwd: skillDir, stdio: "ignore", timeout: 30_000 });
    log.debug("skill installer ran", { skillDir });
  } catch (err) {
    log.warn("skill installer failed", { skillDir, error: String(err) });
  }
}

/**
 * 把内置技能同步到 bot 工作目录的 .claude/skills/。
 * 失败不阻断启动（技能缺失只影响能力，不影响 Bot 运行）。
 */
export function installBuiltinSkills(workingDirectory: string): void {
  try {
    const source = builtinSkillsDir();
    if (!existsSync(source)) {
      log.debug("no builtin skills to install", { source });
      return;
    }
    const target = path.join(workingDirectory, ".claude", "skills");
    mkdirSync(target, { recursive: true });

    // 目录级镜像：移除包内已不存在的技能目录
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!existsSync(path.join(source, entry.name))) {
        rmSync(path.join(target, entry.name), { recursive: true, force: true });
        log.info("builtin skill removed", { skill: entry.name });
      }
    }
    // 文件级覆盖 + 保留额外（installer 产物如 .env）
    copyTreePreservingExtra(source, target);

    // 每个技能跑自己的 installer（幂等）
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        runSkillInstaller(path.join(target, entry.name));
      }
    }
    log.info("builtin skills synced", { source, target });
  } catch (err) {
    log.warn("builtin skills install failed", { error: String(err) });
  }
}
