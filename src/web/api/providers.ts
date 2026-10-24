import type { AppConfig } from "../../config.js";
import { PROVIDERS, listProviderModels } from "../../providers/registry.js";
import type { ModelInfo, Provider } from "../../providers/types.js";
import { resolveProviderRuntime } from "../../providerRuntime.js";

export interface ModelChoice {
  id: string;
  displayName: string;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  access?: string[];
  thinkingMode?: string;
  note?: string;
  /** Name to put in Codex config when plain model-name routing must be unambiguous. */
  routeName?: string;
}

export interface ProviderChoice {
  id: string;
  shortcut: string;
  displayName: string;
  defaultModel: string;
  docsUrl?: string;
  baseUrl: string;
  hasKey: boolean;
  /** Billing mode inferred from the credentials actually in use, e.g. token_plan. */
  access: string | null;
  models: ModelChoice[];
}

function toChoice(model: ModelInfo): ModelChoice {
  return {
    id: model.id,
    displayName: model.displayName || model.id,
    supportsImages: model.supportsImages,
    supportsReasoning: model.supportsReasoning,
    contextWindow: model.contextWindow,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    access: model.access,
    thinkingMode: model.thinkingMode,
    note: model.note,
    routeName: model.claim === false ? model.aliases?.find((a) => a.includes("/")) : undefined,
  };
}

export function listProviderChoices(cfg: AppConfig): ProviderChoice[] {
  return Object.entries(PROVIDERS).map(([id, provider]: [string, Provider]) => {
    const runtime = resolveProviderRuntime(cfg, id, provider);
    const access = provider.detectAccess?.({ baseUrl: runtime.baseUrl, apiKey: runtime.apiKey }) ?? null;
    return {
      id,
      shortcut: provider.shortcut,
      displayName: provider.displayName,
      defaultModel: provider.defaultModel,
      docsUrl: provider.docsUrl,
      baseUrl: runtime.baseUrl,
      hasKey: !!runtime.apiKey,
      access,
      models: listProviderModels(provider, runtime).map(toChoice),
    };
  });
}

export function listProviders(cfg: AppConfig): ProviderChoice[] {
  return listProviderChoices(cfg);
}
