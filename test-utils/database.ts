import Database from "better-sqlite3";
import { afterEach } from "vitest";
import { initDatabase } from "../src/database/schema.js";

const openDatabases = new Set<Database.Database>();

/**
 * Open a test database and close every database opened by this helper after
 * the current test. This is required on Windows before removing its files.
 */
export function openTestDatabase(filePath: string): Database.Database {
  const db = initDatabase(filePath);
  openDatabases.add(db);
  return db;
}

/**
 * Open a raw test database without initializing the NiuBot schema.
 * The handle is still tracked so temporary files can be removed safely on Windows.
 */
export function openRawTestDatabase(filePath: string, options?: Database.Options): Database.Database {
  const db = options === undefined ? new Database(filePath) : new Database(filePath, options);
  openDatabases.add(db);
  return db;
}

export function closeTestDatabases(): void {
  for (const db of openDatabases) {
    if (db.open) db.close();
  }
  openDatabases.clear();
}

afterEach(closeTestDatabases);
