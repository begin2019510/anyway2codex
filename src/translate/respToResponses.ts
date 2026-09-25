// @ts-nocheck
import { newFunctionCallId, newMessageId, newReasoningId, newResponseId } from "../util/ids.js";
import type { ChatCompletionResponse, ResponsesRequest } from "./types.js";
import { log } from "../util/log.js";

// Salvage malformed tool call arguments
function salvageToolCallArguments(raw: string | undefined, ctx: { name?: string; finishReason?: string }): string {
  if (!raw || raw.length === 0) return raw ?? "";
  try { JSON.parse(raw); return raw; } catch {
    const reason = ctx.finishReason === "length"
      ? "response truncated by length limit"
      : "upstream returned malformed JSON in arguments";
    log.warn("tool_call arguments not valid JSON; salvaged to {}; name=" + (ctx.name ?? "?") + " cause: " + reason);
    return "{}";
  }
}

function mapUsage(u: ChatCompletionResponse["usage"]): Record<string, unknown> | null {
  if (!u) return null;
  const out: Record<string, unknown> = {
    input_tokens: u.prompt_tokens,
    output_tokens: u.completion_tokens,
    total_tokens: u.total_tokens,
  };
  if (u.prompt_tokens_details?.cached_tokens !== undefined) {
    out.input_tokens_details = { cached_tokens: u.prompt_tokens_details.cached_tokens };
  }
  if (u.completion_tokens_details?.reasoning_tokens !== undefined) {
    out.output_tokens_details = { reasoning_tokens: u.completion_tokens_details.reasoning_tokens };
  }
  return out;
}

// Non-streaming: convert full Chat Completions response to Responses API format
export function respToResponses(chat: ChatCompletionResponse, req: ResponsesRequest, opts: {
  exposeReasoning?: boolean;
  namespaceMap?: Map<string, string>;
} = {}): Record<string, unknown> {
  const choice = chat.choices[0];
  const message = choice?.message;
  const output: unknown[] = [];

  // Reasoning
  if (message?.reasoning_content) {
    output.push({
      type: "reasoning",
      id: newReasoningId(),
      summary: opts.exposeReasoning
        ? [{ type: "summary_text", text: message.reasoning_content }]
        : [],
      encrypted_content: message.reasoning_content,
      status: "completed",
    });
  }

  // Content
  if (message?.content) {
    output.push({
      type: "message",
      id: newMessageId(),
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: message.content, annotations: [] }],
    });
  }

  // Tool calls
  const finishReason = choice?.finish_reason ?? "stop";
  if (message?.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      const item: Record<string, unknown> = {
        type: "function_call",
        id: newFunctionCallId(),
        call_id: tc.id,
        name: tc.function.name,
        arguments: salvageToolCallArguments(tc.function.arguments, {
          name: tc.function.name,
          finishReason,
        }),
        status: "completed",
      };
      const ns = opts.namespaceMap?.get(tc.function.name);
      if (ns) item.namespace = ns;
      output.push(item);
    }
  }

  const incomplete = finishReason === "length" ? { reason: "max_output_tokens" } : null;

  return {
    id: newResponseId(),
    object: "response",
    created_at: chat.created,
    status: incomplete ? "incomplete" : "completed",
    model: chat.model,
    output,
    usage: mapUsage(chat.usage),
    parallel_tool_calls: req.parallel_tool_calls ?? true,
    tool_choice: req.tool_choice ?? "auto",
    reasoning: { effort: req.reasoning?.effort ?? null, summary: req.reasoning?.summary ?? null },
    text: req.text?.format ? { format: req.text.format } : { format: { type: "text" } },
    incomplete_details: incomplete,
    error: null,
    metadata: req.metadata ?? null,
    previous_response_id: req.previous_response_id ?? null,
    instructions: req.instructions ?? null,
    temperature: req.temperature ?? null,
    top_p: req.top_p ?? null,
    max_output_tokens: req.max_output_tokens ?? null,
    tools: req.tools ?? [],
    truncation: "disabled",
  };
}
