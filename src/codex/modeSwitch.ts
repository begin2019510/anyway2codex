import { readConfigTomlIfExists, writeConfigToml, writeAuthJson, detectAuthJsonOwner } from "./state.js";
import { mergeCodexProviderToml } from "./tomlMerge.js";
import { buildProviderTomlPatch, tomlProviderKeyFor } from "./snippets.js";
import { log } from "../util/log.js";

export interface SwitchResult {
  success: boolean;
  message: string;
  previousOwner?: string;
}

// Switch Codex to use a domestic model via the proxy
export function switchToDomesticMode(
  providerId: string,
  modelId: string,
  hostPort: string,
  providerLabel: string,
): SwitchResult {
  const previousOwner = detectAuthJsonOwner();
  log.info("switching to domestic mode: provider=" + providerId + " model=" + modelId);

  const providerKey = tomlProviderKeyFor(providerId);
  const patch = buildProviderTomlPatch({
    providerKey,
    providerLabel,
    modelId,
  }, hostPort);

  const existingToml = readConfigTomlIfExists();
  const tomlOut = mergeCodexProviderToml(existingToml, patch);
  writeConfigToml(tomlOut);
  // Do NOT overwrite auth.json - the proxy uses its own API keys from the database.
  // Keeping the original auth.json preserves the OpenAI login for direct mode switching.

  return {
    success: true,
    message: "Switched to " + providerLabel + " (" + modelId + "). Restart Codex to take effect.",
    previousOwner,
  };
}

// Switch Codex to use OpenAI directly (bypass proxy)
export function switchToOpenAIMode(
  openaiKey: string,
  modelId: string = "gpt-5.6-sol",
): SwitchResult {
  const previousOwner = detectAuthJsonOwner();
  log.info("switching to OpenAI direct mode: model=" + modelId);

  const patch = buildProviderTomlPatch({
    providerKey: "openai",
    providerLabel: "OpenAI (Direct)",
    modelId,
  }, "api.openai.com/v1");

  const existingToml = readConfigTomlIfExists();
  // For OpenAI direct, we need to modify the base_url to point to OpenAI
  const tomlOut = mergeCodexProviderToml(existingToml, {
    ...patch,
    providerBlock: [
      "[model_providers.openai]",
      'name = "OpenAI (Direct)"',
      'base_url = "https://api.openai.com/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "request_max_retries = 3",
    ].join("\n"),
  });
  writeConfigToml(tomlOut);
  writeAuthJson({ OPENAI_API_KEY: openaiKey });

  return {
    success: true,
    message: "Switched to OpenAI direct (" + modelId + "). Restart Codex to take effect.",
    previousOwner,
  };
}

// Get current mode status
export function getCurrentMode(): { mode: string; provider?: string; model?: string } {
  const owner = detectAuthJsonOwner();
  if (owner === "anyway2codex") {
    return { mode: "domestic", provider: "proxy" };
  }
  if (owner === "external") {
    return { mode: "openai-direct" };
  }
  return { mode: "unknown" };
}
