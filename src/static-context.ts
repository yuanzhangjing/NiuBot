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

  const persona = readOptionalMarkdown(options.personaPath);
  if (persona) {
    parts.push(formatSection("Bot Persona", options.personaPath, persona));
  }

  const instructions = readOptionalMarkdown(options.instructionsPath, DEFAULT_INSTRUCTIONS);
  if (instructions) {
    parts.push(formatSection("Bot Instructions", options.instructionsPath, instructions));
  }

  const projectContext = readOptionalMarkdown(options.projectContextPath, DEFAULT_PROJECT_CONTEXT);
  if (projectContext) {
    parts.push(formatSection("Project Context", options.projectContextPath, projectContext));
  }

  return `${parts.join("\n\n")}\n`;
}

export function ensureStaticContextFiles(options: StaticContextOptions): void {
  ensureFile(options.instructionsPath, DEFAULT_INSTRUCTIONS);
  ensureFile(options.projectContextPath, DEFAULT_PROJECT_CONTEXT);
}

function readOptionalMarkdown(filePath: string | undefined, defaultContent?: string): string | undefined {
  if (!filePath) return undefined;
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (defaultContent && content === defaultContent.trim()) return undefined;
    return content || undefined;
  } catch {
    return undefined;
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

function formatSection(title: string, sourcePath: string | undefined, content: string): string {
  const source = sourcePath ? `\nSource: ${sourcePath}\n` : "\n";
  return `## ${title}${source}\n${stripDuplicateHeading(content, title)}`;
}

function stripDuplicateHeading(content: string, title: string): string {
  const lines = content.split(/\r?\n/);
  const firstLine = lines[0]?.trim();
  if (firstLine !== `# ${title}`) return content;

  let start = 1;
  while (start < lines.length && lines[start]?.trim() === "") {
    start += 1;
  }
  return lines.slice(start).join("\n").trim();
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
    "AGENTS.md is generated. Do not edit AGENTS.md directly.",
    "To update stable bot or project context, edit the source files below. Changes apply when a new agent session is created.",
    "If the user needs changes to apply immediately in the current chat, tell them to start a new session with `/new` after the source file update is complete.",
    "",
    ...sources,
  ].join("\n");
}
