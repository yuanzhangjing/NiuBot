/**
 * 内置技能安装：把包内 skills/ 同步到 bot 工作目录的 .claude/skills/。
 *
 * claude CLI 自动发现会话 cwd 下 .claude/skills/ 目录的技能（Agent 需要时
 * 自动加载 SKILL.md），因此 NiuBot 只需把内置技能放到标准位置，加载完全交给
 * CLI 原生机制。
 *
 * 同步策略（update 策略）：
 * - 目录级镜像：包内没有的技能目录 → 目标里整个删除（技能被移除时自动消失）
 * - 文件级镜像：目标里源没有的文件 → 删除（技能内被删文件不残留），
 *   但保留 installer 产物（scripts/.env 等 .env 文件）
 * - 包内文件 → 同名覆盖（技能更新自动生效）
 *
 * 每个技能可带 install.mjs（可选，Node 跨平台）：幂等安装自己的依赖/配置；
 * 没有 install.mjs 的技能走默认通用行为（无操作）。installer 异步执行
 * （不阻塞启动），输出写入日志。
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, type Dirent } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger } from "../logger.js";

const log = createLogger("skills");

/**
 * installer 产物白名单：同步删除时保留的文件名（技能自管配置）。
 * 契约：installer 的持久化配置统一以 .env 命名（如 scripts/.env）；
 * 其他非 .env 命名的技能内文件会被同步清理（视为包内文件的残留）。
 */
const INSTALLER_ARTIFACT_PATTERN = /\.env(?:\.local)?$/;

/** 包内内置技能目录（开发与发布一致：包根/skills）。 */
function builtinSkillsDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  // dist/platform/skills-install.js → 包根
  return path.resolve(moduleDir, "..", "..", "skills");
}

/** 镜像复制：包内文件覆盖同名；删除目标里源没有的文件（保留 installer 产物）。 */
function mirrorTree(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  // 删除目标里源没有的条目（installer 产物保留；符号链接只删链接本身，不跟随）。
  // 源条目存在性用 lstatSync（不跟随链接）：broken symlink 的 lstat 仍成功
  // （链接本身存在）→ 保留目标不删；只有 ENOENT（真缺失）才删——其他错误
  // （EACCES/EPERM 等）按"无法确认"fail-safe 保留，避免权限问题误删整个目标树。
  for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
    if (INSTALLER_ARTIFACT_PATTERN.test(entry.name)) continue;
    // 隔离区（含产物被移动来的目录）不自动清理，人工处理
    if (entry.name.startsWith(".removed-")) continue;
    let sourceExists = true;
    try {
      lstatSync(path.join(sourceDir, entry.name));
    } catch (err) {
      sourceExists = (err as NodeJS.ErrnoException)?.code !== "ENOENT";
    }
    if (!sourceExists) {
      const targetPath = path.join(targetDir, entry.name);
      // 整目录删除会带走嵌套的 installer 产物（.env）——含产物的目录
      // 隔离移动到 .removed-<ts>/（数据不销毁，人工处理），无产物的直接删
      const nestedArtifacts = findInstallerArtifacts(targetPath);
      if (nestedArtifacts.length > 0) {
        const quarantineDir = path.join(targetDir, `.removed-${Date.now()}`);
        try {
          mkdirSync(quarantineDir, { recursive: true });
          renameSync(targetPath, path.join(quarantineDir, entry.name));
          log.warn("skill entry with installer artifacts quarantined", { targetPath, quarantineDir });
        } catch (err) {
          log.warn("skill entry quarantine failed, keeping entry", { targetPath, error: String(err) });
        }
      } else {
        try {
          rmSync(targetPath, { recursive: true, force: true });
        } catch (err) {
          log.warn("skill target entry removal failed, skipping", { target: entry.name, error: String(err) });
        }
      }
    }
  }
  // 复制/覆盖源条目
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    // 源里的 installer 产物命名（.env）不复制——配置由 install.mjs 管理，
    // 避免包内模板每次启动覆盖用户配置
    if (INSTALLER_ARTIFACT_PATTERN.test(entry.name)) continue;
    // 源实体类型用 statSync（跟随 symlink——Dirent.isDirectory 对 symlink 恒 false，
    // 避免把指向目录的源 symlink 误判为文件）。broken symlink / 读取失败时跳过
    // 该条目（条目级隔离，不让单个坏条目中断整个同步）。
    let sourceIsDir: boolean;
    try {
      sourceIsDir = statSync(sourcePath).isDirectory();
    } catch {
      log.warn("skill source entry unreadable, skipping", { sourcePath });
      continue;
    }
    // 指向目录的源 symlink：跳过（防镜像递归环/无限嵌套复制）；
    // 指向文件的 symlink 走下方 cpSync dereference 复制实体内容
    if (sourceIsDir) {
      let sourceLstat: ReturnType<typeof lstatSync>;
      try {
        sourceLstat = lstatSync(sourcePath);
      } catch {
        continue;
      }
      if (sourceLstat.isSymbolicLink()) {
        log.warn("skill source directory symlink skipped (cycle guard)", { sourcePath });
        continue;
      }
    }
    // 目标同名但类型不一致（文件 vs 目录）或目标是符号链接时，先清掉再复制
    // （防 ERR_FS_CP_NON_DIR_TO_DIR；符号链接只删链接本身，不跟随避免删到工作区外）
    let targetStat: ReturnType<typeof lstatSync> | undefined;
    try {
      targetStat = lstatSync(targetPath);
    } catch {
      targetStat = undefined;
    }
    if (targetStat && (targetStat.isSymbolicLink() || targetStat.isDirectory() !== sourceIsDir)) {
      // 类型冲突清理会整目录删除：若目标目录里存在 installer 产物（.env），
      // 父路径被替换为文件时无法保留——显式告警（installer 会重建并重新引导配置）
      if (targetStat.isDirectory() && !sourceIsDir) {
        const artifactsInTarget = findInstallerArtifacts(targetPath);
        if (artifactsInTarget.length > 0) {
          log.warn("skill type conflict will remove installer artifacts", {
            targetPath,
            artifacts: artifactsInTarget,
          });
        }
      }
      try {
        rmSync(targetPath, { recursive: true, force: true });
      } catch (err) {
        log.warn("skill target type-conflict removal failed, skipping", { targetPath, error: String(err) });
        continue;
      }
      targetStat = undefined;
    }
    try {
      if (sourceIsDir) {
        mirrorTree(sourcePath, targetPath);
      } else {
        cpSync(sourcePath, targetPath, { force: true, dereference: true });
      }
    } catch (err) {
      log.warn("skill entry sync failed, skipping", { sourcePath, error: String(err) });
    }
  }
}

/**
 * 递归查找目录里的 installer 产物（.env 命名），用于删除前的告警。
 * 目录判断用 statSync 跟随 symlink（Dirent.isDirectory 对 symlink 恒 false，
 * 会漏报链接子目录里的产物）；深度限制防 symlink 环。
 */
function findInstallerArtifacts(dir: string, depth = 0): string[] {
  const found: string[] = [];
  if (depth > 20) return found;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (INSTALLER_ARTIFACT_PATTERN.test(entry.name)) {
      found.push(path.join(dir, entry.name));
      continue;
    }
    if (entry.isDirectory()) {
      found.push(...findInstallerArtifacts(path.join(dir, entry.name), depth + 1));
      continue;
    }
    // symlink 子目录：statSync 跟随判断，防漏报
    try {
      if (statSync(path.join(dir, entry.name)).isDirectory()) {
        found.push(...findInstallerArtifacts(path.join(dir, entry.name), depth + 1));
      }
    } catch {
      // broken symlink：忽略
    }
  }
  return found;
}

/**
 * 执行技能的 install.mjs（可选，异步不阻塞启动）：幂等安装自己的配置/依赖。
 * installer 用 Node 脚本（NiuBot 运行时有 Node，跨平台零额外依赖）；
 * 没有 install.mjs 的技能走默认行为（无操作）。
 * 输出捕获后写入日志（installer 的提示用户要能看到）。
 */
function runSkillInstaller(skillDir: string): void {
  const installer = path.join(skillDir, "install.mjs");
  if (!existsSync(installer)) return;
  execFile(process.execPath, [installer], { cwd: skillDir, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      log.warn("skill installer failed", { skillDir, error: String(err) });
      return;
    }
    const output = `${stdout}${stderr}`.trim();
    if (output) log.info(`skill installer: ${path.basename(skillDir)}`, { output });
  });
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
    mirrorTree(source, target);

    // 每个技能跑自己的 installer（幂等，异步）
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
