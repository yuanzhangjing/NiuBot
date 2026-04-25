import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTask, listTasks, updateTask } from "./store.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeIndex(workingDirectory: string): void {
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
        description: "not visible",
        path: "tasks/other-private",
        owner: "u3",
        visibility: "private",
        created_at: "2026-04-24",
      },
      {
        name: "public-task",
        description: "visible to everyone",
        path: "tasks/public-task",
        owner: "u3",
        visibility: "public",
        created_at: "2026-04-24",
      },
      {
        name: "inactive-task",
        description: "hidden by default",
        path: "tasks/inactive-task",
        owner: "u2",
        visibility: "private",
        status: "inactive",
        created_at: "2026-04-24",
      },
    ],
  }), "utf-8");
}

describe("listTasks", () => {
  it("returns active visible tasks for the current private chat user", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-task-store-"));
    tempDirs.push(workingDirectory);
    writeIndex(workingDirectory);

    const tasks = listTasks({
      workingDirectory,
      userId: "u2",
      chatType: "p2p",
    });

    expect(tasks.map((t) => t.name)).toEqual(["own-private", "public-task"]);
  });

  it("returns only public active tasks in group chats", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-task-store-"));
    tempDirs.push(workingDirectory);
    writeIndex(workingDirectory);

    const tasks = listTasks({
      workingDirectory,
      userId: "u2",
      chatType: "group",
    });

    expect(tasks.map((t) => t.name)).toEqual(["public-task"]);
  });

  it("rejects task creation without an owner", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-task-store-"));
    tempDirs.push(workingDirectory);

    expect(() => createTask({
      workingDirectory,
      name: "public-task",
      description: "",
      visibility: "public",
    })).toThrow("NIUBOT_USER_ID not set");
  });

  it("uses the local calendar date for new task metadata", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 25, 0, 30, 0));
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-task-store-"));
    tempDirs.push(workingDirectory);

    const task = createTask({
      workingDirectory,
      name: "local-date-task",
      description: "",
      visibility: "private",
      owner: "u2",
    });

    expect(task.created_at).toBe("2026-04-25");
  });

  it("rejects task update without a user", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-task-store-"));
    tempDirs.push(workingDirectory);
    writeIndex(workingDirectory);

    expect(() => updateTask({
      workingDirectory,
      name: "own-private",
      newName: "renamed",
    })).toThrow("NIUBOT_USER_ID not set");
  });

  it("rejects rename to another active task name", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-task-store-"));
    tempDirs.push(workingDirectory);
    writeIndex(workingDirectory);

    expect(() => updateTask({
      workingDirectory,
      name: "own-private",
      userId: "u2",
      newName: "public-task",
    })).toThrow('task "public-task" already exists');
  });

  it("allows rename to the same task name as a no-op", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-task-store-"));
    tempDirs.push(workingDirectory);
    writeIndex(workingDirectory);

    const task = updateTask({
      workingDirectory,
      name: "own-private",
      userId: "u2",
      newName: "own-private",
    });

    expect(task.name).toBe("own-private");
  });
});
