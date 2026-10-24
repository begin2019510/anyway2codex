import type { ResponsesRequest, ChatRequest, ChatMessage } from "../translate/types.js";

export interface TokenUsageBreakdown {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  cached_tokens?: number | null;
  reasoning_tokens?: number | null;
}

export interface EstimatedTokenBreakdown {
  estimated_prompt_tokens: number;
  estimated_completion_tokens: number;
  estimated_total_tokens: number;
}

const CHARS_PER_TOKEN = 4;
const CJK_CHARS_PER_TOKEN = 1.5;
const IMAGE_TOKEN_ESTIMATE = 1024;

function textTokenEstimate(value: unknown): number {
  if (value == null) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return 0;
  let cjkChars = 0;
  let otherChars = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x3400 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) cjkChars += 1;
    else otherChars += 1;
  }
  return Math.ceil(cjkChars / CJK_CHARS_PER_TOKEN) + Math.ceil(otherChars / CHARS_PER_TOKEN);
}

function imageCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const part of content) {
    const type = (part as any)?.type;
    if (type === "input_image" || type === "image_url" || type === "image") count += 1;
  }
  return count;
}

function contentText(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: content == null ? "" : JSON.stringify(content), images: 0 };
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") parts.push(part);
    else if (part && typeof part === "object") {
      const value = part as any;
      if (typeof value.text === "string") parts.push(value.text);
      else if (typeof value.content === "string") parts.push(value.content);
      else if (value.type === "image_url" || value.type === "input_image" || value.type === "image") continue;
      else parts.push(JSON.stringify(value));
    }
  }
  return { text: parts.join("\n"), images: imageCount(content) };
}

function estimateMessages(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages || []) {
    const content = contentText((message as any).content);
    total += textTokenEstimate((message as any).role) + textTokenEstimate(content.text);
    total += content.images * IMAGE_TOKEN_ESTIMATE;
    total += textTokenEstimate((message as any).reasoning_content);
    if (Array.isArray((message as any).tool_calls)) {
      for (const call of (message as any).tool_calls) {
        total += textTokenEstimate(call?.function?.name);
        total += textTokenEstimate(call?.function?.arguments);
      }
    }
  }
  return total;
}

export function estimateChatRequest(request: ChatRequest): number {
  return estimateMessages(request.messages || [])
    + textTokenEstimate(request.tools)
    + textTokenEstimate(request.tool_choice);
}

export function estimateChatResponse(response: unknown): number {
  const body = response as any;
  let total = 0;
  const choices = Array.isArray(body?.choices) ? body.choices : [];
  for (const choice of choices) {
    const message = choice?.message || {};
    total += textTokenEstimate(message.content);
    total += textTokenEstimate(message.reasoning_content);
    for (const call of message.tool_calls || []) {
      total += textTokenEstimate(call?.function?.name);
      total += textTokenEstimate(call?.function?.arguments);
    }
  }
  return total;
}

function responsesInputItems(request: ResponsesRequest): any[] {
  if (Array.isArray(request.input)) return request.input;
  if (typeof request.input === "string") return [{ type: "message", role: "user", content: request.input }];
  if (request.input && typeof request.input === "object") {
    const entries = Object.entries(request.input as Record<string, unknown>)
      .filter(([key]) => /^\d+$/.test(key))
      .sort(([left], [right]) => Number(left) - Number(right));
    if (entries.length) return entries.map(([, value]) => value);
  }
  return [];
}

export function estimateResponsesRequest(request: ResponsesRequest): number {
  let total = textTokenEstimate(request.instructions);
  total += textTokenEstimate(request.tools);
  total += textTokenEstimate(request.tool_choice);
  for (const item of responsesInputItems(request)) {
    if (!item || typeof item !== "object") {
      total += textTokenEstimate(item);
      continue;
    }
    const type = item.type || "message";
    if (type === "message" || type === "function_call_output" || type === "reasoning") {
      const parsed = contentText(item.content ?? item.output ?? item.summary ?? item.encrypted_content);
      total += textTokenEstimate(item.role || type) + textTokenEstimate(parsed.text);
      total += parsed.images * IMAGE_TOKEN_ESTIMATE;
    } else {
      total += textTokenEstimate(item);
    }
  }
  return total;
}

export function estimateResponsesOutput(output: unknown[]): number {
  if (output && !Array.isArray(output) && typeof output === "object") {
    const entries = Object.entries(output as Record<string, unknown>)
      .filter(([key]) => /^\d+$/.test(key))
      .sort(([left], [right]) => Number(left) - Number(right));
    if (entries.length) output = entries.map(([, value]) => value);
  }
  let total = 0;
  for (const item of output || []) {
    if (!item || typeof item !== "object") {
      total += textTokenEstimate(item);
      continue;
    }
    const value = item as any;
    if (value.type === "message") {
      const parsed = contentText(value.content);
      total += textTokenEstimate(parsed.text);
      total += parsed.images * IMAGE_TOKEN_ESTIMATE;
    } else if (value.type === "reasoning") {
      total += textTokenEstimate(value.encrypted_content);
      total += textTokenEstimate(value.summary);
    } else if (value.type === "function_call") {
      total += textTokenEstimate(value.name) + textTokenEstimate(value.arguments);
    } else {
      total += textTokenEstimate(value);
    }
  }
  return total;
}

export function estimateResponsesResponse(response: unknown): number {
  return estimateResponsesOutput((response as any)?.output || []);
}

export function estimateAnyRequest(request: unknown): number {
  const body = request as any;
  if (Array.isArray(body?.messages)) return estimateChatRequest(body);
  if (body && ("input" in body || typeof body.instructions === "string")) {
    return estimateResponsesRequest(body);
  }
  return textTokenEstimate(body);
}

export function estimateAnyResponse(response: unknown): number {
  const body = response as any;
  if (Array.isArray(body?.output)) return estimateResponsesOutput(body.output);
  if (Array.isArray(body?.choices)) return estimateChatResponse(body);
  return textTokenEstimate(body);
}

export function normalizeUsage(usage: unknown): TokenUsageBreakdown {
  const value = usage as any;
  if (!value || typeof value !== "object") return {};
  const input = value.input_tokens ?? value.prompt_tokens ?? null;
  const output = value.output_tokens ?? value.completion_tokens ?? null;
  const total = value.total_tokens ?? (
    typeof input === "number" && typeof output === "number" ? input + output : null
  );
  const cached = value.input_tokens_details?.cached_tokens
    ?? value.prompt_tokens_details?.cached_tokens
    ?? null;
  const reasoning = value.output_tokens_details?.reasoning_tokens
    ?? value.completion_tokens_details?.reasoning_tokens
    ?? null;
  return {
    prompt_tokens: typeof input === "number" ? input : null,
    completion_tokens: typeof output === "number" ? output : null,
    total_tokens: typeof total === "number" ? total : null,
    cached_tokens: typeof cached === "number" ? cached : null,
    reasoning_tokens: typeof reasoning === "number" ? reasoning : null,
  };
}

export function buildEstimatedBreakdown(
  estimatedPrompt: number,
  estimatedCompletion: number,
): EstimatedTokenBreakdown {
  return {
    estimated_prompt_tokens: Math.max(0, Math.round(estimatedPrompt)),
    estimated_completion_tokens: Math.max(0, Math.round(estimatedCompletion)),
    estimated_total_tokens: Math.max(0, Math.round(estimatedPrompt + estimatedCompletion)),
  };
}
