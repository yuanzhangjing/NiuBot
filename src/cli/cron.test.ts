import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../database/schema.js";
import { addCronJob, deleteCronJobForAccess, listCronJobsForAccess } from "../core/cron.js";
import { formatCronScheduleForDisplay } from "./cron.js";

const tempDirs: string[] = [];
const openDatabases: Database.Database[] = [];

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    if (db.open) db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function setupDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-cron-store-"));
  tempDirs.push(dir);
  const db = initDatabase(path.join(dir, "niubot.db"));
  openDatabases.push(db);
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
  it("labels cron schedules as local time", () => {
    expect(formatCronScheduleForDisplay({ cronExpr: "0 10 * * *", runAt: null })).toContain("0 10 * * * (local time, ");
    expect(formatCronScheduleForDisplay({
      cronExpr: null,
      runAt: "2026-04-25 10:00:00",
      timezone: "UTC",
    })).toBe("at 2026-04-25 10:00 (UTC)");
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
