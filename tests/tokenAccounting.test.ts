import { describe, expect, it } from "vitest";
import { deriveConversationKey } from "../src/util/conversationKey.js";
import {
  estimateChatRequest,
  estimateResponsesRequest,
  estimateResponsesOutput,
  normalizeUsage,
} from "../src/util/tokenEstimate.js";
import { ResponsesStreamTelemetry } from "../src/upstream/responsesStreamTelemetry.js";
import { redactSecrets } from "../src/db/logs.js";

describe("token accounting", () => {
  it("redacts API keys without breaking JSON request bodies", () => {
    const body = JSON.stringify({
      instructions: 'writeAuthJson({ OPENAI_API_KEY: "anyway2codex-local" });',
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    const redacted = redactSecrets(body);
    expect(() => JSON.parse(redacted || "")).not.toThrow();
    expect(redacted).toContain("***");
  });

  it("estimates request instructions, text, tool output and images", () => {
    const request = {
      instructions: "system prompt",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "你好世界" }] },
        { type: "function_call_output", call_id: "call_1", output: "tool result" },
        { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,xxx" }] },
      ],
    } as any;
    expect(estimateResponsesRequest(request)).toBeGreaterThan(1024);
  });

  it("includes tool definitions in local estimates", () => {
    const request = {
      instructions: "system prompt",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [{
        type: "function",
        name: "exec",
        description: "Run a shell command",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      }],
      tool_choice: "auto",
    } as any;
    const withoutTools = { ...request, tools: undefined, tool_choice: undefined };
    expect(estimateResponsesRequest(request)).toBeGreaterThan(estimateResponsesRequest(withoutTools));
    expect(estimateChatRequest({
      messages: [{ role: "user", content: "hi" }],
      tools: request.tools,
      tool_choice: request.tool_choice,
    } as any)).toBeGreaterThan(estimateChatRequest({
      messages: [{ role: "user", content: "hi" }],
    } as any));
  });

  it("estimates reasoning and function-call output", () => {
    const estimate = estimateResponsesOutput([
      { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] },
      { type: "function_call", name: "exec", arguments: '{"command":"ls"}' },
    ]);
    expect(estimate).toBeGreaterThan(0);
  });

  it("normalizes Responses and Chat usage fields", () => {
    expect(normalizeUsage({
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens_details: { reasoning_tokens: 10 },
    })).toEqual({
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      cached_tokens: 40,
      reasoning_tokens: 10,
    });
    expect(normalizeUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 3 },
    })).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      cached_tokens: 2,
      reasoning_tokens: 3,
    });
  });
});

describe("conversation grouping", () => {
  it("prefers Codex thread metadata", () => {
    const body = {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      client_metadata: { thread_id: "thread-123" },
    };
    expect(deriveConversationKey(JSON.stringify(body))).toBe("thread-123");
  });

  it("uses a stable derived key when metadata is absent", () => {
    const first = {
      instructions: "same instructions",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "第一轮" }] }],
    };
    const second = {
      instructions: "same instructions",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "第一轮" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "第二轮" }] },
      ],
    };
    expect(deriveConversationKey(first)).toBe(deriveConversationKey(second));
  });
});

describe("Responses stream telemetry", () => {
  it("captures usage and output without changing the stream", () => {
    const telemetry = new ResponsesStreamTelemetry();
    const completed = {
      type: "response.completed",
      response: {
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          total_tokens: 125,
          input_tokens_details: { cached_tokens: 20 },
          output_tokens_details: { reasoning_tokens: 6 },
        },
      },
    };
    telemetry.feed("event: response.completed\ndata: " + JSON.stringify(completed) + "\n\n");
    expect(telemetry.result()).toEqual({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 25,
        total_tokens: 125,
        cached_tokens: 20,
        reasoning_tokens: 6,
      },
      estimated_completion_tokens: 1,
    });
  });
});
