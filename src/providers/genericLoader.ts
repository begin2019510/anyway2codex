import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "./types.js";
import { createGenericProvider, type GenericProviderSpec } from "./generic.js";
import { log } from "../util/log.js";

function loadFromFile(filePath: string): GenericProviderSpec[] {
  try {
    const text = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(text);
    if (!parsed?.providers || !Array.isArray(parsed.providers)) return [];
    return parsed.providers.map((item: any) => ({
      id: item.id,
      shortcut: item.shortcut,
      displayName: item.displayName,
      baseUrl: item.baseUrl || "",
      envKey: item.envKey || "GENERIC_API_KEY",
      defaultModel: item.defaultModel || "",
      models: item.models,
    }));
  } catch (err) {
    log.warn("failed to load providers file: " + (err as Error).message);
    return [];
  }
}

function loadFromEnv(): GenericProviderSpec[] {
  const baseUrl = process.env.GENERIC_BASE_URL;
  const defaultModel = process.env.GENERIC_DEFAULT_MODEL;
  if (!baseUrl || !defaultModel) return [];
  return [{
    id: "generic",
    baseUrl,
    envKey: "GENERIC_API_KEY",
    defaultModel,
  }];
}

export function loadGenericProviders(dataDir?: string): Provider[] {
  let specs: GenericProviderSpec[] = [];

  if (dataDir) {
    const filePath = join(dataDir, "providers.json");
    if (existsSync(filePath)) {
      specs = loadFromFile(filePath);
      log.info("loaded " + specs.length + " generic provider(s) from " + filePath);
    }
  }

  if (specs.length === 0) {
    specs = loadFromEnv();
    if (specs.length > 0) log.info("synthesized 1 generic provider from env vars");
  }

  return specs.map((spec) => createGenericProvider(spec));
}
