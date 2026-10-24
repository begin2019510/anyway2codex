import { createHash } from "node:crypto";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function parseJson(value: unknown): any {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function metadataThread(body: any): string | null {
  const metadata = body?.client_metadata;
  if (metadata && typeof metadata === "object") {
    if (typeof metadata.thread_id === "string" && metadata.thread_id) return metadata.thread_id;
    if (typeof metadata.session_id === "string" && metadata.session_id) return metadata.session_id;
  }
  const nested = parseJson(metadata?.["x-codex-turn-metadata"]);
  if (nested && typeof nested === "object") {
    if (typeof nested.thread_id === "string" && nested.thread_id) return nested.thread_id;
    if (typeof nested.session_id === "string" && nested.session_id) return nested.session_id;
  }
  return null;
}

function firstUserText(body: any): string {
  let input = Array.isArray(body?.input) ? body.input : [];
  if (!Array.isArray(input) && body?.input && typeof body.input === "object") {
    input = Object.entries(body.input as Record<string, unknown>)
      .filter(([key]) => /^\d+$/.test(key))
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([, value]) => value);
  }
  for (const item of input) {
    if (item?.type !== "message" || item?.role !== "user") continue;
    if (typeof item.content === "string") return item.content;
    if (Array.isArray(item.content)) {
      const text = item.content
        .map((part: any) => typeof part?.text === "string" ? part.text : "")
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
  }
  return "";
}

export function deriveConversationKey(requestBody: unknown, logId?: number): string {
  const body = parseJson(requestBody);
  if (!body || typeof body !== "object") {
    return logId == null ? "anon-request" : `anon-request-${logId}`;
  }
  const explicit = metadataThread(body);
  if (explicit) return explicit;
  const firstUser = firstUserText(body);
  if (!firstUser) {
    return logId == null
      ? `anon-request-${hash(JSON.stringify(body))}`
      : `anon-request-${logId}`;
  }
  return `derived-${hash(String(body.instructions || "") + "\n" + firstUser)}`;
}
