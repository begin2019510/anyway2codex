import Database from "better-sqlite3";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { MIGRATIONS } from "./schema.js";
import { initLogs, pruneLogs, shrinkLogBodies } from "./logs.js";
import { initSettings } from "./settings.js";
import { log } from "../util/log.js";
import { deriveConversationKey } from "../util/conversationKey.js";
import {
  buildEstimatedBreakdown,
  estimateAnyRequest,
  estimateAnyResponse,
  normalizeUsage,
} from "../util/tokenEstimate.js";

let _db: Database.Database | null = null;

export function getDb(dataDir: string): Database.Database {
  if (_db) return _db;
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "anyway2codex.db");
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  migrate(_db);
  ensureLogColumns(_db);
  backfillLogMetadata(_db);
  ensureLogRedactionTriggers(_db);
  initLogs(_db);
  initSettings(_db);
  maintainLogs();
  const maintenanceTimer = setInterval(maintainLogs, 6 * 60 * 60 * 1000);
  if (typeof maintenanceTimer.unref === "function") maintenanceTimer.unref();
  log.info("database initialized: " + dbPath);
  return _db;
}

// Keeps chat_logs from growing back into the memory limit: shrink any oversized body
// left over from before the write-time cap, then drop rows past the retention window
// (14 days / 2000 rows). Runs at startup and every six hours.
function maintainLogs() {
  try {
    const shrunk = shrinkLogBodies();
    if (shrunk > 0) log.info("log bodies shrunk on " + shrunk + " rows");
    const pruned = pruneLogs();
    if (pruned.deletedByAge > 0 || pruned.deletedByCount > 0) {
      log.info("logs pruned: byAge=" + pruned.deletedByAge + " byCount=" + pruned.deletedByCount);
    }
  } catch (err) {
    log.warn("log maintenance failed: " + (err as Error).message);
  }
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
    ["cached_tokens", "INTEGER"],
    ["reasoning_tokens", "INTEGER"],
    ["estimated_prompt_tokens", "INTEGER"],
    ["estimated_completion_tokens", "INTEGER"],
    ["estimated_total_tokens", "INTEGER"],
  ];
  for (const [name, type] of columns) {
    if (!existing.has(name)) db.exec("ALTER TABLE chat_logs ADD COLUMN " + name + " " + type);
  }
}

function parseStoredJson(value: string | null): any {
  if (!value) return null;
  try { return JSON.parse(value); } catch {}
  const repaired = value.replace(
    /(\b(?:[A-Za-z][A-Za-z0-9_]*_API_KEY|API_KEY)\b\s*[:=]\s*)\*\*\*(?!\\)"/gi,
    (_match, prefix) => prefix + "***\\\"",
  );
  try { return JSON.parse(repaired); } catch { return null; }
}

function backfillLogMetadata(db: Database.Database) {
  const rows = db.prepare(`
    SELECT id, thread_id, request_body, response_body,
           prompt_tokens, completion_tokens, total_tokens, cached_tokens, reasoning_tokens,
           estimated_prompt_tokens, estimated_completion_tokens, estimated_total_tokens
    FROM chat_logs
    WHERE thread_id IS NULL OR thread_id = ''
       OR estimated_prompt_tokens IS NULL OR estimated_completion_tokens IS NULL
       OR estimated_total_tokens IS NULL
       OR estimated_prompt_tokens = 0
  `).all() as any[];
  if (!rows.length) return;

  const update = db.prepare(`
    UPDATE chat_logs SET
      thread_id = ?,
      prompt_tokens = ?,
      completion_tokens = ?,
      total_tokens = ?,
      cached_tokens = ?,
      reasoning_tokens = ?,
      estimated_prompt_tokens = ?,
      estimated_completion_tokens = ?,
      estimated_total_tokens = ?
    WHERE id = ?
  `);
  const apply = db.transaction(() => {
    for (const row of rows) {
      const requestBody = parseStoredJson(row.request_body);
      const responseBody = parseStoredJson(row.response_body);
      const usage = normalizeUsage(responseBody?.usage);
      const prompt = row.prompt_tokens ?? usage.prompt_tokens;
      const completion = row.completion_tokens ?? usage.completion_tokens;
      const total = row.total_tokens ?? usage.total_tokens
        ?? (prompt != null && completion != null ? prompt + completion : null);
      const estimatedPrompt = row.estimated_prompt_tokens == null || row.estimated_prompt_tokens === 0
        ? (requestBody ? estimateAnyRequest(requestBody) : 0)
        : row.estimated_prompt_tokens;
      const estimatedCompletion = row.estimated_completion_tokens == null || row.estimated_completion_tokens === 0
        ? (responseBody ? estimateAnyResponse(responseBody) : 0)
        : row.estimated_completion_tokens;
      const estimated = buildEstimatedBreakdown(estimatedPrompt, estimatedCompletion);
      update.run(
        row.thread_id || deriveConversationKey(row.request_body, row.id),
        prompt,
        completion,
        total,
        row.cached_tokens ?? usage.cached_tokens,
        row.reasoning_tokens ?? usage.reasoning_tokens,
        estimated.estimated_prompt_tokens,
        estimated.estimated_completion_tokens,
        estimated.estimated_total_tokens,
        row.id,
      );
    }
  });
  apply();
  log.info("backfilled metadata for " + rows.length + " chat logs");
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
