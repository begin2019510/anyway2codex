import { log } from "../util/log.js";

export class UpstreamError extends Error {
  status: number;
  bodySnippet?: string;
  code: string;
  constructor(opts: { status: number; message: string; code: string; bodySnippet?: string }) {
    super(opts.message);
    this.name = "UpstreamError";
    this.status = opts.status;
    this.code = opts.code;
    this.bodySnippet = opts.bodySnippet;
  }
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function retryDelayMs(res: Response | null, attempt: number, baseMs: number): number {
  const CAP = 10_000;
  if (res) {
    const ra = res.headers.get("retry-after");
    if (ra) {
      const secs = Number(ra);
      if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1000, CAP);
    }
  }
  const exp = baseMs * 2 ** attempt;
  return Math.min(exp, 12_000) + Math.floor(Math.random() * 250);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readSnippet(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    return text.length > 800 ? text.slice(0, 800) + "..." : text;
  } catch { return undefined; }
}

function defaultErrorCode(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_denied";
  if (status === 429) return "rate_limit_exceeded";
  if (status >= 500) return "server_error";
  return "bad_request";
}

export interface UpstreamConfig {
  baseUrl: string;
  apiKey: string;
  maxRetries?: number;
  retryBaseMs?: number;
  userAgent?: string;
  enhanceError?: (ctx: { status: number; snippet?: string }) => { code: string; message: string } | null;
  /**
   * Reports a failure that no amount of retrying can fix (exhausted quota, unknown
   * model id). Checked before the retry decision so the client fails fast instead of
   * spending the whole backoff budget on a permanent error.
   */
  isTerminalError?: (ctx: { status: number; snippet?: string }) => boolean;
  /** Protocol headers to attach, e.g. anthropic-version / anthropic-beta. */
  extraHeaders?: Record<string, string | undefined>;
  contextOverflowMode?: string;
  modelInfo?: { id: string; contextWindow?: number };
}

// Send a Chat Completions request to the upstream
export async function callOpenAICompat(
  cfg: UpstreamConfig,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const normalized = { ...body };
  if (normalized.stream !== true) delete normalized.stream_options;
  return await postUpstream(cfg, "/chat/completions", normalized, signal);
}

// Sanitize Responses API body: strip params unsupported by non-OpenAI providers
export function sanitizePassthroughBody(body: Record<string, unknown>): Record<string, unknown> {
  const stripTop = new Set([
    "store", "include", "prompt_cache_key", "client_metadata",
    "previous_response_id", "background", "context_management",
    "parallel_tool_calls",
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (stripTop.has(k)) continue;
    if (k === "reasoning" && typeof v === "object" && v !== null) {
      const r = v as Record<string, unknown>;
      const clean: Record<string, unknown> = {};
      if (r.effort !== undefined) clean.effort = r.effort;
      out.reasoning = clean;
      continue;
    }
    out[k] = v;
  }
  return out;
}

// Send a Responses API request directly to the upstream (passthrough)
export async function callResponsesPassthrough(
  cfg: UpstreamConfig,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  return await postUpstream(cfg, "/responses", sanitizePassthroughBody(body), signal);
}

/**
 * Send an Anthropic Messages request upstream. cfg.baseUrl must already point at the
 * Send an Anthropic Messages request upstream. cfg.baseUrl is the value a Claude client
 * would put in ANTHROPIC_BASE_URL, so the request goes to that base plus /v1/messages -
 * verified against the Qwen and the MiMo gateways, where base plus /messages alone
 * answers 404. A base already ending in /v1 is accepted too. The body is forwarded
 * exactly as the caller built it: nothing is rewritten here, because whatever the
 * client asked for has to be whatever the upstream answers.
 */
export async function callAnthropicMessages(
  cfg: UpstreamConfig,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const base = cfg.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
  return await postUpstream({ ...cfg, baseUrl: base }, "/v1/messages", body, signal);
}

async function postUpstream(
  cfg: UpstreamConfig,
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const url = cfg.baseUrl.replace(/\/+$/, "") + path;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + cfg.apiKey,
    "Accept": "text/event-stream, application/json",
  };
  if (cfg.userAgent) headers["User-Agent"] = cfg.userAgent;
  for (const [name, value] of Object.entries(cfg.extraHeaders ?? {})) {
    if (value) headers[name] = value;
  }

  const maxRetries = cfg.maxRetries ?? 6;
  const baseMs = cfg.retryBaseMs ?? 500;
  const serialized = JSON.stringify(body);
  if (process.env.ANYWAY2CODEX_DEBUG_UPSTREAM) { console.error("[POST] " + url + " body_len=" + serialized.length + " model=" + (body as any).model + " msgs=" + ((body as any).messages?.length ?? 0) + " tools=" + ((body as any).tools?.length ?? 0)); }
  // Per-request timeout: abort if upstream doesn't respond in 120s
  const timeoutAc = new AbortController();
  const timeoutId = setTimeout(() => timeoutAc.abort(), 120_000);
  // Chain: if either the caller signal OR the timeout fires, abort
  const mergedSignal = AbortSignal.any([signal, timeoutAc.signal]);
  const doFetch = () => fetch(url, { method: "POST", headers, body: serialized, signal: mergedSignal });

  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await doFetch();
    } catch (err: any) {
      if (err.name === "AbortError") {
        if (timeoutAc.signal.aborted && !signal.aborted) {
          throw new UpstreamError({
            status: 504,
            code: "upstream_timeout",
            message: "upstream did not respond before the request timeout",
          });
        }
        throw err;
      }
      if (attempt < maxRetries) {
        const delay = retryDelayMs(null, attempt, baseMs);
        log.warn("upstream connect failed, retry " + (attempt + 1) + "/" + maxRetries + " in " + delay + "ms");
        await abortableSleep(delay, signal);
        clearTimeout(timeoutId);
        attempt++;
        continue;
      }
      clearTimeout(timeoutId);
    throw new UpstreamError({ status: 502, code: "upstream_unreachable", message: "failed to reach upstream: " + err.message });
    }

    clearTimeout(timeoutId);
    if (res.ok) return res;

    // Read the body once: it is needed both for the retry decision and for the
    // surfaced error, and a Response body can only be consumed one time.
    const snippet = await readSnippet(res);
    const terminal = cfg.isTerminalError?.({ status: res.status, snippet }) === true;
    if (!terminal && RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries) {
      const delay = retryDelayMs(res, attempt, baseMs);
      log.warn("upstream " + res.status + ", retry " + (attempt + 1) + "/" + maxRetries + " in " + delay + "ms");
      await abortableSleep(delay, signal);
      attempt++;
      continue;
    }

    const enhanced = cfg.enhanceError?.({ status: res.status, snippet });
    const code = enhanced?.code ?? defaultErrorCode(res.status);
    const base = enhanced?.message ?? "upstream returned " + res.status + ": " + (snippet ?? "(no body)");
    const message = terminal
      ? base + (enhanced ? "" : " (not retried: this failure is terminal)")
      : base;
    throw new UpstreamError({ status: res.status, code, message, bodySnippet: snippet });
  }
}

