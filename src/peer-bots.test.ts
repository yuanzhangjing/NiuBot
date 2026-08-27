import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ensureUser, getUserIdentityByPlatformId } from "./database/schema.js";
import { closeTestDatabases, openTestDatabase } from "../test-utils/database.js";
import { PeerBotDirectory, seedPeerBots } from "./peer-bots.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeTestDatabases();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
  }
});

describe("PeerBotDirectory", () => {
  test("notifies subscribers when a peer registers", () => {
    const directory = new PeerBotDirectory();
    const seen: string[][] = [];
    directory.subscribe((peers) => seen.push(peers.map((peer) => peer.botId)));
    directory.register({ botId: "NiuBot", openId: "ou-niu", name: "NiuBot" });
    directory.register({ botId: "CowBot", openId: "ou-cow", name: "CowBot" });
    expect(seen).toEqual([["NiuBot"], ["NiuBot", "CowBot"]]);
  });
});

describe("seedPeerBots", () => {
  test("writes other bots into the local users table as is_bot", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "niubot-peer-bots-"));
    tempDirs.push(dir);
    const db = openTestDatabase(path.join(dir, "niubot.db"));
    seedPeerBots(db, "NiuBot", [
      { botId: "NiuBot", openId: "ou-niu", name: "NiuBot" },
      { botId: "CowBot", openId: "ou-cow", name: "CowBot" },
    ]);
    expect(getUserIdentityByPlatformId(db, "feishu", "ou-niu")).toBeUndefined();
    const cow = getUserIdentityByPlatformId(db, "feishu", "ou-cow");
    expect(cow?.isBot).toBe(true);
    const again = ensureUser(db, "feishu", "ou-cow", "CowBot");
    expect(again).toBe(cow?.id);
  });
});
