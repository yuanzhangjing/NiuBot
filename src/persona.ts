import fs from "node:fs";
import path from "node:path";

const DEFAULT_PERSONA = `> 此文件定义 bot 的行为风格，管理员可要求 bot 自行修改。

## 角色
通用 AI 助手

## 风格
简洁、专业。
`;

/**
 * 读取 persona 文件内容。
 * 每次 session 创建时调用，支持不重启热更新。
 * 文件不存在时返回 undefined（persona 是可选的）。
 */
export function loadPersona(personaPath: string): string | undefined {
  try {
    const content = fs.readFileSync(personaPath, "utf-8").trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 确保 persona 文件存在。不存在时用默认模板创建。
 * 启动时调用一次。
 */
export function ensurePersonaFile(personaPath: string): void {
  try {
    if (fs.existsSync(personaPath)) return;
    fs.mkdirSync(path.dirname(personaPath), { recursive: true });
    fs.writeFileSync(personaPath, DEFAULT_PERSONA, "utf-8");
  } catch {
    // 写不了就算了，persona 是可选的
  }
}
