// @ts-nocheck
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChatContentPart,
  ChatMessage,
  ChatRequest,
  ResponsesContentPart,
  ResponsesInputItem,
  ResponsesRequest,
} from "./types.js";
import { log } from "../util/log.js";

// Materialize a stripped image to disk so the agent can reference it later.
function materializeStrippedImage(imageUrl: string, dropDir?: string): string | null {
  try {
    if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) return imageUrl;
    if (!imageUrl.startsWith("data:")) return null;
    const m = /^data:([^;,]+)(?:;base64)?,(.*)$/s.exec(imageUrl);
    if (!m) return null;
    const mime = m[1] || "image/png";
    const isBase64 = /;base64,/.test(imageUrl);
    const payload = m[2];
    const bytes = isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf-8");
    const ext = mime.split("/")[1]?.split("+")[0] || "png";
    const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 16);
    const base = dropDir && dropDir.length > 0 ? dropDir : join(tmpdir(), "anyway2codex");
    const dir = join(base, "cache", "images");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const filePath = join(dir, hash + "." + ext);
    if (!existsSync(filePath)) writeFileSync(filePath, bytes);
    return filePath;
  } catch (e) {
    log.warn("failed to materialize stripped image: " + (e as Error).message);
    return null;
  }
}

// Check if a model supports image input
export function modelSupportsImages(model: string): boolean {
  const base = model.toLowerCase();
  if (base.includes("omni")) return true;
  // MiMo v2.5 base supports images; Pro does not
  if (base === "mimo-v2.5") return true;
  // Qwen-VL models support images
  if (base.includes("qwen-vl") || base.includes("qwen2-vl")) return true;
  return false;
}

// Convert Responses content parts to Chat content parts
function partsToChatContent(
  parts: ResponsesContentPart[] | string,
  ctx: { model: string; supportsImages: boolean; imageDropDir?: string }
): string | ChatContentPart[] {
  if (typeof parts === "string") return parts;

  const out: ChatContentPart[] = [];
  const droppedRefs: string[] = [];
  let droppedCount = 0;

  for (const p of parts) {
    if (p.type === "input_text" || p.type === "output_text") {
      const text = typeof p.text === "string" ? p.text : "";
      if (text.length === 0) continue;
      out.push({ type: "text", text });
    } else if (p.type === "input_image") {
      if (ctx.supportsImages) {
        out.push({ type: "image_url", image_url: { url: p.image_url, detail: p.detail } });
      } else {
        droppedCount++;
        const ref = materializeStrippedImage(p.image_url, ctx.imageDropDir);
        if (ref) droppedRefs.push(ref);
      }
    } else if (p.type === "input_file") {
      log.warn("dropped input_file part - upstream may not accept file inputs");
    }
  }

  if (droppedCount > 0) {
    log.warn("dropped " + droppedCount + " image part(s) for model " + ctx.model);
    const refList = droppedRefs.length > 0
      ? droppedRefs.map((r, i) => "  " + (i + 1) + ". " + r).join("\n")
      : "  (could not materialize image)";
    out.push({
      type: "text",
      text: "[" + droppedCount + " image attachment(s) omitted - model does not support images.\n"
        + "Materialized to disk:\n" + refList + "]",
    });
  }

  if (out.length === 0) return "";
  if (out.length === 1 && out[0].type === "text") return out[0].text;
  return out;
}

// Convert Responses input items to Chat messages
// Convert Responses input items to Chat messages
function inputToMessages(
  input: ResponsesInputItem[],
  ctx: { model: string; supportsImages: boolean; imageDropDir?: string }
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const item of input) {
    if (item.type === "message") {
      const content = partsToChatContent(item.content, ctx);
      messages.push({ role: item.role as ChatMessage["role"], content: content || undefined });
    } else if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
      });
    } else if ((item as any).type === "function_call") {
      const fc = item as any;
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: fc.call_id, type: "function", function: { name: fc.name, arguments: fc.arguments || "" } }],
      } as any);
    } else if ((item as any).type === "reasoning") {
      const r = item as any;
      let text = "";
      if (typeof r.encrypted_content === "string" && r.encrypted_content.length > 0) {
        text = r.encrypted_content;
      } else if (Array.isArray(r.summary)) {
        text = r.summary.filter((s: any) => s.type === "summary_text").map((s: any) => s.text).join("");
      }
      if (text) {
        const lastAsst = [...messages].reverse().find(m => m.role === "assistant");
        if (lastAsst) {
          (lastAsst as any).reasoning_content = text;
        } else {
          messages.push({ role: "assistant", content: null, reasoning_content: text } as any);
        }
      }
    }
  }

  return messages;
}



// Convert Responses tools to Chat tools
function toolsToChat(tools: ResponsesRequest["tools"]): ChatRequest["tools"] {
  if (!tools || tools.length === 0) return undefined;
  return tools
    .filter((t) => t.type === "function")
    .map((t) => ({
      type: "function" as const,
      function: {
        name: (t as any).name,
        description: (t as any).description,
        parameters: (t as any).parameters,
        strict: (t as any).strict,
      },
    }));
}

// Convert Responses tool_choice to Chat tool_choice
function toolChoiceToChat(tc: ResponsesRequest["tool_choice"]): ChatRequest["tool_choice"] {
  if (!tc) return undefined;
  if (typeof tc === "string") return tc;
  if (tc.type === "function" && tc.function?.name) {
    return { type: "function", function: { name: tc.function.name } };
  }
  return undefined;
}

export interface ReqToChatOpts {
  forceParallelToolCalls?: boolean;
  enableWebSearch?: boolean;
  imageDropDir?: string;
  disableThinking?: boolean;
  forceHighEffort?: boolean;
  upstreamModel?: string;
  supportsImages?: boolean;
}

// Placeholder for historical assistant messages that lack reasoning_content
const MIXED_MODE_PLACEHOLDER = "(this turn ran without thinking mode)";

// Main translation: Responses API request -> Chat Completions request
export function reqToChat(req: ResponsesRequest, opts: ReqToChatOpts = {}): ChatRequest {
  const supportsImages = opts.supportsImages ?? modelSupportsImages(req.model);

  // Extract system/developer instructions
  const systemMessages: ChatMessage[] = [];
  if (req.instructions) {
    systemMessages.push({ role: "system", content: req.instructions });
  }

  // Build messages from input
  const inputMessages = inputToMessages(req.input, {
    model: req.model,
    supportsImages,
    imageDropDir: opts.imageDropDir,
  });

  const messages: ChatMessage[] = [...systemMessages, ...inputMessages];

  // If the model doesn't support web_search tools, drop them
  const chatTools = toolsToChat(req.tools);

  const chat: ChatRequest = {
    model: opts.upstreamModel ?? req.model,
    messages,
    stream: true,
  };

  if (chatTools && chatTools.length > 0) {
    chat.tools = chatTools;
  }

  // tool_choice
  const tc = toolChoiceToChat(req.tool_choice);
  if (tc !== undefined) chat.tool_choice = tc;

  // parallel_tool_calls
  if (opts.forceParallelToolCalls) {
    chat.parallel_tool_calls = true;
  } else if (req.parallel_tool_calls !== undefined) {
    chat.parallel_tool_calls = req.parallel_tool_calls;
  }

  // Temperature / top_p / max_output_tokens
  if (req.temperature != null) chat.temperature = req.temperature;
  if (req.top_p != null) chat.top_p = req.top_p;
  if (req.max_output_tokens != null) chat.max_completion_tokens = req.max_output_tokens;

  // reasoning.effort -> reasoning_effort
  if (req.reasoning?.effort) {
    const eff = req.reasoning.effort;
    chat.reasoning_effort = eff === "minimal" ? "low" : (eff as any);
  } else if (opts.forceHighEffort && !opts.disableThinking) {
    chat.reasoning_effort = "high";
  }

  // Mixed-mode history defense: backfill reasoning_content on historical assistant messages
  if (opts.disableThinking !== true) {
    let injected = 0;
    for (const m of chat.messages) {
      if (m.role === "assistant" && !m.reasoning_content) {
        m.reasoning_content = MIXED_MODE_PLACEHOLDER;
        injected++;
      }
    }
    if (injected > 0) {
      log.info("backfilled placeholder reasoning_content onto " + injected + " historical assistant message(s)");
    }
  }

  // Global thinking disable
  if (opts.disableThinking) {
    chat.thinking = { type: "disabled" };
  }

  return chat;
}
