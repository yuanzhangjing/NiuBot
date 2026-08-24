/**
 * 群聊 nbt messages 用：用当前 Bot 的飞书身份把群记录 sync 进本库。
 */

import type Database from "better-sqlite3";
import { loadConfig } from "../config.js";
import { getGroupChatSyncTarget, lookupSelfUserId, syncGroupChatToDb } from "../core/group-history.js";
import { FeishuAdapter } from "../im/feishu/adapter.js";
import { resolveCurrentBot } from "./feishu.js";

export type GroupSyncEnv = {
  botName?: string;
  botProfilePath?: string;
  dbPath?: string;
  platformBotId?: string;
};

export async function syncGroupChatFromConfig(
  db: Database.Database,
  chatId: string,
  env: GroupSyncEnv,
): Promise<void> {
  const target = getGroupChatSyncTarget(db, chatId);
  if (!target || target.platform !== "feishu") return;

  const config = loadConfig();
  const bot = resolveCurrentBot(config.bots, env);
  const adapter = new FeishuAdapter(bot.appId, bot.appSecret);
  const openId = await adapter.getBotOpenId();
  const selfUserId = lookupSelfUserId(db, target.platform, [openId, env.platformBotId]);
  await syncGroupChatToDb(db, chatId, {
    transport: { listChatMessages: (id, options) => adapter.listChatMessages(id, options) },
    selfUserId,
  });
}
