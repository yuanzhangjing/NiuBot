import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeTestDatabases, openTestDatabase } from "../../test-utils/database.js";
import { addCronJob, deleteCronJobForAccess, describeCronSchedule, listCronJobsForAccess } from "../core/cron.js";
import { parseArgs } from "./args.js";
import { formatCronScheduleForDisplay, handleCron } from "./cron.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  closeTestDatabases();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function setupDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-cron-store-"));
  tempDirs.push(dir);
  const db = openTestDatabase(path.join(dir, "niubot.db"));
  db.prepare("INSERT INTO chats (id, type, platform, platform_id) VALUES ('c1', 'group', 'feishu', 'pc1')").run();
  db.prepare("INSERT INTO chats (id, type, platform, platform_id) VALUES ('c2', 'p2p', 'feishu', 'pc2')").run();
  const ownJob = addCronJob(db, {
    chatId: "c1",
    creatorUserId: "u2",
    cronExpr: "* * * * *",
    prompt: "own",
  });
  const otherChatJob = addCronJob(db, {
    chatId: "c2",
    creatorUserId: "u2",
    cronExpr: "* * * * *",
    prompt: "other chat",
  });
  const otherUserJob = addCronJob(db, {
    chatId: "c1",
    creatorUserId: "u3",
    cronExpr: "* * * * *",
    prompt: "other user",
  });
  return { db, ownJob, otherChatJob, otherUserJob };
}

describe("cron access rules", () => {
  it("routes legacy add and del writes through the unified Pipeline IPC", async () => {
    const { db } = setupDb();
    const execute = vi.fn(async () => ({ output: "ok" }));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await handleCron(db, [
      "add", "--cron", "0 9 * * *", "--prompt", "standup", "--times", "2",
    ], "c1", "group", "stale-session-user", parseArgs, execute);
    expect(execute).toHaveBeenCalledWith("c1", {
      type: "create.schedule",
      mode: "isolated",
      trigger: "cron",
      cronExpr: "0 9 * * *",
      prompt: "standup",
      description: undefined,
      maxTimes: 2,
      untilTime: undefined,
      timeZone: expect.any(String),
    });

    await handleCron(db, ["del", "3"], "c1", "group", "stale-session-user", parseArgs, execute);
    expect(execute).toHaveBeenLastCalledWith("c1", { type: "cancel", scheduleId: "cron:3" });
  });

  it("labels cron schedules in the display timezone", () => {
    expect(formatCronScheduleForDisplay({ cronExpr: "0 10 * * *", runAt: null, timezone: "UTC" })).toBe(
      describeCronSchedule("0 10 * * *", null, "UTC"),
    );
    expect(formatCronScheduleForDisplay({
      cronExpr: null,
      runAt: "2026-04-25 10:00:00",
    })).toMatch(/^at 2026-04-25 \d{2}:00 \(/);
  });

  it("blocks group list for another chat", () => {
    const { db } = setupDb();

    expect(() => listCronJobsForAccess(db, {
      currentChatId: "c1",
      targetChatId: "c2",
      chatType: "group",
    })).toThrow("cross-chat query is not allowed in group chat");
  });

  it("blocks deleting another user's job", () => {
    const { db, otherUserJob } = setupDb();

    expect(() => deleteCronJobForAccess(db, otherUserJob, {
      currentChatId: "c1",
      chatType: "group",
      userId: "u2",
    })).toThrow("can only delete your own cron jobs");
  });

  it("blocks deleting when current user is missing", () => {
    const { db, ownJob } = setupDb();

    expect(() => deleteCronJobForAccess(db, ownJob, {
      currentChatId: "c1",
      chatType: "group",
    })).toThrow("NIUBOT_USER_ID not set");
  });
});
