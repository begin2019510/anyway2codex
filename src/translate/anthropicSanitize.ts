import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
} from "./types.js";

// Upstreams that expose an Anthropic-compatible endpoint do not all accept the same
// content block types: Qwen token-plan answers `400 Unexpected item type in content`
// for image/document blocks nested in messages, while MiMo takes them as-is. Anything
// outside the allowlist below becomes a labelled text block, so the turn still
// completes and every drop is reported to the log instead of disappearing quietly.
const TOP_BLOCK_TYPES = new Set(["text", "tool_use", "tool_result", "thinking", "redacted_thinking"]);
const TOOL_RESULT_BLOCK_TYPES = new Set(["text", "image"]);

export interface AnthropicSanitizeResult {
  body: AnthropicMessagesRequest;
  removed: string[];
}

function placeholder(type: string, why: string): AnthropicContentBlock {
  return { type: "text", text: "[anyway2codex: " + type + " block removed - " + why + "]" };
}

function blockText(block: AnthropicContentBlock): string {
  return typeof block.text === "string" ? block.text : "";
}

function textFromContent(content: AnthropicMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => blockText(b)).filter(Boolean).join("\n");
}

function sanitizeToolResultContent(content: unknown, removed: string[]): unknown {
  if (content == null || typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content.map((block: AnthropicContentBlock) => {
    if (TOOL_RESULT_BLOCK_TYPES.has(block.type)) return block;
    removed.push("tool_result/" + block.type);
    return placeholder(block.type, "not accepted by this upstream");
  });
}

function sanitizeMessage(message: AnthropicMessage, removed: string[]): AnthropicMessage {
  if (!Array.isArray(message.content)) return message;
  const content = message.content.map((block) => {
    if (!TOP_BLOCK_TYPES.has(block.type)) {
      removed.push(block.type);
      return placeholder(block.type, "not accepted by this upstream");
    }
    if (block.type === "tool_result") {
      return { ...block, content: sanitizeToolResultContent(block.content, removed) };
    }
    return block;
  });
  return { ...message, content };
}

// Instructions belong in the top-level `system` field, but a client may also emit
// `role: "system"` messages, which these endpoints reject. Such text is folded into
// the top-level field rather than dropped.
function mergeSystemMessages(req: AnthropicMessagesRequest): {
  messages: AnthropicMessage[];
  system: AnthropicMessagesRequest["system"] | undefined;
  hasSystem: boolean;
} {
  const extras = req.messages
    .filter((m) => m.role === "system")
    .map((m) => textFromContent(m.content))
    .filter(Boolean)
    .map((text) => ({ type: "text", text }) as AnthropicContentBlock);
  const messages = req.messages.filter((m) => m.role !== "system");
  if (!extras.length) return { messages, system: req.system, hasSystem: req.system !== undefined };
  if (typeof req.system === "string") {
    return { messages, system: [{ type: "text", text: req.system }, ...extras], hasSystem: true };
  }
  if (Array.isArray(req.system)) {
    return { messages, system: [...req.system, ...extras], hasSystem: true };
  }
  return { messages, system: extras, hasSystem: true };
}

export function sanitizeAnthropicMessages(req: AnthropicMessagesRequest): AnthropicSanitizeResult {
  const removed: string[] = [];
  if (!Array.isArray(req.messages)) return { body: req, removed };
  const merged = mergeSystemMessages(req);
  const body: AnthropicMessagesRequest = {
    ...req,
    messages: merged.messages.map((m) => sanitizeMessage(m, removed)),
  };
  if (merged.hasSystem) body.system = merged.system; else delete body.system;
  return { body, removed };
}

// Logging only: a request carrying images is one where an upstream without vision
// should fail loudly rather than be quietly routed to a model that has it.
export function anthropicRequestContainsImages(req: AnthropicMessagesRequest): boolean {
  if (!Array.isArray(req.messages)) return false;
  return req.messages.some((m) => Array.isArray(m.content)
    && m.content.some((b) => b.type === "image"
      || (b.type === "tool_result" && Array.isArray(b.content)
        && (b.content as AnthropicContentBlock[]).some((c) => c.type === "image"))));
}
