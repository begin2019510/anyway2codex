import type Database from "better-sqlite3";

export interface ChatLog {
  id: number;
  ts: number;
  provider_id: string;
  client_model: string;
  upstream_model: string;
  endpoint: string;
  status_code: number;
  duration_ms: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  stream: number;
  error_code?: string;
  error_snippet?: string;
  user_message?: string;
  assistant_response?: string;
  request_body?: string;
  response_body?: string;
  tool_call_count?: number;
  thread_id?: string;
  turn_id?: string;
}

export interface Conversation {
  thread_id: string;
  first_ts: number;
  last_ts: number;
  message_count: number;
  provider_id: string;
  client_model: string;
  last_user_message: string;
  total_tokens: number;
  total_errors: number;
}

let db: Database.Database | null = null;

export function initLogs(database: Database.Database) {
  db = database;
}

export function insertLog(log: Omit<ChatLog, "id">) {
  if (!db) return;
  db.prepare(`
    INSERT INTO chat_logs (ts, provider_id, client_model, upstream_model, endpoint, status_code, duration_ms, prompt_tokens, completion_tokens, total_tokens, stream, error_code, error_snippet, user_message, assistant_response, request_body, response_body, tool_call_count, thread_id, turn_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    log.ts, log.provider_id, log.client_model, log.upstream_model, log.endpoint,
    log.status_code, log.duration_ms, log.prompt_tokens ?? null,
    log.completion_tokens ?? null, log.total_tokens ?? null, log.stream,
    log.error_code ?? null, log.error_snippet ?? null,
    log.user_message ?? null, log.assistant_response ?? null,
    log.request_body ?? null, log.response_body ?? null, log.tool_call_count ?? null,
    log.thread_id ?? null, log.turn_id ?? null,
  );
}

export function queryLogs(limit: number = 200, providerId?: string, offset?: number): ChatLog[] {
  if (!db) return [];
  const off = offset ?? 0;
  if (providerId) {
    return db.prepare("SELECT id, ts, provider_id, client_model, upstream_model, endpoint, status_code, duration_ms, prompt_tokens, completion_tokens, total_tokens, stream, error_code, error_snippet, user_message, assistant_response, tool_call_count, thread_id, turn_id FROM chat_logs WHERE provider_id = ? ORDER BY ts DESC LIMIT ? OFFSET ?").all(providerId, limit, off) as ChatLog[];
  }
  return db.prepare("SELECT id, ts, provider_id, client_model, upstream_model, endpoint, status_code, duration_ms, prompt_tokens, completion_tokens, total_tokens, stream, error_code, error_snippet, user_message, assistant_response, tool_call_count, thread_id, turn_id FROM chat_logs ORDER BY ts DESC LIMIT ? OFFSET ?").all(limit, off) as ChatLog[];
}

export function getLogById(id: number): ChatLog | null {
  if (!db) return null;
  return db.prepare("SELECT id, ts, provider_id, client_model, upstream_model, endpoint, status_code, duration_ms, prompt_tokens, completion_tokens, total_tokens, stream, error_code, error_snippet, user_message, assistant_response, request_body, response_body, tool_call_count, thread_id, turn_id FROM chat_logs WHERE id = ?").get(id) as ChatLog | null;
}

export function queryConversations(limit: number = 50, offset?: number): Conversation[] {
  if (!db) return [];
  const off = offset ?? 0;
  return db.prepare(`
    SELECT
      thread_id,
      MIN(ts) as first_ts,
      MAX(ts) as last_ts,
      COUNT(*) as message_count,
      provider_id,
      client_model,
      MAX(CASE WHEN user_message IS NOT NULL AND user_message != '' THEN user_message END) as last_user_message,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as total_errors
    FROM chat_logs
    WHERE thread_id IS NOT NULL AND thread_id != ''
    GROUP BY thread_id
    ORDER BY last_ts DESC
    LIMIT ? OFFSET ?
  `).all(limit, off) as Conversation[];
}

export function queryConversationLogs(threadId: string): ChatLog[] {
  if (!db) return [];
  return db.prepare("SELECT id, ts, provider_id, client_model, upstream_model, endpoint, status_code, duration_ms, prompt_tokens, completion_tokens, total_tokens, stream, error_code, error_snippet, user_message, assistant_response, request_body, response_body, tool_call_count, thread_id, turn_id FROM chat_logs WHERE thread_id = ? ORDER BY ts ASC").all(threadId) as ChatLog[];
}

export function getConversationCount(): number {
  if (!db) return 0;
  const row = db.prepare("SELECT COUNT(DISTINCT thread_id) as cnt FROM chat_logs WHERE thread_id IS NOT NULL AND thread_id != ''").get() as any;
  return row?.cnt ?? 0;
}

export function getLogStats(): { totalRequests: number; totalTokens: number; errorRate: number } {
  if (!db) return { totalRequests: 0, totalTokens: 0, errorRate: 0 };
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(total_tokens), 0) as tokens,
      ROUND(CAST(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS FLOAT) / MAX(COUNT(*), 1) * 100, 1) as error_rate
    FROM chat_logs
  `).get() as any;
  return {
    totalRequests: row?.total ?? 0,
    totalTokens: row?.tokens ?? 0,
    errorRate: row?.error_rate ?? 0,
  };
}
