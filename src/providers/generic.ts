import type { Provider, ModelInfo, PreprocessCtx } from "./types.js";
import { reqToChat } from "../translate/reqToChat.js";
import type { ChatRequest, ResponsesRequest } from "../translate/types.js";
import { log } from "../util/log.js";

export interface GenericProviderSpec {
  id: string;
  shortcut?: string;
  displayName?: string;
  baseUrl: string;
  envKey: string;
  defaultModel: string;
  models?: ModelInfo[];
}

export function createGenericProvider(spec: GenericProviderSpec): Provider {
  const declaredModels = spec.models ?? [];
  const hasDeclaredModels = declaredModels.length > 0;

  return {
    id: spec.id,
    shortcut: spec.shortcut ?? spec.id,
    displayName: spec.displayName ?? spec.id,
    defaultBaseUrl: spec.baseUrl,
    baseUrlEnv: spec.envKey.replace(/_API_KEY$/i, "") + "_BASE_URL",
    envKeys: [spec.envKey],
    defaultModel: spec.defaultModel,
    builtinModels: declaredModels,

    detectFlags() { return {}; },
    inferBaseUrlFromKey() { return null; },
    resolveModel(clientModel) {
      if (!hasDeclaredModels) return { id: clientModel };
      for (const m of declaredModels) {
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
        disableThinking: ctx.disableThinking,
        forceHighEffort: ctx.forceHighEffort,
        upstreamModel: ctx.upstreamModel,
      });
      // Strip MiMo/DeepSeek-specific fields
      delete chat.thinking;
      delete (chat as any).enable_thinking;
      if (ctx.disableThinking) chat.reasoning_effort = "none";
      return chat;
    },
    preprocessChat(req, ctx) {
      const out = { ...req };
      delete (out as any).thinking;
      delete (out as any).enable_thinking;
      if (ctx.disableThinking) out.reasoning_effort = "none";
      return out;
    },
    enhanceError() { return null; },
  };
}
