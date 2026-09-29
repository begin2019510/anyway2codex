import { UpstreamError } from "./upstream/client.js";

const FALLBACK_STATUSES = new Set([401, 402, 403, 404, 408, 429]);
const MODEL_OR_CONTEXT_PATTERNS = [
  /unsupported\s+model/i,
  /model[^\n]{0,80}(not found|unknown|invalid)/i,
  /context[^\n]{0,80}(length|window|limit|overflow)/i,
  /responses_feature_not_supported/i,
];

export function shouldFallback(err: unknown, clientAborted = false): boolean {
  if (clientAborted) return false;
  if (err instanceof UpstreamError) {
    if (FALLBACK_STATUSES.has(err.status) || err.status >= 500) return true;
    if (err.code === "upstream_unreachable") return true;
    if (err.status === 400 && MODEL_OR_CONTEXT_PATTERNS.some((pattern) => pattern.test(err.message))) return true;
    return false;
  }
  if (err instanceof DOMException && err.name === "AbortError") return false;
  return false;
}

export function fallbackLogSnippet(err: unknown, pending: boolean): string {
  const message = err instanceof Error ? err.message : String(err);
  return (pending ? "[fallback pending] " : "[fallback exhausted] ") + message;
}
