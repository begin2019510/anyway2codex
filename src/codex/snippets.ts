export interface SnippetTarget {
  providerKey: string;
  providerLabel: string;
  modelId: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export function tomlProviderKeyFor(providerId: string): string {
  if (providerId === "mimo") return "mimo";
  if (providerId === "deepseek") return "mimo2codex";
  return "anyway2codex-" + providerId;
}

export function buildProviderTomlPatch(target: SnippetTarget, hostPort: string) {
  const block = [
    "[model_providers." + target.providerKey + "]",
    'name = "' + target.providerLabel + '"',
    'base_url = "http://127.0.0.1:' + hostPort + '/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "request_max_retries = 1",
  ].join("\n");
  return {
    model: target.modelId,
    modelProvider: target.providerKey,
    modelContextWindow: target.contextWindow,
    modelMaxOutputTokens: target.maxOutputTokens,
    providerKey: target.providerKey,
    providerBlock: block,
  };
}

export function buildCcSwitchFiles(target: SnippetTarget, hostPort: string) {
  const configToml = [
    'model_provider = "' + target.providerKey + '"',
    'model = "' + target.modelId + '"',
    "",
    "[model_providers." + target.providerKey + "]",
    'name = "' + target.providerLabel + '"',
    'base_url = "http://127.0.0.1:' + hostPort + '/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "request_max_retries = 1",
    "",
  ].join("\n");
  return { configToml };
}
