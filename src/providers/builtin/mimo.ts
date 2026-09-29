import type { Provider, ModelInfo, PreprocessCtx, EnhancedError } from "../types.js";
import { reqToChat, modelSupportsImages } from "../../translate/reqToChat.js";
import type { ChatRequest, ResponsesRequest } from "../../translate/types.js";

const MIMO_CONTEXT_WINDOW = 1_000_000;

const BUILTIN_MODELS: ModelInfo[] = [
  {
    id: "mimo-v2.6-pro",
    aliases: ["mimo-v2.5-pro", "mimo-v2-pro"],
    displayName: "MiMo V2.6 Pro",
    supportsImages: false,
    supportsReasoning: true,
    supportsWebSearch: true,
    contextWindow: MIMO_CONTEXT_WINDOW,
    maxOutputTokens: 131_072,
  },
  {
    id: "mimo-v2.6-pro-ultraspeed",
    displayName: "MiMo V2.6 Pro UltraSpeed",
    supportsImages: false,
    supportsReasoning: true,
    supportsWebSearch: true,
    contextWindow: MIMO_CONTEXT_WINDOW,
    maxOutputTokens: 131_072,
  },
  {
    id: "mimo-v2.6-flash",
    aliases: ["mimo-v2.5", "mimo-v2-omni", "mimo-v2-flash", "gpt-6-luna", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-sol"],
    displayName: "MiMo V2.6 Flash (Vision)",
    supportsImages: true,
    supportsReasoning: true,
    supportsWebSearch: true,
    contextWindow: MIMO_CONTEXT_WINDOW,
    maxOutputTokens: 131_072,
  },
  {
    id: "mimo-v2.5-pro",
    displayName: "MiMo V2.5 Pro (deprecated)",
    supportsImages: false,
    supportsReasoning: true,
    supportsWebSearch: true,
    contextWindow: MIMO_CONTEXT_WINDOW,
    maxOutputTokens: 131_072,
    deprecatedAfter: "2026-10-01",
    note: "Use mimo-v2.6-pro instead",
  },
  {
    id: "mimo-v2.5",
    displayName: "MiMo V2.5 (deprecated)",
    supportsImages: true,
    supportsReasoning: true,
    supportsWebSearch: true,
    contextWindow: MIMO_CONTEXT_WINDOW,
    maxOutputTokens: 32_768,
    deprecatedAfter: "2026-10-01",
    note: "Use mimo-v2.6 instead",
  },
];

const PAYG_BASE_URL = "https://api.xiaomimimo.com/v1";
const TOKEN_PLAN_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1";
const WEB_SEARCH_DISABLED_MARKER = "webSearchEnabled is false";

function isTokenPlan(apiKey: string, baseUrl: string): boolean {
  return /token-plan/i.test(baseUrl) || apiKey.startsWith("tp-");
}

function webSearchAllowed(ctx: PreprocessCtx): boolean {
  return !!ctx.webSearchEnabled;
}

// MiMo-specific body normalization
function normalizeMimoBody(chat: ChatRequest, model: string): ChatRequest {
  // Responses API accepts reasoning.effort, but the Chat Completions endpoint
  // used by this proxy exposes the equivalent switch as thinking.type.
  // `none` disables thinking; every other effort level enables it. MiMo
  // currently treats all non-none levels as the same enabled mode.
  if (chat.reasoning_effort === "none") {
    chat.thinking = { type: "disabled" };
  } else if (chat.thinking === undefined) {
    chat.thinking = { type: "enabled" };
  }
  delete chat.reasoning_effort;
  // MiMo uses thinking:{type} not enable_thinking
  delete (chat as any).enable_thinking;
  // MiMo only accepts auto/default tool_choice; drop non-auto values.
  if (chat.tool_choice && chat.tool_choice !== "auto") delete chat.tool_choice;
  // Thinking mode: temperature/top_p forced to defaults, so remove them.
  if (chat.thinking?.type === "enabled") {
    delete chat.temperature;
    delete chat.top_p;
  }
  return chat;
}

export const mimo: Provider = {
  id: "mimo",
  shortcut: "mimo",
  displayName: "MiMo (via Xiaomi)",
  defaultBaseUrl: TOKEN_PLAN_BASE_URL,
  baseUrlEnv: "MIMO_BASE_URL",
  envKeys: ["MIMO_API_KEY"],
  defaultModel: "mimo-v2.6-pro",
  builtinModels: BUILTIN_MODELS,
  docsUrl: "https://platform.xiaomimimo.com/#/console/api-keys",

  detectFlags(apiKey, baseUrl) {
    return { isTokenPlan: isTokenPlan(apiKey, baseUrl) };
  },
  inferBaseUrlFromKey(apiKey) {
    if (apiKey.startsWith("tp-")) return TOKEN_PLAN_BASE_URL;
    if (apiKey.startsWith("sk-")) return PAYG_BASE_URL;
    return null;
  },
  resolveModel(clientModel) {
    for (const m of BUILTIN_MODELS) {
      if (m.id === clientModel) return m;
      if (m.aliases?.includes(clientModel)) return m;
    }
    return null;
  },
  preprocessResponses(req, ctx) {
    const chat = reqToChat(req, {
      forceParallelToolCalls: true,
      enableWebSearch: webSearchAllowed(ctx),
      imageDropDir: ctx.dataDir,
      supportsImages: ctx.supportsImages,
      disableThinking: ctx.disableThinking,
      forceHighEffort: ctx.forceHighEffort,
      upstreamModel: ctx.upstreamModel,
    });
    return normalizeMimoBody(chat, ctx.upstreamModel ?? req.model);
  },
  preprocessChat(req, ctx) {
    const out = { ...req };
    if (ctx.disableThinking) {
      out.thinking = { type: "disabled" };
    }
    if (!webSearchAllowed(ctx) && Array.isArray(out.tools)) {
      out.tools = out.tools.filter((t) => (t as any).type !== "web_search") as any;
    }
    return normalizeMimoBody(out, ctx.upstreamModel ?? out.model);
  },
  enhanceError({ status, snippet }) {
    if (status === 400 && snippet?.includes(WEB_SEARCH_DISABLED_MARKER)) {
      return {
        code: "web_search_plugin_not_activated",
        message: "MiMo Web Search Plugin is not activated. Enable at platform.xiaomimimo.com or turn off web search.",
      };
    }
    return null;
  },
};

