import { switchToDomesticMode, switchToOpenAIMode, getCurrentMode, getOAuthStatus } from "../../codex/modeSwitch.js";
import { createBackup } from "../../backup/manager.js";
import { PROVIDERS } from "../../providers/registry.js";
import { resolveRoutingSettings, saveRoutingSettings } from "../../routingSettings.js";
import { resolveFallbackSettings } from "../../fallbackSettings.js";
import { resolveVisionFallbackSettings } from "../../visionFallbackSettings.js";
import type { AppConfig } from "../../config.js";

export function getModeStatus(cfg: AppConfig) {
  const mode = getCurrentMode();
  const routing = resolveRoutingSettings({
    enabled: cfg.proxyControlsModel,
    providerId: cfg.primaryProviderId,
    model: cfg.primaryModel,
  });
  const fallback = resolveFallbackSettings({
    enabled: cfg.fallbackEnabled,
    providerId: cfg.fallbackProviderId,
    model: cfg.fallbackModel,
  });
  const visionFallback = resolveVisionFallbackSettings({
    enabled: cfg.visionFallbackEnabled,
    providerId: cfg.visionFallbackProviderId,
    model: cfg.visionFallbackModel,
  });
  return {
    ...mode,
    codexModel: mode.model,
    proxyControlsModel: routing.proxyControlsModel,
    primary: {
      providerId: routing.primaryProviderId,
      model: routing.primaryModel,
    },
    fallback: {
      enabled: fallback.enabled,
      providerId: fallback.providerId,
      model: fallback.model,
    },
    visionFallback,
    oauth: getOAuthStatus(),
    oauthReady: getOAuthStatus().ready,
  };
}

export function handleModeSwitch(body: any, dataDir: string, cfg: AppConfig) {
  const { action, providerId, modelId } = body;
  createBackup(dataDir, "before_switch_to_" + action);
  if (action === "domestic") {
    const provider = PROVIDERS[providerId];
    if (!provider) return { success: false, message: "Unknown provider: " + providerId };
    const selectedModel = provider.resolveModel(modelId || provider.defaultModel);
    if (!selectedModel) return { success: false, message: "Unknown model: " + modelId };
    const proxyControlsModel = body?.proxyControlsModel === undefined
      ? resolveRoutingSettings({
        enabled: cfg.proxyControlsModel,
        providerId: cfg.primaryProviderId,
        model: cfg.primaryModel,
      }).proxyControlsModel
      : body.proxyControlsModel === true;
    saveRoutingSettings({
      proxyControlsModel,
      primaryProviderId: provider.id,
      primaryModel: selectedModel.id,
    });
    return switchToDomesticMode(
      provider.id,
      selectedModel.id,
      String(process.env.ANYWAY_PORT || 8800),
      provider.displayName,
      proxyControlsModel,
    );
  }
  if (action === "openai") {
    return switchToOpenAIMode(modelId || "gpt-5.6-sol");
  }
  return { success: false, message: "Unknown action: " + action };
}
