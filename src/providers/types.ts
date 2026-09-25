import type { ChatRequest, ResponsesRequest } from "../translate/types.js";

export interface ModelInfo {
  id: string;
  aliases?: string[];
  displayName?: string;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  supportsWebSearch?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  deprecatedAfter?: string;
  note?: string;
}

export interface PreprocessCtx {
  upstreamModel: string;
  dataDir?: string;
  disableThinking?: boolean;
  forceHighEffort?: boolean;
  webSearchEnabled?: boolean;
  supportsImages?: boolean;
}

export interface EnhancedError {
  code: string;
  message: string;
}

export interface Provider {
  id: string;
  shortcut: string;
  displayName: string;
  defaultBaseUrl: string;
  baseUrlEnv: string;
  envKeys: string[];
  defaultModel: string;
  builtinModels: ModelInfo[];
  docsUrl?: string;

  detectFlags(apiKey: string, baseUrl: string): Record<string, unknown>;
  inferBaseUrlFromKey(apiKey: string): string | null;
  resolveModel(clientModel: string): ModelInfo | null;
  preprocessResponses(req: ResponsesRequest, ctx: PreprocessCtx): ChatRequest;
  preprocessChat(req: ChatRequest, ctx: PreprocessCtx): ChatRequest;
  wireApi?: "chat" | "responses";
  enhanceError(err: { status: number; snippet?: string }): EnhancedError | null;
}
