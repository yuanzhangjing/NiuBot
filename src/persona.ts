import fs from "node:fs";

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
