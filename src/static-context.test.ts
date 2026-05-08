import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildStaticContext, ensureStaticContextFiles, loadStaticContextTemplate } from "./static-context.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadStaticContextTemplate", () => {
  it("loads the AGENTS template with task management rules", () => {
    const content = loadStaticContextTemplate();

    expect(content).toContain("## Task management");
    expect(content).toContain("Do NOT manually create directories under `tasks/`.");
    expect(content).toContain("Only use `nbt send` / `nbt send --file`");
    expect(content).toContain("Each task has a `README.md` with sections:");
    expect(content).toContain("## In Progress` / `## Todo` / `## Bug` / `## Idea` / `## Done`.");
    expect(content).toContain("Edit the task README directly for item-level progress.");
    expect(content).toContain("Outside it, read freely but write/delete only when the user explicitly asks or confirms.");
    expect(content).toContain("nbt whoami");
    expect(content).toContain("For full syntax: `nbt <command> --help`.");
  });

  it("AGENTS.template.md is included in package.json files", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));
    expect(pkg.files).toContain("AGENTS.template.md");
  });

  it("AGENTS.template.md exists at project root", () => {
    const exists = fs.existsSync(path.join(rootDir, "AGENTS.template.md"));
    expect(exists).toBe(true);
  });

  it("composes persona, bot instructions, and project context into AGENTS.md", () => {
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

    expect(content).toContain("## Bot Persona");
    expect(content).toContain("plain persona text");
    expect(content).toContain("## Bot Instructions");
    expect(content).toContain("bot rule text");
    expect(content).toContain("## Project Context");
    expect(content).toContain("project background text");
    expect(content).toContain(personaPath);
    expect(content).toContain(instructionsPath);
    expect(content).toContain(projectContextPath);
  });

  it("does not duplicate source file top-level headings", () => {
    const dir = fs.mkdtempSync(path.join(rootDir, ".tmp-static-context-"));
    tempDirs.push(dir);

    const instructionsPath = path.join(dir, "instructions.md");
    fs.writeFileSync(instructionsPath, "# Bot Instructions\n\nbot rule text", "utf-8");

    const content = buildStaticContext({ instructionsPath });

    expect(content).toContain("## Bot Instructions");
    expect(content).toContain("bot rule text");
    expect(content).not.toContain("# Bot Instructions\n\nbot rule text");
  });

  it("does not compose untouched default instructions or project templates", () => {
    const dir = fs.mkdtempSync(path.join(rootDir, ".tmp-static-context-"));
    tempDirs.push(dir);

    const instructionsPath = path.join(dir, "instructions.md");
    const projectContextPath = path.join(dir, "project.md");
    ensureStaticContextFiles({ instructionsPath, projectContextPath });

    const content = buildStaticContext({ instructionsPath, projectContextPath });

    expect(content).not.toContain("## Bot Instructions");
    expect(content).not.toContain("## Project Context");
    expect(content).not.toContain("在这里写这个 bot 的长期职责");
    expect(content).not.toContain("在这里写这个工作区的背景");
  });

  it("lists stable context source files even when default templates are untouched", () => {
    const dir = fs.mkdtempSync(path.join(rootDir, ".tmp-static-context-"));
    tempDirs.push(dir);

    const personaPath = path.join(dir, "persona.md");
    const instructionsPath = path.join(dir, "instructions.md");
    const projectContextPath = path.join(dir, "project.md");
    ensureStaticContextFiles({ instructionsPath, projectContextPath });

    const content = buildStaticContext({
      personaPath,
      instructionsPath,
      projectContextPath,
    });

    expect(content).toContain("## Stable Context Sources");
    expect(content).toContain(personaPath);
    expect(content).toContain(instructionsPath);
    expect(content).toContain(projectContextPath);
    expect(content).toContain("Do not edit AGENTS.md directly");
    expect(content).toContain("/new");
  });
});
