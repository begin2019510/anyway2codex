import type { ModelInfo, Provider } from "./types.js";
import { mimo } from "./builtin/mimo.js";
import { deepseek } from "./builtin/deepseek.js";
import { qwen } from "./builtin/qwen.js";
import { zhipu } from "./builtin/zhipu.js";
import { kimi } from "./builtin/kimi.js";

export const BUILTIN_PROVIDERS: Provider[] = [mimo, deepseek, qwen, zhipu, kimi];

const providerListMutable: Provider[] = [...BUILTIN_PROVIDERS];
const providersMapMutable: Record<string, Provider> = Object.fromEntries(
  BUILTIN_PROVIDERS.map((p) => [p.id, p])
);

export const PROVIDER_LIST = providerListMutable;
export const PROVIDERS = providersMapMutable;

export function registerProvider(p: Provider) {
  if (providersMapMutable[p.id]) {
    throw new Error('provider id "' + p.id + '" already registered');
  }
  providerListMutable.push(p);
  providersMapMutable[p.id] = p;
}

export function byShortcut(s: string): Provider | undefined {
  const norm = s.toLowerCase();
  return providerListMutable.find((p) => p.shortcut === norm || p.id === norm);
}

export function byClientModel(model: string): Provider | undefined {
  // Two passes: a provider that natively owns the model id always wins over a
  // gateway that merely hosts a copy of it (claim: false). This keeps
  // glm-5.3 -> Zhipu and deepseek-v4-pro -> DeepSeek even when the Qwen
  // gateway can serve the same id; use the qwen/<id> alias to force Qwen.
  let hosted: Provider | undefined;
  for (const p of providerListMutable) {
    const info = p.resolveModel(model);
    if (!info) continue;
    if (info.claim === false) {
      hosted ??= p;
      continue;
    }
    return p;
  }
  return hosted;
}

export function listProviderModels(
  provider: Provider,
  runtime?: { baseUrl: string; apiKey: string },
): ModelInfo[] {
  const models = provider.listModels && runtime
    ? provider.listModels(runtime)
    : provider.builtinModels;
  return models.filter((model) => !model.deprecatedAfter && model.hidden !== true);
}

export function isProviderId(s: string): boolean {
  return providersMapMutable.hasOwnProperty(s);
}

