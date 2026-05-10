import fs from "node:fs";
import path from "node:path";

const DEFAULT_BOT_PROFILE = `# Bot Profile

在这里写 bot 的角色、语气和长期行为边界。
`;

/**
 * 确保 bot profile 文件存在。不存在时优先从旧 persona/instructions 迁移。
 * 启动时调用一次。
 */
export function ensureBotProfileFile(
  botProfilePath: string | undefined,
  legacy?: { personaPath?: string; instructionsPath?: string; workspaceDirectory?: string },
): void {
  if (!botProfilePath) return;

  try {
    if (fs.existsSync(botProfilePath)) return;
    fs.mkdirSync(path.dirname(botProfilePath), { recursive: true });
    fs.writeFileSync(botProfilePath, buildInitialBotProfile(legacy), "utf-8");
  } catch {
    // 写不了就算了，bot profile 是可选的。
  }
}

function buildInitialBotProfile(
  legacy?: { personaPath?: string; instructionsPath?: string; workspaceDirectory?: string },
): string {
  const persona = readFirstOptionalFile([
    legacy?.personaPath,
    legacy?.workspaceDirectory ? path.join(legacy.workspaceDirectory, "persona.md") : undefined,
  ]);
  const rawInstructions = readFirstOptionalFile([
    legacy?.instructionsPath,
    legacy?.workspaceDirectory ? path.join(legacy.workspaceDirectory, "instructions.md") : undefined,
  ]);
  const instructions = rawInstructions && !isDefaultLegacyInstructions(rawInstructions)
    ? rawInstructions
    : undefined;

  if (!persona && !instructions) return DEFAULT_BOT_PROFILE;

  const parts = ["# Bot Profile"];
  if (persona) {
    parts.push(`## Persona\n\n${stripHeading(persona)}`);
  }
  if (instructions) {
    parts.push(`## Instructions\n\n${stripHeading(instructions)}`);
  }

  return `${parts.join("\n\n")}\n`;
}

function readFirstOptionalFile(paths: Array<string | undefined>): string | undefined {
  for (const filePath of paths) {
    const content = readOptionalFile(filePath);
    if (content) return content;
  }
  return undefined;
}

function readOptionalFile(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content.length > 0 ? content : undefined;
  } catch {
    return undefined;
  }
}

function stripHeading(content: string): string {
  const lines = content.split(/\r?\n/);
  if (!lines[0]?.startsWith("# ")) return content;

  let start = 1;
  while (start < lines.length && lines[start]?.trim() === "") start += 1;
  return lines.slice(start).join("\n").trim();
}

function isDefaultLegacyInstructions(content: string): boolean {
  return content.includes("在这里写这个 bot 的长期职责、做事规则和边界。");
}
