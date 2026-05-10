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

const DEFAULT_REPOS_AGENTS = `# Repositories

This directory contains real code repositories.

Each first-level directory under \`repos/\` is a repository.

Work inside the target repo when modifying code, running tests, or using git.
Do not put scratch files, reports, or one-off notes directly under \`repos/\`.
`;

const DEFAULT_TASKS_AGENTS = `# Tasks

Formal tasks are managed by \`nbt task\`.

Do not create task directories manually.
Task README files are the source of truth for task progress.
Only active tasks are injected into agent sessions.
`;

const DEFAULT_TMP_AGENTS = `# Temporary Workspace

This directory is for temporary files, drafts, command outputs, and one-off analysis.

Files here are not stable project context.
They may be deleted.

If something becomes important, summarize it into the relevant task README or repo docs.
`;

export function loadStaticContextTemplate(): string {
  return fs.readFileSync(templatePath, "utf-8");
}

export function buildStaticContext(_options: StaticContextOptions = {}): string {
  return `${loadStaticContextTemplate().trimEnd()}\n`;
}

export function ensureStaticContextFiles(options: StaticContextOptions): void {
  ensureFile(options.instructionsPath, DEFAULT_INSTRUCTIONS);
  ensureFile(options.projectContextPath, DEFAULT_PROJECT_CONTEXT);
}

export function ensureWorkspaceAgentFiles(workingDirectory: string, options: StaticContextOptions = {}): void {
  const agentsPath = path.join(workingDirectory, "AGENTS.md");
  try {
    fs.mkdirSync(workingDirectory, { recursive: true });
    ensureWorkspaceLayoutFiles(workingDirectory);
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

function ensureWorkspaceLayoutFiles(workingDirectory: string): void {
  ensureFile(path.join(workingDirectory, "repos", "AGENTS.md"), DEFAULT_REPOS_AGENTS);
  ensureFile(path.join(workingDirectory, "tasks", "AGENTS.md"), DEFAULT_TASKS_AGENTS);
  ensureFile(path.join(workingDirectory, "tmp", "AGENTS.md"), DEFAULT_TMP_AGENTS);
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

function isOldGeneratedAgentsFile(content: string): boolean {
  return content.includes("auto-generated on startup")
    || content.includes("AGENTS.md is generated. Do not edit AGENTS.md directly.");
}
