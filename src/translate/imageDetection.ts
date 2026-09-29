import type { ChatRequest, ResponsesRequest } from "./types.js";

function contentPartContainsImage(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const value = part as Record<string, unknown>;
  return value.type === "input_image"
    || value.type === "image_url"
    || value.type === "image";
}

function contentContainsImage(content: unknown): boolean {
  return Array.isArray(content) && content.some(contentPartContainsImage);
}

export function responsesRequestContainsImages(request: ResponsesRequest): boolean {
  if (!Array.isArray(request.input)) return false;
  for (const item of request.input as any[]) {
    if (!item || typeof item !== "object") continue;
    if (contentContainsImage(item.content)) return true;
    if (contentContainsImage(item.output)) return true;
    if (contentPartContainsImage(item)) return true;
  }
  return false;
}

export function chatRequestContainsImages(request: ChatRequest): boolean {
  if (!Array.isArray(request.messages)) return false;
  for (const message of request.messages as any[]) {
    if (contentContainsImage(message?.content)) return true;
  }
  return false;
}
