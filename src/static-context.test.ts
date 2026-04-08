import { describe, expect, it } from "vitest";
import { loadStaticContextTemplate } from "./static-context.js";

describe("loadStaticContextTemplate", () => {
  it("loads the AGENTS template with task management rules", () => {
    const content = loadStaticContextTemplate();

    expect(content).toContain("## Task management");
    expect(content).toContain("do NOT manually create directories under `tasks/`.");
    expect(content).toContain("Each task is a directory `tasks/<name>/` with `README.md` as the single entrypoint.");
    expect(content).toContain("## In Progress` / `## Todo` / `## Bug` / `## Idea` / `## Done`.");
  });
});
