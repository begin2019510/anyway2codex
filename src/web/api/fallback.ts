import { PROVIDERS } from "../../providers/registry.js";
import { resolveFallbackSettings, saveFallbackSettings } from "../../fallbackSettings.js";
import type { AppConfig } from "../../config.js";

export function getFallbackSettings(cfg: AppConfig) {
  return {
    settings: resolveFallbackSettings({
      enabled: cfg.fallbackEnabled,
      providerId: cfg.fallbackProviderId,
      model: cfg.fallbackModel,
    }),
    providers: Object.values(PROVIDERS).map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      defaultModel: provider.defaultModel,
      models: provider.builtinModels
        .filter((model) => !model.deprecatedAfter)
        .map((model) => ({
          id: model.id,
          displayName: model.displayName || model.id,
          supportsImages: model.supportsImages,
        })),
    })),
  };
}

export function handleFallbackSettings(body: any, cfg: AppConfig) {
  const provider = PROVIDERS[String(body?.providerId || "")];
  if (!provider) return { success: false, message: "Unknown fallback provider" };
  const modelId = String(body?.modelId || provider.defaultModel);
  const model = provider.resolveModel(modelId);
  if (!model) return { success: false, message: "Unknown fallback model: " + modelId };

  const saved = saveFallbackSettings({
    enabled: body?.enabled !== false,
    providerId: provider.id,
    model: model.id,
  });
  return { success: true, settings: saved };
}
