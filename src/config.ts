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
  };
}
