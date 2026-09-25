import type { Provider } from "./types.js";
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
  for (const p of providerListMutable) {
    if (p.resolveModel(model)) return p;
  }
  return undefined;
}

export function isProviderId(s: string): boolean {
  return providersMapMutable.hasOwnProperty(s);
}

