import type Database from "better-sqlite3";
import { ensureUser, setUserIsBot } from "./database/schema.js";

export type PeerBotIdentity = {
  botId: string;
  openId: string;
  name: string;
};

/** 同机 Bot 连上飞书后登记 open_id，供彼此写入 users.is_bot。 */
export class PeerBotDirectory {
  private readonly peers = new Map<string, PeerBotIdentity>();
  private readonly listeners = new Set<(peers: PeerBotIdentity[]) => void>();

  register(peer: PeerBotIdentity): void {
    if (!peer.openId) return;
    this.peers.set(peer.botId, peer);
    const snapshot = this.list();
    for (const listener of this.listeners) listener(snapshot);
  }

  list(): PeerBotIdentity[] {
    return [...this.peers.values()];
  }

  subscribe(listener: (peers: PeerBotIdentity[]) => void): () => void {
    this.listeners.add(listener);
    if (this.peers.size > 0) listener(this.list());
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export function seedPeerBots(
  db: Database.Database,
  selfBotId: string,
  peers: PeerBotIdentity[],
): void {
  for (const peer of peers) {
    if (peer.botId === selfBotId || !peer.openId) continue;
    const userId = ensureUser(db, "feishu", peer.openId, peer.name || peer.botId, "bot_info");
    setUserIsBot(db, userId);
  }
}
