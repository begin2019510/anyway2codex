import type { Provider, ModelInfo, PreprocessCtx } from "../types.js";
import { reqToChat } from "../../translate/reqToChat.js";
import type { ChatRequest, ResponsesRequest } from "../../translate/types.js";

const DEEPSEEK_CONTEXT = 1_000_000;

const BUILTIN_MODELS: ModelInfo[] = [
  { id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", supportsReasoning: true, contextWindow: 1000000 },
  { id: "deepseek-v4-pro-0813", displayName: "DeepSeek V4 Pro 0813", supportsReasoning: true, contextWindow: 1000000, note: "Stable snapshot of V4 Pro" },
  { id: "deepseek-flash", displayName: "DeepSeek Flash", supportsImages: true, supportsReasoning: true, contextWindow: 1000000, note: "V4.1-Flash, supports vision" }
];

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
  enhanceError() { return null; },
};
