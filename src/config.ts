export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  verbose: boolean;
  defaultProviderId: string;
  providers: Record<string, { baseUrl: string; apiKey: string }>;
  disableThinking?: boolean;
  webSearch?: boolean;
  autoCompact?: boolean;
  autoCompactThreshold?: number;
  autoCompactAtTokens?: number;
  fallbackEnabled?: boolean;
  fallbackProviderId?: string;
  fallbackModel?: string;
  visionFallbackEnabled?: boolean;
  visionFallbackProviderId?: string;
  visionFallbackModel?: string;
  proxyControlsModel?: boolean;
  primaryProviderId?: string;
  primaryModel?: string;
}

export function parseArgv(argv: string[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (a === "--version" || a === "-V") { out.version = true; continue; }
    if (a === "--verbose" || a === "-v") { out.verbose = true; continue; }
    if (a === "--disable-thinking") { out.disableThinking = true; continue; }
    if (a === "--web-search") { out.webSearch = true; continue; }
    if (a === "--no-web-search") { out.webSearch = false; continue; }
    if (a === "--fallback") { out.fallbackEnabled = true; continue; }
    if (a === "--no-fallback") { out.fallbackEnabled = false; continue; }
    if (a === "--vision-fallback") { out.visionFallbackEnabled = true; continue; }
    if (a === "--no-vision-fallback") { out.visionFallbackEnabled = false; continue; }
    if (a === "--proxy-controls-model") { out.proxyControlsModel = true; continue; }
    if (a === "--no-proxy-controls-model") { out.proxyControlsModel = false; continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      i++;
      if (a === "--port" || a === "-p") out.port = Number(next);
      else if (a === "--host") out.host = next;
      else if (a === "--data-dir") out.dataDir = next;
      else if (a === "--model") out.model = next;
      else if (a === "--provider") out.provider = next;
      else if (a === "--base-url") out.baseUrl = next;
      else if (a === "--api-key") out.apiKey = next;
      else if (a === "--fallback-provider") out.fallbackProviderId = next;
      else if (a === "--fallback-model") out.fallbackModel = next;
      else if (a === "--vision-fallback-provider") out.visionFallbackProviderId = next;
      else if (a === "--vision-fallback-model") out.visionFallbackModel = next;
      else if (a === "--primary-provider") out.primaryProviderId = next;
      else if (a === "--primary-model") out.primaryModel = next;
    }
  }
  return out;
}

export function buildConfig(argv: string[]): AppConfig {
  const args = parseArgv(argv);
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return {
    host: (args.host as string) || "127.0.0.1",
    port: (args.port as number) || 8788,
    dataDir: (args.dataDir as string) || (home + "/.anyway2codex"),
    verbose: !!args.verbose,
    defaultProviderId: (args.provider as string) || "mimo",
    providers: {},
    disableThinking: args.disableThinking as boolean | undefined,
    webSearch: args.webSearch as boolean | undefined,
    fallbackEnabled: args.fallbackEnabled === undefined
      ? process.env.ANYWAY_FALLBACK !== "0"
      : args.fallbackEnabled !== false,
    fallbackProviderId: (args.fallbackProviderId as string) || process.env.ANYWAY_FALLBACK_PROVIDER || "qwen",
    fallbackModel: (args.fallbackModel as string) || process.env.ANYWAY_FALLBACK_MODEL || "qwen3.8-flash",
    visionFallbackEnabled: args.visionFallbackEnabled === undefined
      ? process.env.ANYWAY_VISION_FALLBACK !== "0"
      : args.visionFallbackEnabled !== false,
    visionFallbackProviderId: (args.visionFallbackProviderId as string) || process.env.ANYWAY_VISION_FALLBACK_PROVIDER || "mimo",
    visionFallbackModel: (args.visionFallbackModel as string) || process.env.ANYWAY_VISION_FALLBACK_MODEL || "mimo-v2.6-flash",
    proxyControlsModel: args.proxyControlsModel === undefined
      ? process.env.ANYWAY_PROXY_CONTROLS_MODEL === "1"
      : args.proxyControlsModel !== false,
    primaryProviderId: (args.primaryProviderId as string) || process.env.ANYWAY_PRIMARY_PROVIDER || "mimo",
    primaryModel: (args.primaryModel as string) || process.env.ANYWAY_PRIMARY_MODEL || "",
  };
}
