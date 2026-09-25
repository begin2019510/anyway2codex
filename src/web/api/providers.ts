import { PROVIDERS } from "../../providers/registry.js";

export function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id, shortcut: p.shortcut, displayName: p.displayName, defaultModel: p.defaultModel,
    models: p.builtinModels.filter((m) => !m.deprecatedAfter).map((m) => ({
      id: m.id, displayName: m.displayName, supportsImages: m.supportsImages,
      supportsReasoning: m.supportsReasoning, contextWindow: m.contextWindow,
    })),
  }));
}
