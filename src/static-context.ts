import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.resolve(moduleDir, "..", "AGENTS.template.md");

export interface StaticContextOptions {
  personaPath?: string;
  instructionsPath?: string;
  projectContextPath?: string;
}

const DEFAULT_INSTRUCTIONS = `# Bot Instructions

在这里写这个 bot 的长期职责、做事规则和边界。
`;

const DEFAULT_PROJECT_CONTEXT = `# Project Context

在这里写这个工作区的背景、代码目录、测试命令、发布规则和常见坑。
`;

export function loadStaticContextTemplate(): string {
  return fs.readFileSync(templatePath, "utf-8");
}

export function buildStaticContext(options: StaticContextOptions = {}): string {
  const parts = [loadStaticContextTemplate().trimEnd()];
  const sources = formatSourcesSection(options);
  if (sources) {
    parts.push(sources);
  }

  return `${parts.join("\n\n")}\n`;
}

export function ensureStaticContextFiles(options: StaticContextOptions): void {
  ensureFile(options.instructionsPath, DEFAULT_INSTRUCTIONS);
  ensureFile(options.projectContextPath, DEFAULT_PROJECT_CONTEXT);
}

export function ensureWorkspaceAgentFiles(workingDirectory: string, options: StaticContextOptions = {}): void {
  const agentsPath = path.join(workingDirectory, "AGENTS.md");
  try {
    fs.mkdirSync(workingDirectory, { recursive: true });
    if (fs.existsSync(agentsPath)) {
      const existing = fs.readFileSync(agentsPath, "utf-8");
      if (!isOldGeneratedAgentsFile(existing)) return;
      const backupPath = path.join(workingDirectory, "AGENTS.niubot-generated.bak.md");
      fs.writeFileSync(backupPath, existing, "utf-8");
    }
    fs.writeFileSync(agentsPath, buildStaticContext(options), "utf-8");
  } catch {
    // Workspace rule files should not prevent the bot from starting.
  }
}

function ensureFile(filePath: string | undefined, defaultContent: string): void {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, defaultContent, "utf-8");
  } catch {
    // Optional context files should not prevent the bot from starting.
  }
}

function formatSourcesSection(options: StaticContextOptions): string | undefined {
  const sources: string[] = [];
  if (options.personaPath) {
    sources.push(`- Persona: ${options.personaPath}`);
  }
  if (options.instructionsPath) {
    sources.push(`- Bot instructions: ${options.instructionsPath}`);
  }
  if (options.projectContextPath) {
    sources.push(`- Project context: ${options.projectContextPath}`);
  }
  if (sources.length === 0) return undefined;

  return [
    "## Stable Context Sources",
    "These files are referenced by NiuBot Engine.",
    "NiuBot system rules are injected by the engine. Run `nbt system-rules` to view them.",
    "",
    ...sources,
  ].join("\n");
}

function isOldGeneratedAgentsFile(content: string): boolean {
  return content.includes("auto-generated on startup")
    || content.includes("AGENTS.md is generated. Do not edit AGENTS.md directly.");
}
