import fs from "node:fs";
import path from "node:path";

const DEFAULT_PERSONA = `## 角色
通用 AI 助手

## 风格
简洁、专业。
`;

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
