// Responses API types (Codex client side)
export interface ResponsesRequest {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string;
  tools?: ResponsesTool[];
  tool_choice?: ResponsesToolChoice;
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: string; summary?: string };
  text?: { format?: unknown };
  temperature?: number | null;
  top_p?: number | null;
  max_output_tokens?: number | null;
  metadata?: unknown;
  previous_response_id?: string | null;
  stream?: boolean;
}

export type ResponsesInputItem = ResponsesMessageItem | ResponsesFunctionCallOutputItem;

export interface ResponsesMessageItem {
  type: "message";
  role: "user" | "assistant" | "system" | "developer";
  content: ResponsesContentPart[] | string;
}

export interface ResponsesFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string; annotations?: unknown[] }
  | { type: "input_image"; image_url: string; detail?: string }
  | { type: "input_file"; file_data?: string; filename?: string };

export type ResponsesTool =
  | ResponsesFunctionTool
  | ResponsesWebSearchTool
  | ResponsesMcpTool;

export interface ResponsesFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: unknown;
  strict?: boolean | null;
}

export interface ResponsesWebSearchTool {
  type: "web_search";
}

export interface ResponsesMcpTool {
  type: "mcp";
  server_label?: string;
  server_url?: string;
  connector_id?: string;
}

export type ResponsesToolChoice = string | { type: string; function?: { name: string } };

// Chat Completions types (upstream side)
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
  temperature?: number;
  top_p?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  reasoning_effort?: string;
  thinking?: { type: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | ChatContentPart[] | null;
  name?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
    strict?: boolean | null;
  };
}

export type ChatToolChoice = string | { type: string; function?: { name: string } };

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: ChatUsage;
}

export interface ChatChoice {
  index: number;
  message: {
    role: "assistant";
    content?: string | null;
    reasoning_content?: string;
    tool_calls?: ChatToolCall[];
  };
  finish_reason?: string;
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface ChatStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatStreamChoice[];
  usage?: ChatUsage;
}

export interface ChatStreamChoice {
  index: number;
  delta: {
    role?: "assistant";
    content?: string;
    reasoning_content?: string;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
}
