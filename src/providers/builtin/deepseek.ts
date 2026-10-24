import type { Provider, ModelInfo, PreprocessCtx } from "../types.js";
import { reqToChat } from "../../translate/reqToChat.js";
import type { ChatRequest, ResponsesRequest } from "../../translate/types.js";

const DEEPSEEK_CONTEXT = 1_000_000;

const BUILTIN_MODELS: ModelInfo[] = [
  { id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", supportsReasoning: true, contextWindow: 1000000 },
  { id: "deepseek-v4-pro-0813", displayName: "DeepSeek V4 Pro 0813", supportsReasoning: true, contextWindow: 1000000, note: "Stable snapshot of V4 Pro" },
  { id: "deepseek-flash", displayName: "DeepSeek Flash", supportsImages: true, supportsReasoning: true, contextWindow: 1000000, note: "V4.1-Flash, supports vision" }
];

// Claude Code speaks Anthropic Messages; DeepSeek serves that same shape at
// <root>/anthropic (https://api-docs.deepseek.com/guides/anthropic_api). The base URL
// stored for this provider is the OpenAI-format root, so derive the Anthropic one from
// it; DEEPSEEK_ANTHROPIC_BASE_URL overrides if DeepSeek ever moves the path.
const DEEPSEEK_ANTHROPIC_SUFFIX = "/anthropic";

export function deepseekAnthropicBaseUrl(_apiKey: string, baseUrl: string): string {
  const override = (process.env.DEEPSEEK_ANTHROPIC_BASE_URL ?? "").trim();
  if (override) return override.replace(/\/+$/, "");
  const trimmed = (baseUrl || "").trim().replace(/\/+$/, "");
  if (/\/anthropic$/i.test(trimmed)) return trimmed;
  const root = trimmed.replace(/\/v1$/i, "").replace(/\/+$/, "") || "https://api.deepseek.com";
  return root + DEEPSEEK_ANTHROPIC_SUFFIX;
}


function normalizeDeepseekBody(chat: ChatRequest): void {
  if (chat.thinking === undefined) {
    chat.thinking = { type: "enabled" };
  }
  if (chat.thinking?.type === "disabled") {
    if (chat.reasoning_effort === "none") delete chat.reasoning_effort;
  } else if (chat.reasoning_effort === undefined) {
    chat.reasoning_effort = "high";
  }
  if (chat.thinking?.type === "enabled") {
    delete chat.temperature;
    delete chat.top_p;
  }
}

function isLegacyR1Model(model: string): boolean {
  return model === "deepseek-reasoner";
}

function stripReasoningContent(chat: ChatRequest): void {
  for (let i = 0; i < chat.messages.length; i++) {
    const m = chat.messages[i];
    if (m.role === "assistant" && m.reasoning_content !== undefined) {
      const { reasoning_content: _, ...rest } = m as any;
      chat.messages[i] = rest;
    }
  }
}

export const deepseek: Provider = {
  id: "deepseek",
  shortcut: "ds",
  displayName: "DeepSeek",
  defaultBaseUrl: "https://api.deepseek.com",
  baseUrlEnv: "DEEPSEEK_BASE_URL",
  envKeys: ["DS_API_KEY", "DEEPSEEK_API_KEY"],
  defaultModel: "deepseek-v4-pro",
  builtinModels: BUILTIN_MODELS,
  docsUrl: "https://platform.deepseek.com/api_keys",

  detectFlags() { return {}; },
  inferBaseUrlFromKey() { return null; },
  resolveModel(clientModel) {
    for (const m of BUILTIN_MODELS) {
      if (m.id === clientModel) return m;
      if (m.aliases?.includes(clientModel)) return m;
    }
    return null;
  },
  preprocessResponses(req, ctx) {
    const chat = reqToChat(req, {
      forceParallelToolCalls: false,
      enableWebSearch: false,
      imageDropDir: ctx.dataDir,
      supportsImages: ctx.supportsImages,
      disableThinking: ctx.disableThinking,
      forceHighEffort: ctx.forceHighEffort,
      upstreamModel: ctx.upstreamModel,
    });
    delete (chat as any).enable_thinking;
    normalizeDeepseekBody(chat);
    if (isLegacyR1Model(chat.model)) stripReasoningContent(chat);
    return chat;
  },
  preprocessChat(req, ctx) {
    const out = { ...req };
    delete (out as any).enable_thinking;
    if (ctx.disableThinking) {
      out.thinking = { type: "disabled" };
      if (out.reasoning_effort === "none") delete out.reasoning_effort;
    }
    normalizeDeepseekBody(out);
    if (isLegacyR1Model(out.model)) {
      out.messages = out.messages.map((m) => {
        if (m.reasoning_content !== undefined) {
          const { reasoning_content: _, ...rest } = m as any;
          return rest;
        }
        return m;
      });
    }
    return out;
  },
  supportsAnthropic: true,
  // deepseek-* ids are served by DeepSeek itself. Prefixes only decide routing: the model
  // id the client asked for is forwarded unchanged, and an id this credential cannot buy
  // fails upstream instead of being quietly swapped for one that can.
  anthropicModelPrefixes: ["deepseek"],
  resolveAnthropicBaseUrl: deepseekAnthropicBaseUrl,
  isTerminalError({ status, snippet }) {
    // 401 (key rejected) and 402 (insufficient balance) do not improve on retry, so stop
    // here instead of burning the client's retry budget.
    if (status === 401 || status === 402) return true;
    if (status !== 400) return false;
    return /model not exist|unsupported model|invalid model/i.test(snippet ?? "");
  },
  enhanceError({ status, snippet }) {
    const text = snippet || "";
    if (status === 402 || /insufficient balance/i.test(text)) {
      return { code: "insufficient_balance", message: "DeepSeek 账户余额不足，请求未被重试。请到 platform.deepseek.com 充值，或改回其他上游。" };
    }
    if (status === 401) {
      return { code: "invalid_api_key", message: "DeepSeek 拒绝了这把 API Key（401）。更新 /etc/anyway2codex/env 里的 DEEPSEEK_API_KEY 后重启 anyway2codex。" };
    }
    if (status === 400 && /model not exist|unsupported model|invalid model/i.test(text)) {
      return { code: "model_not_found", message: "DeepSeek 侧不存在该模型 ID。可用：deepseek-flash、deepseek-v4-pro。" };
    }
    return null;
  },
};
