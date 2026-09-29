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
  ensureLogColumns(_db);
  ensureLogRedactionTriggers(_db);
  initLogs(_db);
  initSettings(_db);
  log.info("database initialized: " + dbPath);
  return _db;
}

function ensureLogRedactionTriggers(db: Database.Database) {
  const tokenLength = "CAST(COALESCE((SELECT value FROM settings WHERE key = 'key_length_mimo'), '0') AS INTEGER)";
  const redact = (column: string) => [
    "CASE",
    "WHEN instr(NEW." + column + ", 'tp-') > 0 AND " + tokenLength + " > 0 THEN",
    "substr(NEW." + column + ", 1, instr(NEW." + column + ", 'tp-') - 1)",
    "|| '[REDACTED]'",
    "|| substr(NEW." + column + ", instr(NEW." + column + ", 'tp-') + " + tokenLength + ")",
    "ELSE NEW." + column,
    "END",
  ].join(" ");
  db.exec(
    "DROP TRIGGER IF EXISTS redact_chat_logs_insert; " +
    "CREATE TRIGGER redact_chat_logs_insert AFTER INSERT ON chat_logs BEGIN " +
    "UPDATE chat_logs SET " +
    "error_snippet = " + redact("error_snippet") + ", " +
    "user_message = " + redact("user_message") + ", " +
    "assistant_response = " + redact("assistant_response") + ", " +
    "request_body = " + redact("request_body") + ", " +
    "response_body = " + redact("response_body") + " " +
    "WHERE id = NEW.id; END;"
  );
}

function ensureLogColumns(db: Database.Database) {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(chat_logs)").all() as any[]).map((row) => row.name),
  );
  const columns: Array<[string, string]> = [
    ["user_message", "TEXT"],
    ["assistant_response", "TEXT"],
    ["request_body", "TEXT"],
    ["response_body", "TEXT"],
    ["tool_call_count", "INTEGER"],
    ["thread_id", "TEXT"],
    ["turn_id", "TEXT"],
  ];
  for (const [name, type] of columns) {
    if (!existing.has(name)) db.exec("ALTER TABLE chat_logs ADD COLUMN " + name + " " + type);
  }
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
