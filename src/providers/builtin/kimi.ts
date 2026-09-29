import type { Provider, ModelInfo, PreprocessCtx } from "../types.js";
import { reqToChat } from "../../translate/reqToChat.js";
import type { ChatRequest, ResponsesRequest } from "../../translate/types.js";

const KIMI_CONTEXT = 1_000_000;

const BUILTIN_MODELS: ModelInfo[] = [
  { id: "kimi-k3", displayName: "Kimi K3", supportsImages: true, supportsReasoning: true, contextWindow: 1000000, note: "Latest flagship, multimodal" },
  { id: "kimi-k2.7-code", displayName: "Kimi K2.7 Code", supportsImages: true, supportsReasoning: true, contextWindow: 256000, note: "Code-optimized" },
  { id: "kimi-k2.7-code-highspeed", displayName: "Kimi K2.7 Code HighSpeed", supportsImages: true, supportsReasoning: true, contextWindow: 256000, note: "Code-optimized, multimodal" },
  { id: "kimi-k2.6", displayName: "Kimi K2.6", supportsImages: true, supportsReasoning: true, contextWindow: 256000, note: "Multimodal" }
];

// Kimi: K3 uses top-level reasoning_effort (low/high/max, default max).
// K2.6/K2.7 do NOT support reasoning_effort - drop it for those.
function normalizeKimiBody(chat: ChatRequest): void {
  const isK3 = chat.model?.startsWith("kimi-k3");
  if (isK3) {
    const eff = chat.reasoning_effort;
    if (eff === "none" || eff === "minimal") delete chat.reasoning_effort;
    else if (eff === "low") chat.reasoning_effort = "low";
    else if (eff === "medium" || eff === "high") chat.reasoning_effort = "high";
    else if (eff === "max" || eff === "xhigh") chat.reasoning_effort = "max";
  } else {
    delete chat.reasoning_effort;
  }
  if (chat.tool_choice === "auto") delete chat.tool_choice;
}

export const kimi: Provider = {
  id: "kimi",
  shortcut: "kimi",
  displayName: "Kimi (Moonshot)",
  defaultBaseUrl: "https://api.moonshot.cn/v1",
  baseUrlEnv: "KIMI_BASE_URL",
  envKeys: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
  defaultModel: "kimi-k3",
  builtinModels: BUILTIN_MODELS,
  docsUrl: "https://platform.kimi.com/docs",

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
    normalizeKimiBody(chat);
    return chat;
  },
  preprocessChat(req, ctx) {
    const out = { ...req };
    normalizeKimiBody(out);
    return out;
  },
  enhanceError() { return null; },
};
