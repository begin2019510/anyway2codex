import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ResponsesRequest, ChatRequest } from "./translate/types.js";
import { respToResponses } from "./translate/respToResponses.js";
import { pipeChatStreamToResponses } from "./translate/streamToSse.js";
import { iterChatStreamChunks } from "./upstream/chatStream.js";
import { callOpenAICompat, callResponsesPassthrough, UpstreamError } from "./upstream/client.js";
import { selectProvider } from "./router.js";
import { makeServerResponseSink } from "./util/sse.js";
import { log } from "./util/log.js";
import type { AppConfig } from "./config.js";
import type { PreprocessCtx } from "./providers/types.js";
import { PROVIDERS } from "./providers/registry.js";
import { handleWebRequest } from "./web/server.js";
import { getApiKey } from "./web/api/keys.js";
import { insertLog } from "./db/logs.js";
import { maybeCompactChat, estimateTokens } from "./translate/autoCompact.js";


function extractThreadInfo(body: any)                                           {
  try {
    const cm = body?.client_metadata;
    if (!cm) return {};
    if (cm.thread_id) return { thread_id: cm.thread_id, turn_id: cm.turn_id };
    if (cm['x-codex-turn-metadata']) {
      const meta = typeof cm['x-codex-turn-metadata'] === 'string' ? JSON.parse(cm['x-codex-turn-metadata']) : cm['x-codex-turn-metadata'];
      return { thread_id: meta.thread_id, turn_id: meta.turn_id };
    }
  } catch {}
  return {};
}
// Extract user message text from Responses input
function extractUserMessage(input: any[]): string {
  if (!input || !Array.isArray(input)) return "";
  // Only extract the LAST user message (for multi-turn conversations)
  let lastUserMsg = "";
  for (const item of input) {
    if (item.type === "message" && item.role === "user") {
      const content = item.content;
      let text = "";
      if (typeof content === "string") { text = content; }
      else if (Array.isArray(content)) {
        text = content.filter((p: any) => p.type === "input_text" && p.text).map((p: any) => p.text).join("\n");
      }
      if (text) lastUserMsg = text;
    }
  }
  return lastUserMsg.substring(0, 2000);
}

// Extract assistant response text from Responses output
function extractAssistantResponse(output: any[]): string {
  if (!output) return "";
  const parts: string[] = [];
  for (const item of output) {
    if (item.type === "message" && item.role === "assistant" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === "output_text" && c.text) parts.push(c.text);
      }
    }
  }
  // Also include reasoning summary for log visibility
  const reasoningParts: string[] = [];
  for (const item of output) {
    if (item.type === "reasoning") {
      if (item.encrypted_content) reasoningParts.push("[reasoning]");
      else if (item.summary) reasoningParts.push(item.summary.map((s: any) => s.text || "").join(""));
    }
  }
  const toolCalls = output.filter((o: any) => o.type === "function_call").map((o: any) => "[tool:" + o.name + "]");
  const allParts = [...reasoningParts, ...parts, ...toolCalls];
  return allParts.join("\n").substring(0, 2000000);
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function errorEnvelope(status: number, code: string, message: string) {
  return { error: { type: "error", code, message, param: null } };
}

function loadApiKeys(): Record<string, { baseUrl: string; apiKey: string }> {
  const result: Record<string, { baseUrl: string; apiKey: string }> = {};
  for (const p of Object.values(PROVIDERS)) {
    let apiKey = "";
    for (const envKey of p.envKeys) {
      const val = process.env[envKey];
      if (val) { apiKey = val; break; }
    }
    if (!apiKey) {
      const dbKey = getApiKey(p.id);
      if (dbKey) apiKey = dbKey;
    }
    if (apiKey) {
      const inferred = p.inferBaseUrlFromKey(apiKey);
      result[p.id] = { baseUrl: inferred ?? p.defaultBaseUrl, apiKey };
    }
  }
  return result;
}


// Health-check probe: Codex sends POST /v1/responses with just {model, stream}
// and no input/instructions to test connectivity. Forwarding empty messages[] to
// upstream would 400. Return synthetic 200 instead.
function isCodexProbeModel(model: string): boolean {
  return /^gpt-[56]/.test(model) || /^o[0-9]/.test(model);
}

function isResponsesProbe(body: ResponsesRequest): boolean {
  const b = body as any;
  const hasInput = (typeof b.input === "string" && b.input.length > 0) ||
    (Array.isArray(b.input) && b.input.length > 0);
  const hasInstructions = typeof body.instructions === "string" && body.instructions.length > 0;
  return !hasInput && !hasInstructions;
}

function respondToResponsesProbe(body: any, res: ServerResponse, stream: boolean) {
  const id = "resp_probe_" + Date.now();
  const created_at = Math.floor(Date.now() / 1000);
  const completed = {
    id, object: "response", created_at, status: "completed",
    model: body.model, output: [],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    parallel_tool_calls: true, tool_choice: "auto",
    text: { format: { type: "text" } },
    reasoning: { effort: null, summary: null },
    incomplete_details: null, error: null, metadata: null,
  };
  if (!stream) {
    sendJson(res, 200, completed);
    return;
  }
  // Streaming probe response
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  const events = [
    "event: response.created\ndata: " + JSON.stringify({ type: "response.created", response: completed }) + "\n\n",
    "event: response.in_progress\ndata: " + JSON.stringify({ type: "response.in_progress", response: { ...completed, status: "in_progress" } }) + "\n\n",
    "event: response.completed\ndata: " + JSON.stringify({ type: "response.completed", response: completed }) + "\n\n",
  ];
  for (const ev of events) { try { res.write(ev); } catch {} }
  res.end();
}


function resolveAutoCompact(cfg: AppConfig, contextWindow?: number): { enabled: boolean; atTokens: number | null } {
  const enabled = cfg.autoCompact !== false;
  if (!enabled) return { enabled: false, atTokens: null };
  // Use absolute threshold (default 80K), not percentage of advertised contextWindow.
  // MiMo/DeepSeek advertise 1M but real limit is ~128K.
  const atTokens = cfg.autoCompactAtTokens ?? 800_000;
  return { enabled, atTokens };
}

async function handleResponses(cfg: AppConfig, req: IncomingMessage, res: ServerResponse, body: ResponsesRequest) {
  console.error('[PROXY] incoming request model=' + (body as any).model + ' stream=' + body.stream + ' input_len=' + JSON.stringify(body.input || []).length + ' has_tools=' + !!((body as any).tools) + ' keys=' + Object.keys(body).join(','));
  // Health-check probe short-circuit (must be before selectProvider to avoid 400 on empty probes)
  if (isResponsesProbe(body) || isCodexProbeModel(body.model)) {
    respondToResponsesProbe(body, res, !!body.stream);
    return;
  }

  const apiKeys = loadApiKeys();
  const route = selectProvider(body, apiKeys, cfg.defaultProviderId);
  if (!route) {
    sendJson(res, 400, errorEnvelope(400, "invalid_model", "No provider found for model: " + body.model + ". Configure an API key in the web panel."));
    return;
  }
  const startTime = Date.now();
  log.info("request -> " + route.provider.displayName + " model=" + route.upstreamModel + (body.stream ? " stream" : "") + (route.provider.wireApi === "responses" ? " (passthrough)" : ""));

  // Responses API passthrough: forward directly without translation
  if (route.provider.wireApi === "responses") {
    const ac = new AbortController();
    req.on("close", () => ac.abort());
    // Flush SSE headers + keepalive BEFORE upstream call (prevents idle timeout)
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    const keepalive = setInterval(() => { try { res.write(": keepalive\n\n"); } catch {} }, 15000);
    res.on("close", () => clearInterval(keepalive));
    try {
      const upstreamRes = await callResponsesPassthrough(
        { baseUrl: route.baseUrl, apiKey: route.apiKey },
        body as any,
        ac.signal
      );
      // Pipe upstream SSE bytes directly to client (NO second writeHead)
      if (upstreamRes.body && typeof upstreamRes.body.getReader === "function") {
        const reader = upstreamRes.body.getReader();
        // Body read timeout: 120s of no data = abort
        const bodyTimeoutAc = new AbortController();
        const bodyTimeoutId = setTimeout(() => bodyTimeoutAc.abort(), 120_000);
        const mergedSignal = AbortSignal.any([ac.signal, bodyTimeoutAc.signal]);
        mergedSignal.addEventListener("abort", () => {
          clearTimeout(bodyTimeoutId);
          try { upstreamRes.body?.cancel(); } catch {}
          try { reader.cancel(); } catch {}
        }, { once: true });
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length > 0) {
              try { res.write(Buffer.from(value)); } catch {}
            }
          }
        } catch (err) {
          log.error("passthrough stream read error: " + (err as Error).message);
        } finally {
          clearTimeout(bodyTimeoutId);
          clearInterval(keepalive);
          try { reader.cancel(); } catch {}
          try { res.end(); } catch {}
        }
      } else {
        clearInterval(keepalive);
        try { res.end(); } catch {}
      }
      insertLog({
        ts: startTime, provider_id: route.provider.id, client_model: body.model,
        upstream_model: route.upstreamModel, endpoint: "/v1/responses",
        status_code: upstreamRes.status, duration_ms: Date.now() - startTime, stream: body.stream ? 1 : 0,
        request_body: JSON.stringify(body).substring(0, 2000000),
...extractThreadInfo(body),
});
    } catch (err) {
      const status = err instanceof UpstreamError ? err.status : 500;
      const code = err instanceof UpstreamError ? err.code : "internal_error";
      insertLog({
        ts: startTime, provider_id: route.provider.id, client_model: body.model,
        upstream_model: route.upstreamModel, endpoint: "/v1/responses",
        status_code: status, duration_ms: Date.now() - startTime, stream: body.stream ? 1 : 0,
        error_code: code,
        error_snippet: (err as Error).message?.substring(0, 2000),
        request_body: JSON.stringify(body).substring(0, 2000000),
...extractThreadInfo(body),
});
      if (!res.headersSent) {
        sendJson(res, status, errorEnvelope(status, code, (err as Error).message));
      }
    }
    return;
  }

  const resolvedModel = route.provider.resolveModel(route.upstreamModel);
  const ctx: PreprocessCtx = {
    upstreamModel: route.upstreamModel,
    dataDir: cfg.dataDir,
    disableThinking: cfg.disableThinking,
    forceHighEffort: false,
    webSearchEnabled: cfg.webSearch,
    supportsImages: resolvedModel?.supportsImages ?? false,
  };

  const chatBody = route.provider.preprocessResponses(body, ctx);
  console.error("[UPSTREAM REQ] model=" + (chatBody as any).model + " msgs=" + (chatBody as any).messages?.length + " tools=" + ((chatBody as any).tools?.length ?? 0) + " stream=" + (chatBody as any).stream + " reasoning_effort=" + (chatBody as any).reasoning_effort);
  // Auto-compact: summarize old messages when context gets too long
  const autoCompact = resolveAutoCompact(cfg, resolvedModel?.contextWindow);
  if (autoCompact.enabled && autoCompact.atTokens != null && (chatBody as any).messages) {
    const callChatForSummary = async (summaryReq: any) => {
      const r = await callOpenAICompat(
        { baseUrl: route.baseUrl, apiKey: route.apiKey },
        { ...summaryReq, model: route.upstreamModel },
        new AbortController().signal
      );
      const j = await r.json() as any;
      return j.choices?.[0]?.message?.content ?? "";
    };
    await maybeCompactChat(chatBody as any, { atTokens: autoCompact.atTokens, callChat: callChatForSummary });
  }


  if (body.stream) {
    // Create sink first (it flushes headers). Start keepalive after sink.
    const sink = makeServerResponseSink(res);
    const KEEPALIVE_MS = 15000;
    const keepalive = setInterval(() => sink.comment("keepalive"), KEEPALIVE_MS);
    res.on("close", () => clearInterval(keepalive));

    const ac = new AbortController();
    req.on("close", () => ac.abort());

    let upstreamRes;
    try {
      upstreamRes = await callOpenAICompat({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        contextOverflowMode: "friendly",
        modelInfo: resolvedModel ? { id: route.upstreamModel, contextWindow: resolvedModel.contextWindow } : { id: route.upstreamModel },
      }, chatBody as any, ac.signal);
    } catch (err) {
      clearInterval(keepalive);
      const isUpstream = err instanceof UpstreamError;
      const status = isUpstream ? err.status : 500;
      const code = isUpstream ? err.code : "internal_error";
      if (!isUpstream) log.error("stream pre-stream error: " + (err as Error).message);
      if (!sink.closed()) {
        // Codex expects response.failed (not raw error) as terminal SSE event
        sink.write("response.failed", {
          type: "response.failed",
          sequence_number: 9999,
          response: {
            id: "resp_failed",
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status: "failed",
            model: body.model,
            output: [],
            error: { type: "upstream_error", code, message: (err as Error).message },
          },
        });
        sink.end();
      }
      insertLog({
        ts: startTime, provider_id: route.provider.id, client_model: body.model,
        upstream_model: route.upstreamModel, endpoint: "/v1/responses",
        status_code: status, duration_ms: Date.now() - startTime, stream: 1,
        error_code: code,
        error_snippet: (err as Error).message?.substring(0, 2000),
        request_body: JSON.stringify(body).substring(0, 2000000),
...extractThreadInfo(body),
});
      return;
    }

    let streamError: any = null;
    let pipeResult: any;
    try {
      const rawChunks = iterChatStreamChunks(upstreamRes, ac.signal);
      pipeResult = await pipeChatStreamToResponses(sink, { chunks: rawChunks }, body, { exposeReasoning: true });
    } catch (err) {
      streamError = err;
      log.error("stream mid-stream error: " + (err as Error).message);
      if (!sink.closed()) {
        sink.write("response.failed", {
          type: "response.failed",
          sequence_number: 9999,
          response: {
            id: "resp_failed", object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status: "failed", model: body.model, output: [],
            error: { type: "upstream_error", message: (err as Error).message },
          },
        });
        sink.end();
      }
    } finally {
      clearInterval(keepalive);
      const userMsg2 = extractUserMessage(body.input);
      const u = pipeResult?.usage;
      insertLog({
        ts: startTime, provider_id: route.provider.id, client_model: body.model,
        upstream_model: route.upstreamModel, endpoint: "/v1/responses",
        status_code: streamError ? 500 : 200, duration_ms: Date.now() - startTime, stream: 1,
        user_message: userMsg2,
        assistant_response: streamError ? undefined : extractAssistantResponse((pipeResult?.response as any)?.output ?? []).substring(0, 2000000),
        request_body: JSON.stringify(body).substring(0, 2000000),
        response_body: streamError ? undefined : JSON.stringify(pipeResult?.response).substring(0, 2000000),
        prompt_tokens: u?.input_tokens ?? null,
        completion_tokens: u?.output_tokens ?? null,
        total_tokens: u?.total_tokens ?? null,
        tool_call_count: pipeResult?.toolCallCount ?? null,
        error_code: streamError ? "stream_error" : undefined,
        error_snippet: streamError ? (streamError as Error).message : undefined,
      });
    }
  } else {
    try {
      const response = await callOpenAICompat({ baseUrl: route.baseUrl, apiKey: route.apiKey, contextOverflowMode: "friendly", modelInfo: resolvedModel ? { id: route.upstreamModel, contextWindow: resolvedModel.contextWindow } : { id: route.upstreamModel } }, { ...chatBody, stream: false } as any, new AbortController().signal);
      const json = await response.json() as any;
      const translated = respToResponses(json, body);
      const userMsg = extractUserMessage(body.input);
      const asstResp = extractAssistantResponse((translated as any).output);
      insertLog({
        ts: startTime, provider_id: route.provider.id, client_model: body.model,
        upstream_model: route.upstreamModel, endpoint: "/v1/responses",
        status_code: 200, duration_ms: Date.now() - startTime, stream: 0,
        prompt_tokens: (json as any).usage?.prompt_tokens,
        completion_tokens: (json as any).usage?.completion_tokens,
        total_tokens: (json as any).usage?.total_tokens,
        user_message: userMsg,
        assistant_response: asstResp,
        request_body: JSON.stringify(body).substring(0, 2000000),
        response_body: JSON.stringify(json).substring(0, 2000000),
...extractThreadInfo(body),
});
      sendJson(res, 200, translated);
    } catch (err) {
      const status = err instanceof UpstreamError ? err.status : 500;
      const code = err instanceof UpstreamError ? err.code : "internal_error";
      insertLog({
        ts: startTime, provider_id: route.provider.id, client_model: body.model,
        upstream_model: route.upstreamModel, endpoint: "/v1/responses",
        status_code: status, duration_ms: Date.now() - startTime, stream: 0,
        error_code: code,
        error_snippet: (err as Error).message?.substring(0, 2000),
        request_body: JSON.stringify(body).substring(0, 2000000),
...extractThreadInfo(body),
});
      if (err instanceof UpstreamError) {
        sendJson(res, err.status, errorEnvelope(err.status, err.code, err.message));
      } else {
        log.error("upstream error: " + (err as Error).message);
        sendJson(res, 500, errorEnvelope(500, "internal_error", "proxy error: " + (err as Error).message));
      }
    }
  }
}

function handleModels(_cfg: AppConfig, res: ServerResponse) {
  const models: unknown[] = [];
  for (const p of Object.values(PROVIDERS)) {
    for (const m of p.builtinModels) {
      if (m.deprecatedAfter) continue;
      models.push({ id: m.id, object: "model", owned_by: p.id });
    }
  }
  sendJson(res, 200, { object: "list", data: models });
}

async function handleChatPassthrough(cfg: AppConfig, req: IncomingMessage, res: ServerResponse, body: ChatRequest) {
  const apiKeys = loadApiKeys();
  const route = selectProvider(body, apiKeys, cfg.defaultProviderId);
  if (!route) {
    sendJson(res, 400, errorEnvelope(400, "invalid_model", "No provider found for model: " + body.model));
    return;
  }
  const startTime = Date.now();
  const resolvedModel = route.provider.resolveModel(route.upstreamModel);
  const ctx: PreprocessCtx = {
    upstreamModel: route.upstreamModel,
    dataDir: cfg.dataDir,
    disableThinking: cfg.disableThinking,
    forceHighEffort: false,
    webSearchEnabled: cfg.webSearch,
    supportsImages: resolvedModel?.supportsImages ?? false,
  };
  const chatBody = route.provider.preprocessChat(body, ctx);
  // Auto-compact for chat passthrough
  const chatAutoCompact = resolveAutoCompact(cfg, resolvedModel?.contextWindow);
  if (chatAutoCompact.enabled && chatAutoCompact.atTokens != null && (chatBody as any).messages) {
    const callChatSummary = async (summaryReq: any) => {
      const r = await callOpenAICompat(
        { baseUrl: route.baseUrl, apiKey: route.apiKey },
        { ...summaryReq, model: route.upstreamModel },
        new AbortController().signal
      );
      const j = await r.json() as any;
      return j.choices?.[0]?.message?.content ?? "";
    };
    await maybeCompactChat(chatBody as any, { atTokens: chatAutoCompact.atTokens, callChat: callChatSummary });
  }


  const ac = new AbortController();
  req.on("close", () => ac.abort());
  // Flush SSE headers + keepalive BEFORE upstream call (prevents idle timeout)
  if (body.stream) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
  }
  const chatKeepalive = body.stream ? setInterval(() => { try { res.write(": keepalive\n\n"); } catch {} }, 15000) : null;
  if (chatKeepalive) res.on("close", () => clearInterval(chatKeepalive));

  try {
    const response = await callOpenAICompat({ baseUrl: route.baseUrl, apiKey: route.apiKey }, chatBody as any, ac.signal);
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream") && body.stream) {
      if (response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const bodyTimeoutAc = new AbortController();
        const bodyTimeoutId = setTimeout(() => bodyTimeoutAc.abort(), 120_000);
        const mergedSignal = AbortSignal.any([ac.signal, bodyTimeoutAc.signal]);
        mergedSignal.addEventListener("abort", () => {
          clearTimeout(bodyTimeoutId);
          try { response.body?.cancel(); } catch {}
          try { reader.cancel(); } catch {}
        }, { once: true });
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            try { res.write(value); } catch {}
          }
        } catch (err) {
          try { log.error("chat passthrough stream error: " + (err as Error).message); } catch {}
        } finally {
          clearTimeout(bodyTimeoutId);
          if (chatKeepalive) clearInterval(chatKeepalive);
          try { reader.cancel(); } catch {}
          try { res.end(); } catch {}
        }
      } else {
        if (chatKeepalive) clearInterval(chatKeepalive);
        res.end();
      }
    } else {
      const json = await response.json();
      sendJson(res, 200, json);
    }
    insertLog({
      ts: startTime, provider_id: route.provider.id, client_model: body.model,
      upstream_model: route.upstreamModel, endpoint: "/v1/chat/completions",
      status_code: 200, duration_ms: Date.now() - startTime, stream: body.stream ? 1 : 0,
...extractThreadInfo(body),
});
  } catch (err) {
    if (ac.signal.aborted) return; // client disconnected, no point logging error
    const status = err instanceof UpstreamError ? err.status : 500;
    insertLog({
      ts: startTime, provider_id: route.provider.id, client_model: body.model,
      upstream_model: route.upstreamModel, endpoint: "/v1/chat/completions",
      status_code: status, duration_ms: Date.now() - startTime, stream: body.stream ? 1 : 0,
      error_code: err instanceof UpstreamError ? err.code : "internal_error",
      error_snippet: (err as Error).message?.substring(0, 2000),
      request_body: JSON.stringify(body).substring(0, 2000000),
...extractThreadInfo(body),
});
    if (!res.headersSent) {
      if (err instanceof UpstreamError) {
        sendJson(res, err.status, errorEnvelope(err.status, err.code, err.message));
      } else {
        sendJson(res, 500, errorEnvelope(500, "internal_error", String(err)));
      }
    } else {
      try { res.end(); } catch {}
    }
  }
}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    const MAX_BODY = 10 * 1024 * 1024;
    req.on("data", (c) => {
      totalSize += c.length;
      if (totalSize > MAX_BODY) {
        req.destroy();
        reject(new Error("Request body too large (max 10MB)"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function urlPath(req: IncomingMessage): string {
  const url = req.url || "/";
  const q = url.indexOf("?");
  return q >= 0 ? url.slice(0, q) : url;
}

export function createServer_(cfg: AppConfig) {
  const server = createServer((req, res) => {
    const method = req.method || "GET";
    const path = urlPath(req);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (method === "GET" && (path === "/health" || path === "/")) {
      sendJson(res, 200, { ok: true, version: "0.1.0" }); return;
    }
    if (method === "GET" && path === "/v1/models") { handleModels(cfg, res); return; }
    if (method === "POST" && path === "/v1/responses") {
      void (async () => {
        try {
          const raw = await readBody(req);
          const body = JSON.parse(raw) as ResponsesRequest;
          await handleResponses(cfg, req, res, body);
        } catch (err) {
          try { sendJson(res, 400, errorEnvelope(400, "parse_error", "Invalid JSON: " + (err instanceof Error ? err.message : String(err)))); } catch {}
        }
      })();
      return;
    }
    if (method === "POST" && path === "/v1/chat/completions") {
      void (async () => {
        try {
          const raw = await readBody(req);
          const body = JSON.parse(raw) as ChatRequest;
          await handleChatPassthrough(cfg, req, res, body);
        } catch (err) {
          try { sendJson(res, 400, errorEnvelope(400, "parse_error", "Invalid JSON: " + (err instanceof Error ? err.message : String(err)))); } catch {}
        }
      })();
      return;
    }
    if (handleWebRequest(req, res, cfg.dataDir)) return;
    sendJson(res, 404, errorEnvelope(404, "not_found", "no route for " + method + " " + path));
  });
  server.listen(cfg.port, cfg.host);
  log.info("anyway2codex listening on http://" + cfg.host + ":" + cfg.port);
  return server;
}

