import type { AppConfig } from "./config.js";
import type { Provider } from "./providers/types.js";
import { getSetting } from "./db/settings.js";
import { decrypt } from "./util/crypto.js";

const MASTER_KEY = process.env.ANYWAY2CODEX_MASTER_KEY || "default-dev-key-change-in-production";

function getStoredApiKey(providerId: string): string | null {
  const stored = getSetting("key_" + providerId);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored);
    return decrypt(parsed.ciphertext, parsed.iv, parsed.tag, MASTER_KEY);
  } catch {
    return null;
  }
}

export interface StoredProviderCredentials {
  baseUrl: string;
  apiKey: string;
}

export interface ProviderRuntimeCredentials {
  baseUrl: string;
  apiKey: string;
  baseUrlSource: string;
  apiKeySource: string;
}

const OPENAI_METADATA = {
  defaultBaseUrl: "https://api.openai.com/v1",
  baseUrlEnv: "OPENAI_BASE_URL",
  envKeys: ["OPENAI_API_KEY"],
};

function providerMetadata(provider?: Provider) {
  if (provider) return provider;
  return OPENAI_METADATA;
}

export function resolveProviderRuntimeWith(
  cfg: AppConfig,
  providerId: string,
  provider: Provider | undefined,
  stored: StoredProviderCredentials,
): ProviderRuntimeCredentials {
  const metadata = providerMetadata(provider);
  const configured = cfg.providers[providerId];

  let apiKey = stored.apiKey || "";
  let apiKeySource = stored.apiKey ? "panel" : "unset";
  if (!apiKey && configured?.apiKey) {
    apiKey = configured.apiKey;
    apiKeySource = "config";
  }
  if (!apiKey) {
    for (const envKey of metadata.envKeys) {
      const value = process.env[envKey];
      if (value) {
        apiKey = value;
        apiKeySource = "env:" + envKey;
        break;
      }
    }
  }

  let baseUrl = stored.baseUrl || "";
  let baseUrlSource = stored.baseUrl ? "panel" : "unset";
  if (!baseUrl && configured?.baseUrl) {
    baseUrl = configured.baseUrl;
    baseUrlSource = "config";
  }
  if (!baseUrl && process.env[metadata.baseUrlEnv]) {
    baseUrl = process.env[metadata.baseUrlEnv]!;
    baseUrlSource = "env:" + metadata.baseUrlEnv;
  }
  if (!baseUrl && apiKey && provider?.inferBaseUrlFromKey) {
    baseUrl = provider.inferBaseUrlFromKey(apiKey) || "";
    baseUrlSource = baseUrl ? "inferred-from-key" : "unset";
  }
  if (!baseUrl) {
    baseUrl = metadata.defaultBaseUrl;
    baseUrlSource = baseUrl ? "provider-default" : "unset";
  }

  return { baseUrl, apiKey, baseUrlSource, apiKeySource };
}

export function resolveProviderRuntime(cfg: AppConfig, providerId: string, provider?: Provider): ProviderRuntimeCredentials {
  return resolveProviderRuntimeWith(cfg, providerId, provider, {
    baseUrl: getSetting("provider_base_url_" + providerId) || "",
    apiKey: getStoredApiKey(providerId) || "",
  });
}

export function loadProviderRuntimes(
  cfg: AppConfig,
  providers: Record<string, Provider>,
): Record<string, { baseUrl: string; apiKey: string }> {
  const result: Record<string, { baseUrl: string; apiKey: string }> = {};
  for (const providerId of Object.keys(providers)) {
    const provider = providers[providerId];
    const runtime = resolveProviderRuntime(cfg, providerId, provider);
    if (runtime.apiKey) {
      result[providerId] = { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey };
    }
  }
  return result;
}
