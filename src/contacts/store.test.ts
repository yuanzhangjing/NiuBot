import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../database/schema.js";
import { assertContactsAccess, listChats, listUsers, setUserManualName } from "./store.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-contact-store-"));
  tempDirs.push(dir);
  const db = initDatabase(path.join(dir, "niubot.db"));
  openDatabases.push(db);
  db.prepare("INSERT INTO users (id, name, platform, platform_id) VALUES ('u2', 'Zen', 'feishu', 'p2')").run();
  db.prepare("INSERT INTO chats (id, type, platform, platform_id, user_id) VALUES ('c1', 'p2p', 'feishu', 'pc1', 'p2')").run();
  return db;
}

describe("contacts store", () => {
  it("blocks contacts access in group chats", () => {
    expect(() => assertContactsAccess({ chatType: "group" }))
      .toThrow("contacts are only available in private chat");
  });

  it("lists and updates contacts through the shared store", () => {
    const db = setupDb();

    expect(listUsers(db, {}).map((u) => u.id)).toEqual(["u2"]);
    expect(listChats(db, {}).map((c) => c.id)).toEqual(["c1"]);

    setUserManualName(db, "u2", "Zen2");
    expect(listUsers(db, { name: "Zen2" }).map((u) => u.name)).toEqual(["Zen2"]);
  });

  it("throws when updating a missing user", () => {
    const db = setupDb();

    expect(() => setUserManualName(db, "u404", "Nobody")).toThrow('User "u404" not found');
  });
});
