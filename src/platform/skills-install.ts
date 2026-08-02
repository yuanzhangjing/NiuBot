/**
 * 内置技能安装：把包内 skills/ 组装到 bot 工作目录的 .claude/skills/。
 *
 * claude CLI 自动发现会话 cwd 下 .claude/skills/ 目录的技能（Agent 需要时
 * 自动加载 SKILL.md），因此 NiuBot 只需把内置技能放到标准位置，加载完全交给
 * CLI 原生机制。
 *
 * 每次启动全量重建（rm + copy）——包内即真相：内置技能更新/删减自动跟随版本，
 * 无残留。技能目录保持纯只读（只有包内文件），敏感配置（如 GEMINI_API_KEY）
 * 一律走环境变量（~/.niubot/.env，dotenv 启动加载），不落技能目录。
 */

import { cpSync, existsSync, rmSync } from "node:fs";
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

/**
 * 把内置技能组装到 bot 工作目录的 .claude/skills/（全量重建）。
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
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true });
    log.info("builtin skills installed", { source, target });
  } catch (err) {
    log.warn("builtin skills install failed", { error: String(err) });
  }
}
