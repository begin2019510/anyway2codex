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
  const isGlm53 = chat.model === "glm-5.3" || chat.model === "glm-5.3-flash";
  // GLM: thinking type. GLM-5.3/5.3-flash cannot be disabled.
  if (chat.thinking?.type === "disabled" && !isGlm53) {
    chat.thinking = { type: "disabled" };
  } else {
    chat.thinking = { type: "enabled" };
  }
  // GLM: map reasoning_effort to model supported values.
  const eff = chat.reasoning_effort;
  if (isGlm53) {
    // GLM-5.3: only max/high/low accepted
    if (eff === "minimal") chat.reasoning_effort = "low";
    else if (eff === "medium") chat.reasoning_effort = "high";
    else if (eff === "xhigh" || eff === "max") chat.reasoning_effort = "max";
    else if (eff === "none") chat.reasoning_effort = "low";
    else if (eff === "low" || eff === "high") { /* keep */ }
    else delete chat.reasoning_effort;
  } else {
    // GLM-5.2 and below: supports none/minimal/low/medium/high/xhigh/max
    if (eff === "minimal") chat.reasoning_effort = "low";
    else if (eff === "xhigh" || eff === "max") chat.reasoning_effort = "max";
    else if (!eff || !["low","medium","high","none"].includes(eff)) delete chat.reasoning_effort;
  }
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
