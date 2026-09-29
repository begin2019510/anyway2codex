import { getSetting, setSetting } from "./db/settings.js";

export interface VisionFallbackDefaults {
  enabled?: boolean;
  providerId?: string;
  model?: string;
}

export interface VisionFallbackSettings {
  enabled: boolean;
  providerId: string;
  model: string;
}

export function resolveVisionFallbackSettings(defaults: VisionFallbackDefaults): VisionFallbackSettings {
  const storedEnabled = getSetting("vision_fallback_enabled");
  const storedProvider = getSetting("vision_fallback_provider");
  const storedModel = getSetting("vision_fallback_model");
  return {
    enabled: storedEnabled === null
      ? defaults.enabled !== false
      : storedEnabled === "1",
    providerId: storedProvider || defaults.providerId || "mimo",
    model: storedModel || defaults.model || "mimo-v2.6-flash",
  };
}

export function saveVisionFallbackSettings(settings: VisionFallbackSettings): VisionFallbackSettings {
  setSetting("vision_fallback_enabled", settings.enabled ? "1" : "0");
  setSetting("vision_fallback_provider", settings.providerId);
  setSetting("vision_fallback_model", settings.model);
  return settings;
}
