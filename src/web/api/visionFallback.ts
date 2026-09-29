import { PROVIDERS } from "../../providers/registry.js";
import {
  resolveVisionFallbackSettings,
  saveVisionFallbackSettings,
} from "../../visionFallbackSettings.js";
import type { AppConfig } from "../../config.js";

export function getVisionFallbackSettings(cfg: AppConfig) {
  const settings = resolveVisionFallbackSettings({
    enabled: cfg.visionFallbackEnabled,
    providerId: cfg.visionFallbackProviderId,
    model: cfg.visionFallbackModel,
  });
  return {
    settings,
    providers: Object.values(PROVIDERS)
      .map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        models: provider.builtinModels
          .filter((model) => !model.deprecatedAfter && model.supportsImages === true)
          .map((model) => ({
            id: model.id,
            displayName: model.displayName || model.id,
          })),
      }))
      .filter((provider) => provider.models.length > 0),
  };
}

export function handleVisionFallbackSettings(body: any) {
  const provider = PROVIDERS[String(body?.providerId || "")];
  if (!provider) return { success: false, message: "Unknown vision fallback provider" };
  const modelId = String(body?.modelId || provider.defaultModel);
  const model = provider.resolveModel(modelId);
  if (!model) return { success: false, message: "Unknown vision fallback model: " + modelId };
  if (model.supportsImages !== true) {
    return { success: false, message: "Selected model does not support image input: " + model.id };
  }

  const settings = saveVisionFallbackSettings({
    enabled: body?.enabled !== false,
    providerId: provider.id,
    model: model.id,
  });
  return { success: true, settings };
}
