import { PROVIDERS } from "../../providers/registry.js";
import { listProviderChoices } from "./providers.js";
import { resolveFallbackSettings, saveFallbackSettings } from "../../fallbackSettings.js";
import type { AppConfig } from "../../config.js";

export function getFallbackSettings(cfg: AppConfig) {
  return {
    settings: resolveFallbackSettings({
      enabled: cfg.fallbackEnabled,
      providerId: cfg.fallbackProviderId,
      model: cfg.fallbackModel,
    }),
    providers: listProviderChoices(cfg),
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
