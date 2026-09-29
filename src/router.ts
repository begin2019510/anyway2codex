import type { Provider } from "./providers/types.js";
import { PROVIDERS, byClientModel } from "./providers/registry.js";
import type { ResponsesRequest, ChatRequest } from "./translate/types.js";
import type { RoutingSettings } from "./routingSettings.js";

export interface RouteResult {
  provider: Provider;
  upstreamModel: string;
  apiKey: string;
  baseUrl: string;
}

export interface RouteCandidate extends RouteResult {
  fallback: boolean;
  visionFallback?: boolean;
}

function makeRoute(provider: Provider, model: string, providers: Record<string, { baseUrl: string; apiKey: string }>): RouteResult | null {
  const runtime = providers[provider.id];
  if (!runtime) return null;
  const resolved = provider.resolveModel(model);
  return {
    provider,
    upstreamModel: resolved?.id ?? provider.defaultModel,
    apiKey: runtime.apiKey,
    baseUrl: runtime.baseUrl,
  };
}

export function selectProvider(
  req: ResponsesRequest | ChatRequest,
  providers: Record<string, { baseUrl: string; apiKey: string }>,
  defaultProviderId: string,
): RouteResult | null {
  const model = req.model;
  const provider = byClientModel(model);
  if (provider) {
    const route = makeRoute(provider, model, providers);
    if (route) return route;
  }
  const defaultProvider = PROVIDERS[defaultProviderId];
  if (defaultProvider) {
    const route = makeRoute(defaultProvider, model, providers);
    if (route) return route;
  }
  return null;
}

function isUsableFallbackKey(apiKey: string): boolean {
  return !!apiKey && !/(?:placeholder|changeme|your[_-]?key)/i.test(apiKey);
}

export function selectProviderCandidates(
  req: ResponsesRequest | ChatRequest,
  providers: Record<string, { baseUrl: string; apiKey: string }>,
  defaultProviderId: string,
  fallbackProviderId?: string,
  fallbackModel?: string,
  routing?: RoutingSettings,
): RouteCandidate[] {
  let primary: RouteResult | null;
  if (routing?.proxyControlsModel) {
    const provider = PROVIDERS[routing.primaryProviderId];
    primary = provider
      ? makeRoute(provider, routing.primaryModel, providers)
      : null;
  } else {
    primary = selectProvider(req, providers, defaultProviderId);
  }
  const candidates: RouteCandidate[] = primary ? [{ ...primary, fallback: false }] : [];
  if (!fallbackProviderId) return candidates;

  const fallbackProvider = PROVIDERS[fallbackProviderId];
  const runtime = fallbackProvider && providers[fallbackProvider.id];
  if (!fallbackProvider || !runtime || !isUsableFallbackKey(runtime.apiKey)) return candidates;

  const requestedModel = fallbackModel || fallbackProvider.defaultModel;
  const route = makeRoute(fallbackProvider, requestedModel, providers);
  if (!route) return candidates;
  const duplicate = candidates.some((candidate) =>
    candidate.provider.id === route.provider.id &&
    candidate.upstreamModel === route.upstreamModel
  );
  if (!duplicate) candidates.push({ ...route, fallback: true });
  return candidates;
}

function supportsImages(route: RouteResult): boolean {
  return route.provider.resolveModel(route.upstreamModel)?.supportsImages === true;
}

export function applyVisionFallback(
  routes: RouteCandidate[],
  providers: Record<string, { baseUrl: string; apiKey: string }>,
  vision: { enabled: boolean; providerId: string; model: string },
  requestContainsImages: boolean,
): RouteCandidate[] {
  const primary = routes[0];
  if (!primary || !vision.enabled || !requestContainsImages || supportsImages(primary)) {
    return routes;
  }

  const provider = PROVIDERS[vision.providerId];
  if (!provider || !providers[provider.id]) return routes;

  const resolved = provider.resolveModel(vision.model);
  if (!resolved || resolved.supportsImages !== true) return routes;

  const route = makeRoute(provider, resolved.id, providers);
  if (!route || !supportsImages(route) || !isUsableFallbackKey(route.apiKey)) return routes;

  const imageRoute: RouteCandidate = { ...route, fallback: false, visionFallback: true };
  const remaining = routes.slice(1).filter((candidate) =>
    candidate.provider.id !== route.provider.id ||
    candidate.upstreamModel !== route.upstreamModel
  );
  return [imageRoute, ...remaining];
}
