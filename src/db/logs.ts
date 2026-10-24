import type Database from "better-sqlite3";
import { deriveConversationKey } from "../util/conversationKey.js";
import {
  buildEstimatedBreakdown,
  estimateAnyRequest,
  estimateAnyResponse,
  normalizeUsage,
} from "../util/tokenEstimate.js";

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
  cached_tokens?: number;
  reasoning_tokens?: number;
  estimated_prompt_tokens?: number;
  estimated_completion_tokens?: number;
  estimated_total_tokens?: number;
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
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  estimated_total_tokens: number;
  usage_row_count: number;
  total_errors: number;
}

export interface TokenStatsSummary {
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  estimated_prompt_tokens: number;
  estimated_completion_tokens: number;
  estimated_total_tokens: number;
  variance_tokens: number;
  usage_rows: number;
  missing_usage_rows: number;
}

export interface TokenStatsPoint extends TokenStatsSummary {
  bucket: string;
}

const LOG_COLUMNS = `id, ts, provider_id, client_model, upstream_model, endpoint,
  status_code, duration_ms, prompt_tokens, completion_tokens, total_tokens,
  cached_tokens, reasoning_tokens, estimated_prompt_tokens,
  estimated_completion_tokens, estimated_total_tokens, stream, error_code,
  error_snippet, user_message, assistant_response, request_body, response_body,
  tool_call_count, thread_id, turn_id`;

let db: Database.Database | null = null;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:sk|tp)-[A-Za-z0-9._-]{8,}\b/g, "$1-***"],
  [/\b(?:Bearer|Authorization)\s*[:=]?\s*[A-Za-z0-9._~+/-]+=*/gi, "$1 ***"],
  [/\b([A-Za-z][A-Za-z0-9_]*_API_KEY|API_KEY)\b(\s*[:=]\s*)(\\?"?)([^\s",}\\]+)(\\?"?)/gi, "$1$2$3***$5"],
];

export function redactSecrets(value: string | null | undefined): string | null {
  if (value == null) return null;
  let out = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function initLogs(database: Database.Database) {
  db = database;
}

// Bodies used to be allowed to grow to 2 MB per column, which made this table the
// single largest memory consumer in the gateway: pulling a batch of those rows into
// JS pushed the 512 MB service limit over the edge and got the process OOM-killed.
// Writes are capped now; these helpers keep what is already on disk in line too.
export const LOG_BODY_MAX_CHARS = 64 * 1024;

export function pruneLogs(options: { maxAgeDays?: number; maxRows?: number } = {}) {
  if (!db) return { deletedByAge: 0, deletedByCount: 0 };
  const maxAgeDays = options.maxAgeDays ?? 14;
  const maxRows = options.maxRows ?? 2000;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const deletedByAge = db.prepare("DELETE FROM chat_logs WHERE ts < ?").run(cutoff).changes;
  const deletedByCount = db.prepare(
    "DELETE FROM chat_logs WHERE id NOT IN (SELECT id FROM chat_logs ORDER BY id DESC LIMIT ?)",
  ).run(maxRows).changes;
  return { deletedByAge, deletedByCount };
}

export function shrinkLogBodies(maxChars: number = LOG_BODY_MAX_CHARS) {
  if (!db) return 0;
  return db.prepare(
    "UPDATE chat_logs SET request_body = substr(request_body, 1, ?), response_body = substr(response_body, 1, ?) " +
    "WHERE length(request_body) > ? OR length(response_body) > ?",
  ).run(maxChars, maxChars, maxChars, maxChars).changes;
}

export function insertLog(log: Omit<ChatLog, "id">) {
  if (!db) return;
  let requestBody: any = null;
  let responseBody: any = null;
  try { requestBody = log.request_body ? JSON.parse(log.request_body) : null; } catch {}
  try { responseBody = log.response_body ? JSON.parse(log.response_body) : null; } catch {}
  const upstreamUsage = normalizeUsage(responseBody?.usage);
  const promptTokens = log.prompt_tokens ?? upstreamUsage.prompt_tokens ?? null;
  const completionTokens = log.completion_tokens ?? upstreamUsage.completion_tokens ?? null;
  const totalTokens = log.total_tokens ?? upstreamUsage.total_tokens
    ?? (promptTokens != null && completionTokens != null ? promptTokens + completionTokens : null);
  const estimatedPrompt = log.estimated_prompt_tokens
    ?? (requestBody ? estimateAnyRequest(requestBody) : 0);
  const estimatedCompletion = log.estimated_completion_tokens
    ?? (responseBody ? estimateAnyResponse(responseBody) : 0);
  const estimated = buildEstimatedBreakdown(estimatedPrompt, estimatedCompletion);
  const threadId = log.thread_id || deriveConversationKey(log.request_body);
  db.prepare(`
    INSERT INTO chat_logs (
      ts, provider_id, client_model, upstream_model, endpoint, status_code,
      duration_ms, prompt_tokens, completion_tokens, total_tokens, cached_tokens,
      reasoning_tokens, estimated_prompt_tokens, estimated_completion_tokens,
      estimated_total_tokens, stream, error_code, error_snippet, user_message,
      assistant_response, request_body, response_body, tool_call_count, thread_id, turn_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    log.ts, log.provider_id, log.client_model, log.upstream_model, log.endpoint,
    log.status_code, log.duration_ms, promptTokens, completionTokens, totalTokens,
    log.cached_tokens ?? upstreamUsage.cached_tokens,
    log.reasoning_tokens ?? upstreamUsage.reasoning_tokens,
    estimated.estimated_prompt_tokens, estimated.estimated_completion_tokens,
    estimated.estimated_total_tokens, log.stream, log.error_code ?? null,
    redactSecrets(log.error_snippet), redactSecrets(log.user_message),
    redactSecrets(log.assistant_response), redactSecrets(log.request_body),
    redactSecrets(log.response_body), log.tool_call_count ?? null,
    threadId, log.turn_id ?? null,
  );
}

export function queryLogs(limit: number = 200, providerId?: string, offset?: number): ChatLog[] {
  if (!db) return [];
  const off = offset ?? 0;
  if (providerId) {
    return db.prepare(`SELECT ${LOG_COLUMNS} FROM chat_logs WHERE provider_id = ? ORDER BY ts DESC LIMIT ? OFFSET ?`)
      .all(providerId, limit, off) as ChatLog[];
  }
  return db.prepare(`SELECT ${LOG_COLUMNS} FROM chat_logs ORDER BY ts DESC LIMIT ? OFFSET ?`)
    .all(limit, off) as ChatLog[];
}

export function getLogById(id: number): ChatLog | null {
  if (!db) return null;
  return db.prepare(`SELECT ${LOG_COLUMNS} FROM chat_logs WHERE id = ?`).get(id) as ChatLog | null;
}

export function queryConversations(limit: number = 50, offset?: number): Conversation[] {
  if (!db) return [];
  const off = offset ?? 0;
  return db.prepare(`
    SELECT
      c.thread_id,
      MIN(c.ts) AS first_ts,
      MAX(c.ts) AS last_ts,
      COUNT(*) AS message_count,
      MAX(c.provider_id) AS provider_id,
      MAX(c.client_model) AS client_model,
      (
        SELECT latest.user_message
        FROM chat_logs latest
        WHERE latest.thread_id = c.thread_id
          AND latest.user_message IS NOT NULL
          AND latest.user_message != ''
        ORDER BY latest.ts DESC
        LIMIT 1
      ) AS last_user_message,
      COALESCE(SUM(c.total_tokens), 0) AS total_tokens,
      COALESCE(SUM(c.prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(c.completion_tokens), 0) AS completion_tokens,
      COALESCE(SUM(c.cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(c.reasoning_tokens), 0) AS reasoning_tokens,
      COALESCE(SUM(c.estimated_total_tokens), 0) AS estimated_total_tokens,
      SUM(CASE WHEN c.total_tokens IS NOT NULL THEN 1 ELSE 0 END) AS usage_row_count,
      SUM(CASE WHEN c.status_code >= 400 THEN 1 ELSE 0 END) AS total_errors
    FROM chat_logs c
    WHERE c.thread_id IS NOT NULL AND c.thread_id != ''
    GROUP BY c.thread_id
    ORDER BY last_ts DESC
    LIMIT ? OFFSET ?
  `).all(limit, off) as Conversation[];
}

export function queryConversationLogs(threadId: string): ChatLog[] {
  if (!db) return [];
  return db.prepare(`SELECT ${LOG_COLUMNS} FROM chat_logs WHERE thread_id = ? ORDER BY ts ASC`)
    .all(threadId) as ChatLog[];
}

export function getConversationCount(): number {
  if (!db) return 0;
  const row = db.prepare("SELECT COUNT(DISTINCT thread_id) as cnt FROM chat_logs WHERE thread_id IS NOT NULL AND thread_id != ''").get() as any;
  return row?.cnt ?? 0;
}

function summarize(where = "", params: any[] = []): TokenStatsSummary {
  if (!db) {
    return {
      requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
      cached_tokens: 0, reasoning_tokens: 0, estimated_prompt_tokens: 0,
      estimated_completion_tokens: 0, estimated_total_tokens: 0, variance_tokens: 0,
      usage_rows: 0, missing_usage_rows: 0,
    };
  }
  const row = db.prepare(`
    SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
      COALESCE(SUM(estimated_prompt_tokens), 0) AS estimated_prompt_tokens,
      COALESCE(SUM(estimated_completion_tokens), 0) AS estimated_completion_tokens,
      COALESCE(SUM(estimated_total_tokens), 0) AS estimated_total_tokens,
      COALESCE(SUM(total_tokens), 0) - COALESCE(SUM(estimated_total_tokens), 0) AS variance_tokens,
      SUM(CASE WHEN total_tokens IS NOT NULL THEN 1 ELSE 0 END) AS usage_rows,
      SUM(CASE WHEN total_tokens IS NULL THEN 1 ELSE 0 END) AS missing_usage_rows
    FROM chat_logs
    ${where}
  `).get(...params) as any;
  return {
    requests: row?.requests ?? 0,
    prompt_tokens: row?.prompt_tokens ?? 0,
    completion_tokens: row?.completion_tokens ?? 0,
    total_tokens: row?.total_tokens ?? 0,
    cached_tokens: row?.cached_tokens ?? 0,
    reasoning_tokens: row?.reasoning_tokens ?? 0,
    estimated_prompt_tokens: row?.estimated_prompt_tokens ?? 0,
    estimated_completion_tokens: row?.estimated_completion_tokens ?? 0,
    estimated_total_tokens: row?.estimated_total_tokens ?? 0,
    variance_tokens: row?.variance_tokens ?? 0,
    usage_rows: row?.usage_rows ?? 0,
    missing_usage_rows: row?.missing_usage_rows ?? 0,
  };
}

export function getLogStats(): {
  totalRequests: number;
  todayRequests: number;
  totalTokens: number;
  errorRate: number;
  token: TokenStatsSummary;
} {
  if (!db) {
    return {
      totalRequests: 0, todayRequests: 0, totalTokens: 0, errorRate: 0,
      token: summarize(),
    };
  }
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
      COALESCE(SUM(total_tokens), 0) AS tokens,
      ROUND(CAST(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS FLOAT) / MAX(COUNT(*), 1) * 100, 1) AS error_rate
    FROM chat_logs
  `).get() as any;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayRow = db.prepare("SELECT COUNT(*) AS cnt FROM chat_logs WHERE ts >= ?").get(today.getTime()) as any;
  return {
    totalRequests: row?.total ?? 0,
    todayRequests: todayRow?.cnt ?? 0,
    totalTokens: row?.tokens ?? 0,
    errorRate: row?.error_rate ?? 0,
    token: summarize(),
  };
}

function rangeSince(range: string): number {
  const now = Date.now();
  if (range === "24h") return now - 24 * 60 * 60 * 1000;
  if (range === "30d") return now - 30 * 24 * 60 * 60 * 1000;
  if (range === "all") return 0;
  return now - 7 * 24 * 60 * 60 * 1000;
}

export function getTokenStats(range = "7d", bucket = "day"): {
  range: string;
  bucket: string;
  since: number;
  summary: TokenStatsSummary;
  points: TokenStatsPoint[];
} {
  const since = rangeSince(range);
  const bucketExpr = bucket === "hour"
    ? "strftime('%Y-%m-%dT%H', ts / 1000, 'unixepoch', 'localtime')"
    : "strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime')";
  let points: TokenStatsPoint[] = [];
  if (db) {
    points = db.prepare(`
      SELECT ${bucketExpr} AS bucket,
        COUNT(*) AS requests,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(estimated_prompt_tokens), 0) AS estimated_prompt_tokens,
        COALESCE(SUM(estimated_completion_tokens), 0) AS estimated_completion_tokens,
        COALESCE(SUM(estimated_total_tokens), 0) AS estimated_total_tokens,
        COALESCE(SUM(total_tokens), 0) - COALESCE(SUM(estimated_total_tokens), 0) AS variance_tokens,
        SUM(CASE WHEN total_tokens IS NOT NULL THEN 1 ELSE 0 END) AS usage_rows,
        SUM(CASE WHEN total_tokens IS NULL THEN 1 ELSE 0 END) AS missing_usage_rows
      FROM chat_logs
      WHERE ts >= ?
      GROUP BY bucket
      ORDER BY bucket ASC
    `).all(since) as TokenStatsPoint[];
  }
  return {
    range,
    bucket,
    since,
    summary: summarize(since > 0 ? "WHERE ts >= ?" : "", since > 0 ? [since] : []),
    points,
  };
}
