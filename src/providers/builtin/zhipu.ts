import type { Provider, ModelInfo, PreprocessCtx } from "../types.js";
import { reqToChat } from "../../translate/reqToChat.js";
import type { ChatRequest, ResponsesRequest } from "../../translate/types.js";

const GLM_CONTEXT = 1_000_000;

const BUILTIN_MODELS: ModelInfo[] = [
  { id: "glm-5.3", displayName: "GLM-5.3", supportsReasoning: true, contextWindow: 1000000, note: "Flagship model" },
  { id: "glm-5.2", displayName: "GLM-5.2", supportsReasoning: true, contextWindow: 1000000 },
  { id: "glm-ocr", displayName: "GLM OCR", supportsImages: true, contextWindow: 1000000, note: "OCR specialized, requires image input" },
  { id: "glm-5.3-flash", displayName: "GLM-5.3 Flash", supportsImages: true, contextWindow: 1000000, note: "VLM, fast vision model" }
];

// GLM: drop tool_choice auto, merge system messages, drop strict null
function normalizeGlmBody(chat: ChatRequest): void {
  if (chat.tool_choice === "auto") delete chat.tool_choice;
  if (Array.isArray(chat.tools)) {
    for (const t of chat.tools) {
      if (t.function?.strict === null) delete t.function.strict;
    }
  }
  const systems = chat.messages.filter((m) => m.role === "system");
  if (systems.length > 1) {
    const merged = systems.map((m) => typeof m.content === "string" ? m.content : "").filter(Boolean).join("\n\n");
    const nonSystem = chat.messages.filter((m) => m.role !== "system");
    chat.messages = [
      ...(merged ? [{ role: "system" as const, content: merged }] : []),
      ...nonSystem,
    ];
  }
}

export const zhipu: Provider = {
  id: "zhipu",
  shortcut: "glm",
  displayName: "Zhipu GLM",
  defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
  baseUrlEnv: "ZHIPU_BASE_URL",
  envKeys: ["ZHIPU_API_KEY"],
  defaultModel: "glm-5.3",
  builtinModels: BUILTIN_MODELS,
  docsUrl: "https://open.bigmodel.cn/dev/howuse/api",

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
    normalizeGlmBody(chat);
    return chat;
  },
  preprocessChat(req, ctx) {
    const out = { ...req };
    normalizeGlmBody(out);
    return out;
  },
  enhanceError() { return null; },
};
