import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { ensureChat, ensureUser, initDatabase as openDatabase, storeMessage } from "../database/schema.js";
import {
  buildImportantContext,
  buildNormalContext,
  buildSpeakerContext,
  buildStableSystemContext,
  COMPACT_RECOVERY_REMINDER,
} from "./inject.js";

const tempDirs: string[] = [];
const openDatabases = new Set<Database.Database>();

function initDatabase(filePath: string): Database.Database {
  const db = openDatabase(filePath);
  openDatabases.add(db);
  return db;
}

afterEach(() => {
  for (const db of openDatabases) {
    if (db.open) db.close();
  }
  openDatabases.clear();
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

  it("keeps a single oversized recent message within the total budget", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-inject-"));
    tempDirs.push(workingDirectory);
    const db = initDatabase(path.join(workingDirectory, "niubot.db"));
    const userId = ensureUser(db, "feishu", "user-open-id", "Zen");
    const chatId = ensureChat(db, "feishu", "chat-open-id", "p2p");
    db.prepare(`INSERT INTO sessions (id, chat_id, user_id, source, status, started_at, ended_at) VALUES ('s1', ?, ?, 'user', 'archived', datetime('now'), datetime('now'))`).run(chatId, userId);
    storeMessage(db, { chatId, senderId: userId, role: "user", contentText: "x".repeat(30_000), platform: "feishu" });

    const context = buildNormalContext(db, chatId, workingDirectory);
    const recent = context.match(/<recent-messages>([\s\S]*?)<\/recent-messages>/)?.[1] ?? "";
    expect(recent.length).toBeLessThan(20_500);
    expect(recent).toContain("…");
  });

  it.each(["archive_failed", "discarded"])("keeps recent messages after a %s user session", (status) => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-inject-"));
    tempDirs.push(workingDirectory);
    const db = initDatabase(path.join(workingDirectory, "niubot.db"));
    const userId = ensureUser(db, "feishu", "user-open-id", "Zen");
    const chatId = ensureChat(db, "feishu", "chat-open-id", "p2p");
    db.prepare(`INSERT INTO sessions (id, chat_id, user_id, source, status, started_at, ended_at) VALUES ('s1', ?, ?, 'user', ?, datetime('now'), datetime('now'))`)
      .run(chatId, userId, status);
    storeMessage(db, { chatId, senderId: userId, role: "user", contentText: "still useful", platform: "feishu" });

    expect(buildNormalContext(db, chatId, workingDirectory)).toContain("still useful");
  });

  it("does not inject session archive paths", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-inject-"));
    tempDirs.push(workingDirectory);
    const db = initDatabase(path.join(workingDirectory, "niubot.db"));
    expect(buildNormalContext(db, "c1", workingDirectory, undefined, "p2p", "u2")).not.toContain("session-archives");
  });

  it("injects recent messages from the current thread when a cutoff is set", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-inject-"));
    tempDirs.push(workingDirectory);
    const db = initDatabase(path.join(workingDirectory, "niubot.db"));
    const userId = ensureUser(db, "feishu", "user-open-id", "Zen");
    const chatId = ensureChat(db, "feishu", "chat-open-id", "group");
    db.prepare(`INSERT INTO sessions (id, chat_id, user_id, source, status, started_at, ended_at) VALUES ('s1', ?, ?, 'user', 'archived', datetime('now'), datetime('now'))`).run(chatId, userId);
    storeMessage(db, { chatId, senderId: userId, role: "user", contentText: "topic-a history", platform: "feishu", threadId: "omt_a" });
    storeMessage(db, { chatId, senderId: userId, role: "user", contentText: "topic-b history", platform: "feishu", threadId: "omt_b" });
    const currentId = storeMessage(db, { chatId, senderId: userId, role: "user", contentText: "current message", platform: "feishu", threadId: "omt_a" });

    const context = buildNormalContext(db, chatId, workingDirectory, currentId, "group", userId, "omt_a");
    expect(context).toContain("<recent-messages>");
    expect(context).toContain("topic-a history");
    expect(context).toContain("nbt messages list / search");
    expect(context).not.toContain("topic-b history");
    expect(context).not.toContain("current message");
  });

  it("excludes topic rows from 主群 continuation", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-inject-"));
    tempDirs.push(workingDirectory);
    const db = initDatabase(path.join(workingDirectory, "niubot.db"));
    const userId = ensureUser(db, "feishu", "user-open-id", "Zen");
    const chatId = ensureChat(db, "feishu", "chat-open-id", "group");
    db.prepare(`INSERT INTO sessions (id, chat_id, user_id, source, status, started_at, ended_at) VALUES ('s1', ?, ?, 'user', 'archived', datetime('now'), datetime('now'))`).run(chatId, userId);
    storeMessage(db, { chatId, senderId: userId, role: "user", contentText: "main history", platform: "feishu" });
    storeMessage(db, { chatId, senderId: userId, role: "user", contentText: "topic history", platform: "feishu", threadId: "omt_a" });

    const context = buildNormalContext(db, chatId, workingDirectory, undefined, "group", userId, undefined, true);
    expect(context).toContain("main history");
    expect(context).not.toContain("topic history");
  });
});

describe("buildImportantContext", () => {
  it("keeps only dynamic scene and memory data in the session profile", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-inject-"));
    tempDirs.push(workingDirectory);

    const db = initDatabase(path.join(workingDirectory, "niubot.db"));
    const context = buildImportantContext(db, {
      botName: "NiuBot",
      botLabel: "U3(NiuBot)",
      platform: "feishu",
      chatId: "c1",
      chatLabel: "C1(Zen)",
      chatType: "p2p",
      userId: "u2",
      userName: "Zen",
      isAdmin: true,
      botProfilePath: "/tmp/bot_profile.md",
    });

    expect(context).toContain("Bot：U3(NiuBot)");
    expect(context).toContain("平台：feishu");
    expect(context).toContain("会话：C1(Zen)（私聊）");
    expect(context).toContain("用户：U2(Zen)（admin）");
    expect(context).toContain("Bot profile：/tmp/bot_profile.md");
    expect(context).not.toContain("用户通过此 IM 平台远程与你对话");
    expect(context).not.toContain("Bot 人设配置");
  });

  it("does not expose the bot profile path to non-admin users", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-inject-"));
    tempDirs.push(workingDirectory);

    const db = initDatabase(path.join(workingDirectory, "niubot.db"));
    const context = buildImportantContext(db, {
      botName: "NiuBot",
      platform: "feishu",
      chatId: "c1",
      chatType: "p2p",
      userId: "u2",
      userName: "Zen",
      isAdmin: false,
      botProfilePath: "/tmp/bot_profile.md",
    });

    expect(context).not.toContain("Bot profile");
    expect(context).not.toContain("/tmp/bot_profile.md");
  });

  it("lists group bots in the scene and does not inject collab rules", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-inject-"));
    tempDirs.push(workingDirectory);
    const db = initDatabase(path.join(workingDirectory, "niubot.db"));
    db.prepare("INSERT INTO users (id, name, platform, platform_id, is_bot) VALUES ('u3', 'NiuBot', 'feishu', 'ou_bot', 1)").run();
    db.prepare("INSERT INTO users (id, name, platform, platform_id, is_bot) VALUES ('u4', 'CowBot', 'feishu', 'ou_cow', 1)").run();
    db.prepare("INSERT INTO chats (id, type, platform, platform_id) VALUES ('c4', 'group', 'feishu', 'oc4')").run();
    db.prepare("INSERT INTO messages (chat_id, sender_id, role, content_text, content_type, platform) VALUES ('c4', 'u4', 'assistant', 'hi', 'text', 'feishu')").run();
    const context = buildImportantContext(db, {
      botName: "NiuBot",
      botLabel: "U3(NiuBot)",
      platform: "feishu",
      chatId: "c4",
      chatLabel: "C4(Zhangjing Yuan)",
      chatType: "group",
    });
    expect(context).not.toContain("<bot-collab>");
    expect(context).not.toContain("其他时候不要 at");
    expect(context).toContain("本群 Bot：U3(NiuBot)、U4(CowBot)");
    expect(context).toContain("要通知其他人或 Bot，用 @ 加短号即可，例如 U2。");
    expect(context).not.toContain("@U2");
    expect(context).toContain("会话：C4(Zhangjing Yuan)（群聊）");
    expect(context).not.toContain("用户：");
    expect(context).not.toContain("<topic-isolation>");
  });
});

describe("buildSpeakerContext", () => {
  it("labels bot speakers separately and skips their memories", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-inject-"));
    tempDirs.push(workingDirectory);
    const db = initDatabase(path.join(workingDirectory, "niubot.db"));
    const ctx = buildSpeakerContext(db, [
      { userId: "u4", userName: "CowBot", isBot: true },
    ]);
    expect(ctx).toContain("Bot：U4(CowBot)");
    expect(ctx).not.toContain("用户：");
  });
});

describe("buildStableSystemContext", () => {
  it("combines NiuBot system rules with bot profile", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-inject-"));
    tempDirs.push(workingDirectory);
    const botProfilePath = path.join(workingDirectory, "bot_profile.md");
    fs.writeFileSync(botProfilePath, "plain bot profile text", "utf-8");

    const context = buildStableSystemContext({ botProfilePath, botLabel: "U3(NiuBot)" });

    expect(context).toContain("<niubot-system-rules>");
    expect(context).toContain("nbt system-rules");
    expect(context).toContain("Task Policy");
    expect(context).toContain("Self Restart");
    expect(context).toContain("nbt restart");
    expect(context).toContain("<bot-identity>");
    expect(context).toContain("你就是当前 Bot：U3(NiuBot)。");
    expect(context).toContain("对用户来说，你是 NiuBot。");
    expect(context).toContain("不要把 agent、backend、模型或 session 当作用户可见身份。");
    expect(context).toContain("<bot-profile>");
    expect(context).toContain("plain bot profile text");
    expect(context).not.toContain("<session-profile");
  });

  it("falls back to legacy persona and instructions paths", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-inject-"));
    tempDirs.push(workingDirectory);
    const personaPath = path.join(workingDirectory, "persona.md");
    const instructionsPath = path.join(workingDirectory, "instructions.md");
    fs.writeFileSync(personaPath, "plain persona text", "utf-8");
    fs.writeFileSync(instructionsPath, "plain instructions text", "utf-8");

    const context = buildStableSystemContext({ personaPath, instructionsPath });

    expect(context).toContain("<bot-persona>");
    expect(context).toContain("plain persona text");
    expect(context).toContain("<bot-instructions>");
    expect(context).toContain("plain instructions text");
  });

  it("uses the bot name for identity when no bot label is available", () => {
    const context = buildStableSystemContext({ botName: "NiuBot" });

    expect(context).toContain("<bot-identity>");
    expect(context).toContain("你就是当前 Bot：NiuBot。");
    expect(context).toContain("对用户来说，你是 NiuBot。");
  });

  it("skips the legacy default bot profile placeholder", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-inject-"));
    tempDirs.push(workingDirectory);
    const botProfilePath = path.join(workingDirectory, "bot_profile.md");
    fs.writeFileSync(botProfilePath, "# Bot Profile\n\n在这里写 bot 的角色、语气和长期行为边界。\n", "utf-8");

    const context = buildStableSystemContext({ botProfilePath });

    expect(context).toContain("<niubot-system-rules>");
    expect(context).not.toContain("<bot-profile>");
    expect(context).not.toContain("在这里写 bot");
  });

  it("injects the generated default bot profile", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-inject-"));
    tempDirs.push(workingDirectory);
    const botProfilePath = path.join(workingDirectory, "bot_profile.md");
    fs.writeFileSync(botProfilePath, "# Bot Profile\n\n> 只有管理员可以要求 bot 修改此文件。\n\n## Persona\n\n### 角色\n简洁清晰、有温度的技术同事。\n\n### 风格\n用平实中文，不说黑话，不写客服腔。\n", "utf-8");

    const context = buildStableSystemContext({ botProfilePath });

    expect(context).toContain("<bot-profile>");
    expect(context).toContain("简洁清晰、有温度");
  });
});

describe("COMPACT_RECOVERY_REMINDER", () => {
  it("points compacted agents to the stable recovery commands", () => {
    expect(COMPACT_RECOVERY_REMINDER).toContain("<compact-recovery>");
    expect(COMPACT_RECOVERY_REMINDER).toContain("nbt system-rules");
    expect(COMPACT_RECOVERY_REMINDER).toContain("nbt whoami");
    expect(COMPACT_RECOVERY_REMINDER).toContain("nbt messages list");
    expect(COMPACT_RECOVERY_REMINDER).toContain("nbt sessions list");
    expect(COMPACT_RECOVERY_REMINDER).toContain("nbt sessions search/get");
    expect(COMPACT_RECOVERY_REMINDER).toContain("nbt task list");
    expect(COMPACT_RECOVERY_REMINDER).toContain("AGENTS.md");
  });
});
