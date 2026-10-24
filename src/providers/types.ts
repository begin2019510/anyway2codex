import type { AnthropicMessagesRequest, ChatRequest, ResponsesRequest } from "../translate/types.js";

export type ModelAccessMode = "token_plan" | "payg";
export type ModelThinkingMode = "hybrid" | "always" | "off";

export interface ModelInfo {
  id: string;
  aliases?: string[];
  displayName?: string;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  supportsWebSearch?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  maxInputTokens?: number;
  deprecatedAfter?: string;
  note?: string;
  /** Billing modes that can serve this id. Undefined = every mode. */
  access?: ModelAccessMode[];
  /** Upstream model family; selects the thinking/reasoning parameter shape. */
  family?: string;
  /** hybrid = enable_thinking is honoured, always = thinking cannot be disabled. */
  thinkingMode?: ModelThinkingMode;
  /** reasoning_effort spellings accepted by this model upstream. */
  reasoningEfforts?: string[];
  /** Hide from panel pickers while keeping existing configs resolvable. */
  hidden?: boolean;
  /** false = hosted copy of another vendor's model: never wins global name routing. */
  claim?: boolean;
}

export interface PreprocessCtx {
  upstreamModel: string;
  dataDir?: string;
  disableThinking?: boolean;
  forceHighEffort?: boolean;
  webSearchEnabled?: boolean;
  supportsImages?: boolean;
  baseUrl?: string;
  apiKey?: string;
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
  wireApi?: "chat" | "responses" | "anthropic";
  enhanceError(err: { status: number; snippet?: string }): EnhancedError | null;

  // Anthropic Messages support (POST /v1/messages), used by Claude Code.
  // Routing for that endpoint deliberately does NOT share the Codex paths' alias
  // table or fallback chain: it matches the model name the client asked for and
  // forwards it unchanged, so a picked model can never be silently swapped.
  supportsAnthropic?: boolean;
  /** Model-name prefixes this upstream serves over its Anthropic endpoint. */
  anthropicModelPrefixes?: string[];
  /** Base URL for the Anthropic endpoint, without a trailing /v1 or /messages. */
  anthropicBaseUrl?: string;
  resolveAnthropicBaseUrl?(apiKey: string, baseUrl: string): string | null;
  preprocessMessages?(req: AnthropicMessagesRequest, ctx: PreprocessCtx): {
    body: AnthropicMessagesRequest;
    /** Content block types dropped for this upstream, reported so nothing vanishes silently. */
    removed: string[];
  };
  /**
   * True when an upstream failure will not succeed on retry (an exhausted quota, an
   * unsupported model id), so callers fail fast instead of burning the whole retry
   * budget. Transient throttling must stay retryable.
   */
  isTerminalError?(ctx: { status: number; snippet?: string }): boolean;

  /** Models reachable with the credentials actually configured. */
  listModels?(runtime: { baseUrl: string; apiKey: string }): ModelInfo[];
  /** Billing mode inferred from base URL / key shape. */
  detectAccess?(runtime: { baseUrl: string; apiKey: string }): ModelAccessMode | null;
}
