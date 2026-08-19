import { loadConfig, type BotConfig } from "../config.js";

export type FeishuCreds = {
  botId: string;
  appId: string;
  appSecret: string;
  platformBotId?: string;
};

export function resolveCurrentBot(
  bots: BotConfig[],
  opts: { botName?: string; botProfilePath?: string; dbPath?: string },
): BotConfig {
  if (bots.length === 0) {
    throw new Error("Config error: no bots configured");
  }

  const byName = opts.botName?.trim();
  if (byName) {
    const match = bots.find((bot) => bot.id === byName);
    if (match) return match;
    throw new Error(`Config error: bot '${byName}' not found`);
  }

  if (opts.botProfilePath) {
    const match = bots.find((bot) => bot.botProfilePath === opts.botProfilePath);
    if (match) return match;
  }

  if (opts.dbPath) {
    const match = bots.find((bot) => bot.dbPath === opts.dbPath);
    if (match) return match;
  }

  if (bots.length === 1) return bots[0]!;
  throw new Error(`Config error: cannot determine current bot (${bots.map((bot) => bot.id).join(", ")})`);
}

export function formatFeishuCreds(creds: FeishuCreds): string {
  const lines = [
    `bot: ${creds.botId}`,
    `appId: ${creds.appId}`,
    `appSecret: ${creds.appSecret}`,
  ];
  if (creds.platformBotId) {
    lines.push(`platformBotId: ${creds.platformBotId}`);
  }
  return lines.join("\n");
}

export function handleFeishu(
  args: string[],
  env: {
    botName?: string;
    botProfilePath?: string;
    dbPath?: string;
    platformBotId?: string;
  },
  io: { log: (text: string) => void; error: (text: string) => void; exit: (code: number) => void } = {
    log: console.log,
    error: console.error,
    exit: process.exit,
  },
  load: typeof loadConfig = loadConfig,
): void {
  if (args[0] === "--help" || args[0] === "help") {
    io.log(`Show the current Bot's Feishu app identity (appId / appSecret).

Usage:
  nbt feishu

Use when the agent needs this Bot's Feishu app credentials.
Do not put appSecret in user-visible replies.`);
    return;
  }

  if (args.length > 0) {
    io.error(`Error: unknown argument: ${args[0]}`);
    io.exit(1);
    return;
  }

  try {
    const config = load();
    const bot = resolveCurrentBot(config.bots, {
      botName: env.botName,
      botProfilePath: env.botProfilePath,
      dbPath: env.dbPath,
    });
    io.log(formatFeishuCreds({
      botId: bot.id,
      appId: bot.appId,
      appSecret: bot.appSecret,
      platformBotId: env.platformBotId,
    }));
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    io.exit(1);
  }
}
