import { getSetting, setSetting } from "./db/settings.js";

export interface FallbackDefaults {
  enabled?: boolean;
  providerId?: string;
  model?: string;
}

export interface FallbackSettings {
  enabled: boolean;
  providerId: string;
  model: string;
}

export function resolveFallbackSettings(defaults: FallbackDefaults): FallbackSettings {
  const storedEnabled = getSetting("fallback_enabled");
  const storedProvider = getSetting("fallback_provider");
  const storedModel = getSetting("fallback_model");
  return {
    enabled: storedEnabled === null
      ? defaults.enabled !== false
      : storedEnabled === "1",
    providerId: storedProvider || defaults.providerId || "qwen",
    model: storedModel || defaults.model || "qwen3.8-flash",
  };
}

export function saveFallbackSettings(settings: FallbackSettings): FallbackSettings {
  setSetting("fallback_enabled", settings.enabled ? "1" : "0");
  setSetting("fallback_provider", settings.providerId);
  setSetting("fallback_model", settings.model);
  return settings;
}
