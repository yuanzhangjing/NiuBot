import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../database/schema.js";
import {
  buildImportantContext,
  buildNormalContext,
  buildStableSystemContext,
  COMPACT_RECOVERY_REMINDER,
} from "./inject.js";

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
    });

    expect(context).toContain("Bot：U3(NiuBot)");
    expect(context).toContain("平台：feishu");
    expect(context).toContain("会话：C1(Zen)（私聊）");
    expect(context).toContain("用户：U2(Zen)（admin）");
    expect(context).not.toContain("用户通过此 IM 平台远程与你对话");
    expect(context).not.toContain("Bot 人设配置");
  });
});

describe("buildStableSystemContext", () => {
  it("combines NiuBot system rules with bot persona and instructions", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-inject-"));
    tempDirs.push(workingDirectory);
    const personaPath = path.join(workingDirectory, "persona.md");
    const instructionsPath = path.join(workingDirectory, "instructions.md");
    fs.writeFileSync(personaPath, "plain persona text", "utf-8");
    fs.writeFileSync(instructionsPath, "plain instructions text", "utf-8");

    const context = buildStableSystemContext({ personaPath, instructionsPath });

    expect(context).toContain("<niubot-system-rules>");
    expect(context).toContain("nbt system-rules");
    expect(context).toContain("Task Policy");
    expect(context).toContain("不要启动、停止或重启 NiuBot Engine 服务");
    expect(context).toContain("<bot-persona>");
    expect(context).toContain("plain persona text");
    expect(context).toContain("<bot-instructions>");
    expect(context).toContain("plain instructions text");
    expect(context).not.toContain("<session-profile");
  });

  it("skips the default instructions placeholder", () => {
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-inject-"));
    tempDirs.push(workingDirectory);
    const instructionsPath = path.join(workingDirectory, "instructions.md");
    fs.writeFileSync(instructionsPath, "# Bot Instructions\n\n在这里写这个 bot 的长期职责、做事规则和边界。\n", "utf-8");

    const context = buildStableSystemContext({ instructionsPath });

    expect(context).toContain("<niubot-system-rules>");
    expect(context).not.toContain("<bot-instructions>");
    expect(context).not.toContain("在这里写这个 bot");
  });
});

describe("COMPACT_RECOVERY_REMINDER", () => {
  it("points compacted agents to the stable recovery commands", () => {
    expect(COMPACT_RECOVERY_REMINDER).toContain("<compact-recovery>");
    expect(COMPACT_RECOVERY_REMINDER).toContain("nbt system-rules");
    expect(COMPACT_RECOVERY_REMINDER).toContain("nbt whoami");
    expect(COMPACT_RECOVERY_REMINDER).toContain("nbt messages list");
    expect(COMPACT_RECOVERY_REMINDER).toContain("nbt sessions");
    expect(COMPACT_RECOVERY_REMINDER).toContain("nbt task list");
    expect(COMPACT_RECOVERY_REMINDER).toContain("AGENTS.md");
  });
});
