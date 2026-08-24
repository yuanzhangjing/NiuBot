/** 飞书 GET /im/v1/messages 里的发送者 / mention 身份。 */

export type FetchedMention = {
  key?: string;
  id?: string;
  id_type?: string;
  name?: string;
};

export type FetchedSender = {
  id?: string;
  id_type?: string;
  sender_type?: string;
};

export type FetchedMessageIdentity = {
  sender?: FetchedSender;
  mentions?: FetchedMention[];
};

export type ClassifiedMessageIdentity = {
  senderIsApp: boolean;
  appMentionKeys: Set<string>;
  /** GET 返回里出现过的 mention key。空集合表示这次没带回 mention，不能据此记成人。 */
  fetchedMentionKeys: Set<string>;
};

/** app_id / sender_type=app / cli_ 前缀都视为应用机器人。 */
export function isAppIdentity(id?: string, idType?: string, senderType?: string): boolean {
  if (senderType === "app") return true;
  if (idType === "app_id") return true;
  if (typeof id === "string" && id.startsWith("cli_")) return true;
  return false;
}

export function classifyFetchedMessage(fetched: FetchedMessageIdentity): ClassifiedMessageIdentity {
  const appMentionKeys = new Set<string>();
  const fetchedMentionKeys = new Set<string>();
  for (const mention of fetched.mentions ?? []) {
    if (!mention.key) continue;
    fetchedMentionKeys.add(mention.key);
    if (isAppIdentity(mention.id, mention.id_type)) {
      appMentionKeys.add(mention.key);
    }
  }
  return {
    senderIsApp: isAppIdentity(fetched.sender?.id, fetched.sender?.id_type, fetched.sender?.sender_type),
    appMentionKeys,
    fetchedMentionKeys,
  };
}
