import type { Provider, ModelInfo, PreprocessCtx } from "../types.js";
import { reqToChat } from "../../translate/reqToChat.js";
import type { ChatRequest, ResponsesRequest } from "../../translate/types.js";

const QWEN_CONTEXT = 1_000_000;

const BUILTIN_MODELS: ModelInfo[] = [
  { id: "qwen3.8-max", displayName: "Qwen 3.8 Max", supportsImages: true, supportsReasoning: true, contextWindow: 1000000, maxOutputTokens: 131072 },
  { id: "qwen3.7-plus", displayName: "Qwen 3.7 Plus", supportsImages: true, supportsReasoning: true, contextWindow: 1000000, maxOutputTokens: 131072 },
    { id: "qwen3.8-flash", displayName: "Qwen 3.8 Flash", supportsImages: true, contextWindow: 1000000, maxOutputTokens: 131072 },
  { id: "qwen3.8-omni-flash", displayName: "Qwen 3.8 Omni Flash", supportsImages: true, supportsReasoning: true, contextWindow: 1000000, maxOutputTokens: 131072, note: "Multimodal (vision+audio+video)" },
  { id: "qwen3.5-omni-plus", displayName: "Qwen 3.5 Omni Plus", supportsImages: true, supportsReasoning: true, contextWindow: 1000000, maxOutputTokens: 131072, note: "Multimodal (vision+audio)" }
];

// Qwen-specific: drop null strict, merge system messages, drop non-function tools
function normalizeQwenBody(chat: ChatRequest): void {
  // Drop strict: null from tools
  if (Array.isArray(chat.tools)) {
    for (const t of chat.tools) {
      if (t.function?.strict === null) delete t.function.strict;
    }
  }
  // Drop null content from assistant messages
  for (const m of chat.messages) {
    if (m.role === "assistant" && m.content === null) delete m.content;
  }
  // Merge multiple system messages into one
  const systems = chat.messages.filter((m) => m.role === "system");
  if (systems.length > 1) {
    const merged = systems.map((m) => typeof m.content === "string" ? m.content : "").filter(Boolean).join("\n\n");
    const nonSystem = chat.messages.filter((m) => m.role !== "system");
    chat.messages = [
      ...(merged ? [{ role: "system" as const, content: merged }] : []),
      ...nonSystem,
    ];
  }
  // Drop tool_choice "auto" (it's the default)
  if (chat.tool_choice === "auto") delete chat.tool_choice;
}

export const qwen: Provider = {
  id: "qwen",
  shortcut: "qwen",
  displayName: "Tongyi Qwen (Alibaba)",
  defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  baseUrlEnv: "QWEN_BASE_URL",
  envKeys: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"],
  defaultModel: "qwen3.8-max",
  builtinModels: BUILTIN_MODELS,
  docsUrl: "https://help.aliyun.com/zh/dashscope/",

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
    normalizeQwenBody(chat);
    return chat;
  },
  preprocessChat(req, ctx) {
    const out = { ...req };
    normalizeQwenBody(out);
    return out;
  },
  enhanceError() { return null; },
};
