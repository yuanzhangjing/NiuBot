import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStaticContextTemplate } from "./static-context.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("loadStaticContextTemplate", () => {
  it("loads the AGENTS template with task management rules", () => {
    const content = loadStaticContextTemplate();

    expect(content).toContain("## Task management");
    expect(content).toContain("do NOT manually create directories under `tasks/`.");
    expect(content).toContain("Each task has a `README.md` with sections:");
    expect(content).toContain("## In Progress` / `## Todo` / `## Bug` / `## Idea` / `## Done`.");
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
});
