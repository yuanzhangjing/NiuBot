import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleTask } from "./task.js";

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("handleTask create", () => {
  it("creates README.md with the standard task sections", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-task-"));
    tempDirs.push(workingDirectory);

    handleTask(["create", "demo-task"], workingDirectory, "C1", "p2p", "U2", parseArgs);

    const readmePath = path.join(workingDirectory, "tasks", "demo-task", "README.md");
    const readme = fs.readFileSync(readmePath, "utf-8");

    expect(readme).toContain("## In Progress");
    expect(readme).toContain("## Todo");
    expect(readme).toContain("## Bug");
    expect(readme).toContain("## Idea");
    expect(readme).toContain("## Done");
  });
});
