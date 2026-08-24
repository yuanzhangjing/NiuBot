import { describe, expect, test } from "vitest";
import { classifyFetchedMessage, isAppIdentity } from "./message-identity.js";

describe("isAppIdentity", () => {
  test("treats sender_type app and app_id as bots", () => {
    expect(isAppIdentity(undefined, undefined, "app")).toBe(true);
    expect(isAppIdentity("cli_abc", "app_id")).toBe(true);
    expect(isAppIdentity("cli_abc")).toBe(true);
    expect(isAppIdentity("ou_human", "open_id", "user")).toBe(false);
  });
});

describe("classifyFetchedMessage", () => {
  test("marks sender and mention keys that are apps", () => {
    const classified = classifyFetchedMessage({
      sender: { id: "ou_zen", id_type: "open_id", sender_type: "user" },
      mentions: [
        { key: "@_user_1", id: "cli_niubot", id_type: "app_id", name: "NiuBot" },
        { key: "@_user_2", id: "cli_cow", id_type: "app_id", name: "CowBot" },
        { key: "@_user_3", id: "ou_human", id_type: "open_id", name: "Zen" },
      ],
    });
    expect(classified.senderIsApp).toBe(false);
    expect([...classified.appMentionKeys].sort()).toEqual(["@_user_1", "@_user_2"]);
    expect([...classified.fetchedMentionKeys].sort()).toEqual(["@_user_1", "@_user_2", "@_user_3"]);
  });

  test("marks app senders even without mentions", () => {
    const classified = classifyFetchedMessage({
      sender: { id: "cli_niubot", id_type: "app_id", sender_type: "app" },
    });
    expect(classified.senderIsApp).toBe(true);
    expect(classified.appMentionKeys.size).toBe(0);
    expect(classified.fetchedMentionKeys.size).toBe(0);
  });
});
