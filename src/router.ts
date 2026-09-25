import type { Provider, PreprocessCtx } from "./providers/types.js";
import { PROVIDERS, byClientModel } from "./providers/registry.js";
import type { ResponsesRequest, ChatRequest } from "./translate/types.js";
import { log } from "./util/log.js";

export interface RouteResult {
  provider: Provider;
  upstreamModel: string;
  apiKey: string;
  baseUrl: string;
}

export function selectProvider(
  req: ResponsesRequest | ChatRequest,
  providers: Record<string, { baseUrl: string; apiKey: string }>,
  defaultProviderId: string,
): RouteResult | null {
  const model = req.model;
  const provider = byClientModel(model);
  if (provider) {
    const runtime = providers[provider.id];
    if (runtime) {
      const resolved = provider.resolveModel(model);
      return { provider, upstreamModel: resolved?.id ?? provider.defaultModel, apiKey: runtime.apiKey, baseUrl: runtime.baseUrl };
    }
  }
  const defaultProvider = PROVIDERS[defaultProviderId];
  if (defaultProvider) {
    const runtime = providers[defaultProvider.id];
    if (runtime) {
      const resolved = defaultProvider.resolveModel(model);
      return { provider: defaultProvider, upstreamModel: resolved?.id ?? defaultProvider.defaultModel, apiKey: runtime.apiKey, baseUrl: runtime.baseUrl };
    }
  }
  return null;
}
