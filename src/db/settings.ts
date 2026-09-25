import type Database from "better-sqlite3";

let db: Database.Database | null = null;

export function initSettings(database: Database.Database) {
  db = database;
}

export function getSetting(key: string): string | null {
  if (!db) return null;
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  if (!db) return;
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(key, value, Date.now());
}

export function getAllSettings(): Record<string, string> {
  if (!db) return {};
  const rows = db.prepare("SELECT key, value FROM settings").all() as any[];
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}
