export const MIGRATIONS = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS api_keys (
  provider_id TEXT PRIMARY KEY,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  provider_id TEXT NOT NULL,
  client_model TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  stream INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_snippet TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_logs_ts ON chat_logs(ts DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mode_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  from_mode TEXT,
  to_mode TEXT,
  provider_id TEXT,
  model_id TEXT,
  note TEXT
);
`,
  },
  {
    version: 4,
    sql: `
CREATE TABLE IF NOT EXISTS provider_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_encrypted TEXT,
  api_key_hint TEXT,
  source TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_provider_credentials_provider
  ON provider_credentials(provider_id, changed_at DESC);
`,
  },
  // v4: thread_id and turn_id already added manually

];
