import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../database/schema.js";
import { buildImportantContext, buildNormalContext } from "./inject.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildNormalContext task injection", () => {
  it("uses task visibility rules for the current user", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-inject-"));
    tempDirs.push(workingDirectory);

    const tasksDir = path.join(workingDirectory, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "index.yaml"), yaml.stringify({
      tasks: [
        {
          name: "own-private",
          description: "owned task",
          path: "tasks/own-private",
          owner: "u2",
          visibility: "private",
          created_at: "2026-04-24",
        },
        {
          name: "other-private",
          description: "hidden task",
          path: "tasks/other-private",
          owner: "u3",
          visibility: "private",
          created_at: "2026-04-24",
        },
      ],
    }), "utf-8");

    const db = initDatabase(path.join(workingDirectory, "niubot.db"));
    const context = buildNormalContext(db, "c1", workingDirectory, undefined, "p2p", "u2");

    expect(context).toContain("own-private");
    expect(context).not.toContain("other-private");
  });
});
