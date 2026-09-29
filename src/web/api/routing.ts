import { PROVIDERS } from "../../providers/registry.js";
import { resolveRoutingSettings, saveRoutingSettings } from "../../routingSettings.js";
import { resolveFallbackSettings } from "../../fallbackSettings.js";
import { getOAuthStatus } from "../../codex/modeSwitch.js";
import type { AppConfig } from "../../config.js";

export function getRoutingSettings(cfg: AppConfig) {
  const settings = resolveRoutingSettings({
    enabled: cfg.proxyControlsModel,
    providerId: cfg.primaryProviderId,
    model: cfg.primaryModel,
  });
  const fallback = resolveFallbackSettings({
    enabled: cfg.fallbackEnabled,
    providerId: cfg.fallbackProviderId,
    model: cfg.fallbackModel,
  });
  return {
    settings,
    fallback,
    oauth: getOAuthStatus(),
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

export function handleRoutingSettings(body: any, cfg: AppConfig) {
  const providerId = String(body?.primaryProviderId || "");
  const provider = PROVIDERS[providerId];
  if (!provider) return { success: false, message: "Unknown primary provider: " + providerId };
  const modelId = String(body?.primaryModel || provider.defaultModel);
  const model = provider.resolveModel(modelId);
  if (!model) return { success: false, message: "Unknown primary model: " + modelId };

  const settings = saveRoutingSettings({
    proxyControlsModel: body?.proxyControlsModel === true,
    primaryProviderId: provider.id,
    primaryModel: model.id,
  });
  return { success: true, settings, oauth: getOAuthStatus() };
}
