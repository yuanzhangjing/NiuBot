import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildStaticContext,
  ensureStaticContextFiles,
  ensureWorkspaceAgentFiles,
  loadStaticContextTemplate,
} from "./static-context.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadStaticContextTemplate", () => {
  it("loads the user-owned workspace AGENTS template", () => {
    const content = loadStaticContextTemplate();

    expect(content).toContain("# Workspace Rules");
    expect(content).toContain("## Project");
    expect(content).toContain("## Workspace Layout");
    expect(content).toContain("`persona.md`");
    expect(content).toContain("`instructions.md`");
    expect(content).toContain("`repos/`");
    expect(content).toContain("`tasks/`");
    expect(content).toContain("`tmp/`");
    expect(content).not.toContain("`.niubot/`");
    expect(content).not.toContain("## Working Rules");
    expect(content).not.toContain("## Memory Rules");
    expect(content).not.toContain("Describe how agents should work");
    expect(content).not.toContain("Do NOT modify this file");
    expect(content).not.toContain("NiuBot Engine service");
  });

  it("AGENTS.template.md is included in package.json files", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));
    expect(pkg.files).toContain("AGENTS.template.md");
  });

  it("AGENTS.template.md exists at project root", () => {
    const exists = fs.existsSync(path.join(rootDir, "AGENTS.template.md"));
    expect(exists).toBe(true);
  });

  it("keeps buildStaticContext as the workspace template without source references", () => {
    const dir = fs.mkdtempSync(path.join(rootDir, ".tmp-static-context-"));
    tempDirs.push(dir);

    const personaPath = path.join(dir, "persona.md");
    const instructionsPath = path.join(dir, "instructions.md");
    const projectContextPath = path.join(dir, "project.md");
    fs.writeFileSync(personaPath, "plain persona text", "utf-8");
    fs.writeFileSync(instructionsPath, "bot rule text", "utf-8");
    fs.writeFileSync(projectContextPath, "project background text", "utf-8");

    const content = buildStaticContext({
      personaPath,
      instructionsPath,
      projectContextPath,
    });

    expect(content).toContain("# Workspace Rules");
    expect(content).not.toContain("plain persona text");
    expect(content).not.toContain("bot rule text");
    expect(content).not.toContain("project background text");
    expect(content).not.toContain(personaPath);
    expect(content).not.toContain(instructionsPath);
    expect(content).not.toContain(projectContextPath);
    expect(content).not.toContain("## Stable Context Sources");
  });

  it("does not compose source file contents into AGENTS.md", () => {
    const dir = fs.mkdtempSync(path.join(rootDir, ".tmp-static-context-"));
    tempDirs.push(dir);

    const instructionsPath = path.join(dir, "instructions.md");
    fs.writeFileSync(instructionsPath, "# Bot Instructions\n\nbot rule text", "utf-8");

    const content = buildStaticContext({ instructionsPath });

    expect(content).toContain("# Workspace Rules");
    expect(content).not.toContain(instructionsPath);
    expect(content).not.toContain("## Bot Instructions");
    expect(content).not.toContain("bot rule text");
    expect(content).not.toContain("# Bot Instructions\n\nbot rule text");
  });

  it("does not compose untouched default instructions or project templates", () => {
    const dir = fs.mkdtempSync(path.join(rootDir, ".tmp-static-context-"));
    tempDirs.push(dir);

    const instructionsPath = path.join(dir, "instructions.md");
    ensureStaticContextFiles({ instructionsPath });

    const content = buildStaticContext({ instructionsPath });

    expect(content).not.toContain("## Bot Instructions");
    expect(content).not.toContain("## Project Context");
    expect(content).not.toContain("在这里写这个 bot 的长期职责");
    expect(content).not.toContain("在这里写这个工作区的背景");
  });

  it("does not list stable context source files in AGENTS.md", () => {
    const dir = fs.mkdtempSync(path.join(rootDir, ".tmp-static-context-"));
    tempDirs.push(dir);

    const personaPath = path.join(dir, "persona.md");
    const instructionsPath = path.join(dir, "instructions.md");
    ensureStaticContextFiles({ instructionsPath });

    const content = buildStaticContext({
      personaPath,
      instructionsPath,
    });

    expect(content).not.toContain("## Stable Context Sources");
    expect(content).not.toContain(personaPath);
    expect(content).not.toContain(instructionsPath);
    expect(content).not.toContain("Project context:");
    expect(content).not.toContain("These files are referenced by NiuBot Engine.");
    expect(content).not.toContain("Do not edit AGENTS.md directly");
  });
});

describe("ensureWorkspaceAgentFiles", () => {
  it("creates a workspace AGENTS.md when missing without creating CLAUDE.md", () => {
    const dir = fs.mkdtempSync(path.join(rootDir, ".tmp-static-context-"));
    tempDirs.push(dir);

    ensureWorkspaceAgentFiles(dir, {});

    const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("# Workspace Rules");
    expect(fs.existsSync(path.join(dir, "CLAUDE.md"))).toBe(false);
  });

  it("creates workspace layout placeholders without requiring a formal task", () => {
    const dir = fs.mkdtempSync(path.join(rootDir, ".tmp-static-context-"));
    tempDirs.push(dir);

    ensureWorkspaceAgentFiles(dir, {});

    expect(fs.readFileSync(path.join(dir, "repos", "AGENTS.md"), "utf-8")).toContain("code repositories");
    expect(fs.readFileSync(path.join(dir, "tasks", "AGENTS.md"), "utf-8")).toContain("Formal tasks");
    expect(fs.readFileSync(path.join(dir, "tmp", "AGENTS.md"), "utf-8")).toContain("temporary files");
    expect(fs.existsSync(path.join(dir, "tasks", "README.md"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".niubot", "project.md"))).toBe(false);
  });

  it("does not overwrite an existing user AGENTS.md", () => {
    const dir = fs.mkdtempSync(path.join(rootDir, ".tmp-static-context-"));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "user custom rules", "utf-8");

    ensureWorkspaceAgentFiles(dir, {});

    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toBe("user custom rules");
  });

  it("does not overwrite existing workspace layout placeholder files", () => {
    const dir = fs.mkdtempSync(path.join(rootDir, ".tmp-static-context-"));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, "tmp"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tmp", "AGENTS.md"), "custom tmp rules", "utf-8");

    ensureWorkspaceAgentFiles(dir, {});

    expect(fs.readFileSync(path.join(dir, "tmp", "AGENTS.md"), "utf-8")).toBe("custom tmp rules");
  });

  it("backs up old generated AGENTS.md before writing the user template", () => {
    const dir = fs.mkdtempSync(path.join(rootDir, ".tmp-static-context-"));
    tempDirs.push(dir);
    fs.writeFileSync(
      path.join(dir, "AGENTS.md"),
      "Do NOT modify this file (CLAUDE.md / AGENTS.md). It is auto-generated on startup and any manual edits will be overwritten.",
      "utf-8",
    );

    ensureWorkspaceAgentFiles(dir, {});

    const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8");
    const backup = fs.readFileSync(path.join(dir, "AGENTS.niubot-generated.bak.md"), "utf-8");
    expect(agents).toContain("# Workspace Rules");
    expect(backup).toContain("auto-generated on startup");
  });
});
