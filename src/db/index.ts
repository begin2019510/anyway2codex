import Database from "better-sqlite3";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { MIGRATIONS } from "./schema.js";
import { initLogs } from "./logs.js";
import { initSettings } from "./settings.js";
import { log } from "../util/log.js";

let _db: Database.Database | null = null;

export function getDb(dataDir: string): Database.Database {
  if (_db) return _db;
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "anyway2codex.db");
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  migrate(_db);
  initLogs(_db);
  initSettings(_db);
  log.info("database initialized: " + dbPath);
  return _db;
}

function migrate(db: Database.Database) {
  // Create schema_version table if it doesn't exist
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");

  const row = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as any;
  const currentVersion = row?.v ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      log.info("applying migration v" + migration.version);
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(migration.version, Date.now());
    }
  }
}
