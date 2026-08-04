import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import { initDatabase } from "../database/schema.js";
import { addLoopJob } from "../core/loop.js";
import { parseArgs } from "./args.js";
import { handleSchedule } from "./schedule.js";

const dirs: string[] = [];
const dbs: Database.Database[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of dbs) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dbs.length = 0;
  dirs.length = 0;
});

function fixture(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-schedule-cli-test-"));
  dirs.push(dir);
  const db = initDatabase(path.join(dir, "niubot.db"));
  dbs.push(db);
  db.prepare("INSERT INTO users (id, name, platform, platform_id) VALUES ('u1', 'user', 'feishu', 'pu1')").run();
  db.prepare("INSERT INTO chats (id, type, platform, platform_id, user_id) VALUES ('c1', 'p2p', 'feishu', 'pc1', 'pu1')").run();
  return db;
}

describe("nbt schedule", () => {
  test("parses, lists, and cancels a chat-scoped Loop through Pipeline IPC", async () => {
    const db = fixture();
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));

    const execute = vi.fn(async () => ({ output: "Created loop:1\nMode: current conversation" }));
    await handleSchedule(db, [
      "create", "--mode", "loop", "--every", "5m", "--prompt", "check deployment",
      "--times", "3", "--duration", "2h",
    ], "c1", "p2p", "stale-session-user", parseArgs, execute);

    expect(execute).toHaveBeenCalledWith("c1", {
      type: "create.loop", intervalSeconds: 300, prompt: "check deployment",
      maxTimes: 3, durationSeconds: 7_200,
    });
    expect(output.join("\n")).toContain("Mode: current conversation");

    addLoopJob(db, { chatId: "c1", creatorUserId: "u1", intervalSeconds: 300, prompt: "check deployment" });
    output.length = 0;
    await handleSchedule(db, ["list"], "c1", "p2p", "u1", parseArgs, execute);
    expect(output.join("\n")).toContain("loop:1 [active]");

    execute.mockResolvedValueOnce({ output: "Cancelled loop:1" });
    await handleSchedule(db, ["cancel", "loop:1"], "c1", "p2p", "stale-session-user", parseArgs, execute);
    expect(execute).toHaveBeenLastCalledWith("c1", { type: "cancel", scheduleId: "loop:1" });
  });

  test("parses an independent Cron schedule through the same Pipeline IPC tool", async () => {
    const db = fixture();
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));

    const execute = vi.fn(async () => ({ output: "Created cron:1\nMode: independent session" }));
    await handleSchedule(db, [
      "create", "--mode", "cron", "--cron", "0 9 * * 1-5",
      "--prompt", "send standup reminder", "--times", "5",
    ], "c1", "p2p", "stale-session-user", parseArgs, execute);

    expect(execute).toHaveBeenCalledWith("c1", {
      type: "create.cron", cronExpr: "0 9 * * 1-5", runAt: undefined,
      prompt: "send standup reminder", description: undefined, maxTimes: 5,
      untilTime: undefined, timeZone: expect.any(String),
    });
    expect(output.join("\n")).toContain("Mode: independent session");
  });
});
