import {
  readConfigTomlIfExists,
  readAuthJsonIfExists,
  writeConfigToml,
  detectAuthJsonOwner,
} from "./state.js";
import { mergeCodexProviderToml } from "./tomlMerge.js";
import { buildProviderTomlPatch, tomlProviderKeyFor } from "./snippets.js";
import { PROXY_MODEL_PLACEHOLDER, PROXY_PROVIDER_KEY } from "../routingSettings.js";
import { log } from "../util/log.js";

export interface SwitchResult {
  success: boolean;
  message: string;
  previousOwner?: string;
  oauthReady?: boolean;
}

export interface OAuthStatus {
  ready: boolean;
  authMode?: string;
  hasTokens: boolean;
}

export function getOAuthStatus(): OAuthStatus {
  const auth = readAuthJsonIfExists() as any;
  const tokens = auth?.tokens || {};
  const hasTokens = [
    "id_token",
    "access_token",
    "refresh_token",
    "account_id",
  ].every((key) => typeof tokens[key] === "string" && tokens[key].length > 0);
  return {
    ready: auth?.auth_mode === "chatgpt" && hasTokens,
    authMode: typeof auth?.auth_mode === "string" ? auth.auth_mode : undefined,
    hasTokens,
  };
}

export function switchToDomesticMode(
  providerId: string,
  modelId: string,
  hostPort: string,
  providerLabel: string,
  proxyControlsModel = false,
): SwitchResult {
  const previousOwner = detectAuthJsonOwner();
  const effectiveModel = proxyControlsModel ? PROXY_MODEL_PLACEHOLDER : modelId;
  const providerKey = proxyControlsModel ? PROXY_PROVIDER_KEY : tomlProviderKeyFor(providerId);
  log.info(
    "switching to domestic mode: provider=" + providerId
    + " model=" + effectiveModel
    + " proxy_controls_model=" + proxyControlsModel,
  );

  const patch = buildProviderTomlPatch({
    providerKey,
    providerLabel,
    modelId: effectiveModel,
  }, hostPort);

  const existingToml = readConfigTomlIfExists();
  writeConfigToml(mergeCodexProviderToml(existingToml, patch));

  return {
    success: true,
    message: "Switched to " + providerLabel + " (" + effectiveModel + "). Restart Codex to take effect.",
    previousOwner,
  };
}

export function switchToOpenAIMode(
  modelId: string = "gpt-5.6-sol",
): SwitchResult {
  const previousOwner = detectAuthJsonOwner();
  const oauth = getOAuthStatus();
  if (!oauth.ready) {
    return {
      success: false,
      message: "ChatGPT OAuth login is incomplete. Sign in to Codex first; auth.json was not changed.",
      previousOwner,
      oauthReady: false,
    };
  }

  log.info("switching to OpenAI direct mode: model=" + modelId);
  const patch = {
    model: modelId,
    modelProvider: "openai",
    providerKey: "openai",
    providerBlock: "",
  };
  const existingToml = readConfigTomlIfExists();
  const tomlOut = mergeCodexProviderToml(existingToml, patch, {
    removeRootKeys: ["openai_base_url"],
  });
  writeConfigToml(tomlOut);

  return {
    success: true,
    message: "Switched to OpenAI direct (" + modelId + "). Restart Codex to take effect. Existing ChatGPT login was preserved.",
    previousOwner,
    oauthReady: true,
  };
}

export function getCurrentMode(): { mode: string; provider?: string; model?: string } {
  const toml = readConfigTomlIfExists();
  if (!toml) return { mode: "unknown" };

  const rootLines = toml.split(/\r?\n/);
  let model = "";
  let provider = "";
  for (const line of rootLines) {
    if (/^\s*\[/.test(line)) break;
    const modelMatch = /^\s*model\s*=\s*"([^"]+)"/.exec(line);
    const providerMatch = /^\s*model_provider\s*=\s*"([^"]+)"/.exec(line);
    if (modelMatch) model = modelMatch[1];
    if (providerMatch) provider = providerMatch[1];
  }

  if (!provider) return { mode: "unknown", model: model || undefined };
  if (provider === "openai") {
    return { mode: "openai-direct", provider, model: model || undefined };
  }
  return { mode: "domestic", provider, model: model || undefined };
}
