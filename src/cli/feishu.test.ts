import { describe, expect, it } from "vitest";
import { formatFeishuCreds, handleFeishu, resolveCurrentBot, type FeishuCreds } from "./feishu.js";
import type { BotConfig, NiuBotConfig } from "../config.js";

function bot(partial: Partial<BotConfig> & Pick<BotConfig, "id" | "appId" | "appSecret">): BotConfig {
  return {
    workingDirectory: `/tmp/${partial.id}`,
    dbPath: `/tmp/${partial.id}.db`,
    botProfilePath: `/tmp/${partial.id}/bot_profile.md`,
    ...partial,
  };
}

describe("resolveCurrentBot", () => {
  const bots = [
    bot({ id: "NiuBot", appId: "cli_niu", appSecret: "sec_niu" }),
    bot({ id: "CowBot", appId: "cli_cow", appSecret: "sec_cow" }),
  ];

  it("matches NIUBOT_BOT_NAME", () => {
    expect(resolveCurrentBot(bots, { botName: "CowBot" }).id).toBe("CowBot");
  });

  it("matches bot profile path", () => {
    expect(resolveCurrentBot(bots, { botProfilePath: "/tmp/NiuBot/bot_profile.md" }).id).toBe("NiuBot");
  });

  it("matches database path", () => {
    expect(resolveCurrentBot(bots, { dbPath: "/tmp/CowBot.db" }).id).toBe("CowBot");
  });

  it("uses the only bot when identity is missing", () => {
    expect(resolveCurrentBot([bots[0]!], {}).id).toBe("NiuBot");
  });

  it("errors when multiple bots and no identity", () => {
    expect(() => resolveCurrentBot(bots, {})).toThrow(/cannot determine current bot/);
  });
});

describe("formatFeishuCreds", () => {
  const creds: FeishuCreds = {
    botId: "NiuBot",
    appId: "cli_a1",
    appSecret: "s'ecret",
    platformBotId: "ou_bot",
  };

  it("prints text fields", () => {
    expect(formatFeishuCreds(creds)).toBe([
      "bot: NiuBot",
      "appId: cli_a1",
      "appSecret: s'ecret",
      "platformBotId: ou_bot",
    ].join("\n"));
  });
});

describe("nbt feishu-creds", () => {
  const config = {
    bots: [bot({ id: "NiuBot", appId: "cli_test_id", appSecret: "cli_test_secret" })],
  } as NiuBotConfig;

  it("prints the current bot appId and appSecret", () => {
    const lines: string[] = [];
    handleFeishu([], {
      botName: "NiuBot",
      platformBotId: "ou_test",
    }, {
      log: (text) => lines.push(text),
      error: () => {},
      exit: () => {},
    }, () => config);

    expect(lines.join("\n")).toBe([
      "bot: NiuBot",
      "appId: cli_test_id",
      "appSecret: cli_test_secret",
      "platformBotId: ou_test",
    ].join("\n"));
  });
});
