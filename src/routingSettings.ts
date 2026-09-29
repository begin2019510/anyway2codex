import { getSetting, setSetting } from "./db/settings.js";
import { PROVIDERS } from "./providers/registry.js";

export const PROXY_MODEL_PLACEHOLDER = "anyway2codex-auto";
export const PROXY_PROVIDER_KEY = "anyway2codex-proxy";

export interface RoutingDefaults {
  enabled?: boolean;
  providerId?: string;
  model?: string;
}

export interface RoutingSettings {
  proxyControlsModel: boolean;
  primaryProviderId: string;
  primaryModel: string;
}

export function resolveRoutingSettings(defaults: RoutingDefaults): RoutingSettings {
  const storedEnabled = getSetting("proxy_controls_model");
  const storedProvider = getSetting("primary_provider");
  const storedModel = getSetting("primary_model");
  const primaryProviderId = storedProvider || defaults.providerId || "mimo";
  const primaryModel = storedModel
    || defaults.model
    || PROVIDERS[primaryProviderId]?.defaultModel
    || "mimo-v2.6-pro";
  return {
    proxyControlsModel: storedEnabled === null
      ? defaults.enabled === true
      : storedEnabled === "1",
    primaryProviderId,
    primaryModel,
  };
}

export function saveRoutingSettings(settings: RoutingSettings): RoutingSettings {
  setSetting("proxy_controls_model", settings.proxyControlsModel ? "1" : "0");
  setSetting("primary_provider", settings.primaryProviderId);
  setSetting("primary_model", settings.primaryModel);
  return settings;
}
