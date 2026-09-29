import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ResponsesRequest, ChatRequest } from "./translate/types.js";
import { respToResponses } from "./translate/respToResponses.js";
import { pipeChatStreamToResponses } from "./translate/streamToSse.js";
import { iterChatStreamChunks } from "./upstream/chatStream.js";
import { callOpenAICompat, callResponsesPassthrough, UpstreamError } from "./upstream/client.js";
import { applyVisionFallback, selectProviderCandidates, type RouteCandidate } from "./router.js";
import { shouldFallback, fallbackLogSnippet } from "./fallback.js";
import { resolveFallbackSettings } from "./fallbackSettings.js";
import { resolveRoutingSettings } from "./routingSettings.js";
import { resolveVisionFallbackSettings } from "./visionFallbackSettings.js";
import { chatRequestContainsImages, responsesRequestContainsImages } from "./translate/imageDetection.js";
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

function logAttemptFailure(
  route: RouteCandidate,
  body: unknown,
  endpoint: string,
  startTime: number,
  stream: boolean,
  err: unknown,
  pending: boolean,
) {
  const status = err instanceof UpstreamError ? err.status : 500;
  const code = err instanceof UpstreamError ? err.code : "internal_error";
  insertLog({
    ts: startTime,
    provider_id: route.provider.id,
    client_model: (body as any)?.model ?? "",
    upstream_model: route.upstreamModel,
    endpoint,
    status_code: status,
    duration_ms: Date.now() - startTime,
    stream: stream ? 1 : 0,
    error_code: code,
    error_snippet: fallbackLogSnippet(err, pending).substring(0, 2000),
    request_body: JSON.stringify(body).substring(0, 2000000),
  });
}


function loadApiKeys(cfg: AppConfig): Record<string, { baseUrl: string; apiKey: string }> {
  const result: Record<string, { baseUrl: string; apiKey: string }> = {};
  for (const p of Object.values(PROVIDERS)) {
    const configured = cfg.providers[p.id];
    let apiKey = configured?.apiKey || "";
    if (!apiKey) {
      for (const envKey of p.envKeys) {
        const val = process.env[envKey];
        if (val) { apiKey = val; break; }
      }
    }
    if (!apiKey) apiKey = getApiKey(p.id) || "";
    if (apiKey) {
      const inferred = p.inferBaseUrlFromKey(apiKey);
      result[p.id] = {
        baseUrl: configured?.baseUrl || process.env[p.baseUrlEnv] || inferred || p.defaultBaseUrl,
        apiKey,
      };
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

  const apiKeys = loadApiKeys(cfg);
  const fallback = resolveFallbackSettings({ enabled: cfg.fallbackEnabled, providerId: cfg.fallbackProviderId, model: cfg.fallbackModel });
  const routing = resolveRoutingSettings({
    enabled: cfg.proxyControlsModel,
    providerId: cfg.primaryProviderId,
    model: cfg.primaryModel,
  });
  const baseRoutes = selectProviderCandidates(
    body,
    apiKeys,
    cfg.defaultProviderId,
    fallback.enabled ? fallback.providerId : undefined,
    fallback.enabled ? fallback.model : undefined,
    routing,
  );
  const visionFallback = resolveVisionFallbackSettings({
    enabled: cfg.visionFallbackEnabled,
    providerId: cfg.visionFallbackProviderId,
    model: cfg.visionFallbackModel,
  });
  const routes = applyVisionFallback(
    baseRoutes,
    apiKeys,
    visionFallback,
    responsesRequestContainsImages(body),
  );
  if (!routes.length) {
    sendJson(res, 400, errorEnvelope(400, "invalid_model", "No provider found for model: " + body.model + ". Configure an API key in the web panel."));
    return;
  }
  const startTime = Date.now();
  let route = routes[0];
  if (route.visionFallback) {
    log.info(
      "image fallback applied: provider=" + route.provider.id +
      " model=" + route.upstreamModel +
      " client_model=" + body.model,
    );
  }
  log.info("request -> " + route.provider.displayName + " model=" + route.upstreamModel + (body.stream ? " stream" : "") + (route.provider.wireApi === "responses" ? " (passthrough)" : "") + (routes.length > 1 ? " fallback=" + routes[1].provider.id + ":" + routes[1].upstreamModel : ""));

  // Responses API passthrough: forward directly without translation.
  if (route.provider.wireApi === "responses") {
    const ac = new AbortController();
    req.on("close", () => ac.abort());
    const isStream = !!body.stream;
    let keepalive: NodeJS.Timeout | null = null;
    if (isStream) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      if (typeof res.flushHeaders === "function") res.flushHeaders();
      keepalive = setInterval(() => { try { res.write(": keepalive\n\n"); } catch {} }, 15000);
      res.on("close", () => { if (keepalive) clearInterval(keepalive); });
    }

    let upstreamRes: Response | undefined;
    for (let attemptIndex = 0; attemptIndex < routes.length; attemptIndex++) {
      route = routes[attemptIndex];
      try {
        const forwardBody = {
          ...(body as any),
          model: route.upstreamModel,
          stream: isStream,
        };
        upstreamRes = await callResponsesPassthrough(
          { baseUrl: route.baseUrl, apiKey: route.apiKey },
          forwardBody,
          ac.signal,
        );
        break;
      } catch (err) {
        const pending = attemptIndex < routes.length - 1 && shouldFallback(err, ac.signal.aborted);
        logAttemptFailure(route, body, "/v1/responses", startTime, isStream, err, pending);
        if (pending) {
          log.warn("fallback: " + route.provider.id + " failed, trying " + routes[attemptIndex + 1].provider.id + ":" + routes[attemptIndex + 1].upstreamModel);
          continue;
        }
        break;
      }
    }

    if (!upstreamRes) {
      if (keepalive) clearInterval(keepalive);
      const lastErr = new Error("upstream request failed");
      const status = 502;
      if (isStream) {
        if (!res.headersSent) {
          res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache");
          if (typeof res.flushHeaders === "function") res.flushHeaders();
        }
        try {
          res.write("event: response.failed\ndata: " + JSON.stringify({
            type: "response.failed",
            sequence_number: 9999,
            response: {
              id: "resp_failed",
              object: "response",
              created_at: Math.floor(Date.now() / 1000),
              status: "failed",
              model: route.upstreamModel || body.model,
              output: [],
              error: { type: "upstream_error", code: "upstream_unreachable", message: lastErr.message },
            },
          }) + "\n\n");
          res.end();
        } catch {}
      } else if (!res.headersSent) {
        sendJson(res, status, errorEnvelope(status, "upstream_unreachable", lastErr.message));
      }
      return;
    }

    if (!isStream) {
      try {
        const json = await upstreamRes.json();
        if (json && typeof json === "object") json.model = route.upstreamModel;
        insertLog({
          ts: startTime,
          provider_id: route.provider.id,
          client_model: body.model,
          upstream_model: route.upstreamModel,
          endpoint: "/v1/responses",
          status_code: 200,
          duration_ms: Date.now() - startTime,
          stream: 0,
          request_body: JSON.stringify(body).substring(0, 2000000),
          response_body: JSON.stringify(json).substring(0, 2000000),
          ...extractThreadInfo(body),
        });
        sendJson(res, 200, json);
      } catch (err) {
        const status = err instanceof UpstreamError ? err.status : 502;
        const code = err instanceof UpstreamError ? err.code : "invalid_upstream_response";
        insertLog({
          ts: startTime,
          provider_id: route.provider.id,
          client_model: body.model,
          upstream_model: route.upstreamModel,
          endpoint: "/v1/responses",
          status_code: status,
          duration_ms: Date.now() - startTime,
          stream: 0,
          error_code: code,
          error_snippet: (err as Error).message?.substring(0, 2000),
          request_body: JSON.stringify(body).substring(0, 2000000),
          ...extractThreadInfo(body),
        });
        if (!res.headersSent) sendJson(res, status, errorEnvelope(status, code, (err as Error).message));
      }
      return;
    }

    if (keepalive) clearInterval(keepalive);
    if (upstreamRes.body && typeof upstreamRes.body.getReader === "function") {
      const reader = upstreamRes.body.getReader();
      const bodyTimeoutAc = new AbortController();
      const bodyTimeoutId = setTimeout(() => bodyTimeoutAc.abort(), 120_000);
      const mergedSignal = AbortSignal.any([ac.signal, bodyTimeoutAc.signal]);
      let streamError: unknown = null;
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
        streamError = err;
        log.error("passthrough stream read error: " + (err as Error).message);
      } finally {
        clearTimeout(bodyTimeoutId);
        try { reader.cancel(); } catch {}
        try { res.end(); } catch {}
      }
      insertLog({
        ts: startTime,
        provider_id: route.provider.id,
        client_model: body.model,
        upstream_model: route.upstreamModel,
        endpoint: "/v1/responses",
        status_code: streamError ? 500 : 200,
        duration_ms: Date.now() - startTime,
        stream: 1,
        request_body: JSON.stringify(body).substring(0, 2000000),
        error_code: streamError ? "stream_error" : undefined,
        error_snippet: streamError ? (streamError as Error).message?.substring(0, 2000) : undefined,
        ...extractThreadInfo(body),
      });
    } else {
      try { res.end(); } catch {}
    }
    return;
  }

  const makeAttempt = async (candidate: RouteCandidate) => {
    const resolvedModel = candidate.provider.resolveModel(candidate.upstreamModel);
    const ctx: PreprocessCtx = {
      upstreamModel: candidate.upstreamModel,
      dataDir: cfg.dataDir,
      disableThinking: cfg.disableThinking,
      forceHighEffort: false,
      webSearchEnabled: cfg.webSearch,
      supportsImages: resolvedModel?.supportsImages ?? false,
    };
    const chatBody = candidate.provider.preprocessResponses(body, ctx);
    console.error("[UPSTREAM REQ] provider=" + candidate.provider.id + " model=" + (chatBody as any).model + " msgs=" + (chatBody as any).messages?.length + " tools=" + ((chatBody as any).tools?.length ?? 0) + " stream=" + (chatBody as any).stream + " reasoning_effort=" + (chatBody as any).reasoning_effort);
    const autoCompact = resolveAutoCompact(cfg, resolvedModel?.contextWindow);
    if (autoCompact.enabled && autoCompact.atTokens != null && (chatBody as any).messages) {
      const callChatForSummary = async (summaryReq: any) => {
        const summaryResponse = await callOpenAICompat(
          { baseUrl: candidate.baseUrl, apiKey: candidate.apiKey },
          { ...summaryReq, model: candidate.upstreamModel },
          new AbortController().signal,
        );
        const summaryJson = await summaryResponse.json() as any;
        return summaryJson.choices?.[0]?.message?.content ?? "";
      };
      await maybeCompactChat(chatBody as any, { atTokens: autoCompact.atTokens, callChat: callChatForSummary });
    }
    return { resolvedModel, chatBody };
  };

  const ac = new AbortController();
  req.on("close", () => ac.abort());

  if (body.stream) {
    const sink = makeServerResponseSink(res);
    const KEEPALIVE_MS = 15000;
    const keepalive = setInterval(() => sink.comment("keepalive"), KEEPALIVE_MS);
    res.on("close", () => clearInterval(keepalive));

    let upstreamRes: Response | undefined;
    let upstreamAttempt: any = null;
    let lastError: unknown = null;
    for (let attemptIndex = 0; attemptIndex < routes.length; attemptIndex++) {
      route = routes[attemptIndex];
      try {
        upstreamAttempt = await makeAttempt(route);
        upstreamRes = await callOpenAICompat({
          baseUrl: route.baseUrl,
          apiKey: route.apiKey,
          contextOverflowMode: "friendly",
          modelInfo: upstreamAttempt.resolvedModel
            ? { id: route.upstreamModel, contextWindow: upstreamAttempt.resolvedModel.contextWindow }
            : { id: route.upstreamModel },
        }, upstreamAttempt.chatBody as any, ac.signal);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        const pending = attemptIndex < routes.length - 1 && shouldFallback(err, ac.signal.aborted);
        logAttemptFailure(route, body, "/v1/responses", startTime, true, err, pending);
        if (pending) {
          log.warn("fallback: " + route.provider.id + " failed, trying " + routes[attemptIndex + 1].provider.id + ":" + routes[attemptIndex + 1].upstreamModel);
          continue;
        }
        break;
      }
    }

    if (!upstreamRes) {
      clearInterval(keepalive);
      const status = lastError instanceof UpstreamError ? lastError.status : 502;
      const code = lastError instanceof UpstreamError ? lastError.code : "upstream_unreachable";
      if (!sink.closed()) {
        sink.write("response.failed", {
          type: "response.failed",
          sequence_number: 9999,
          response: {
            id: "resp_failed",
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status: "failed",
            model: route.upstreamModel || body.model,
            output: [],
            error: { type: "upstream_error", code, message: (lastError as Error)?.message ?? "All provider attempts failed" },
          },
        });
        sink.end();
      }
      return;
    }

    let streamError: any = null;
    let pipeResult: any;
    try {
      const rawChunks = iterChatStreamChunks(upstreamRes, ac.signal);
      pipeResult = await pipeChatStreamToResponses(sink, { chunks: rawChunks }, body, {
        exposeReasoning: true,
        model: route.upstreamModel,
      });
    } catch (err) {
      streamError = err;
      log.error("stream mid-stream error: " + (err as Error).message);
      if (!sink.closed()) {
        sink.write("response.failed", {
          type: "response.failed",
          sequence_number: 9999,
          response: {
            id: "resp_failed",
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status: "failed",
            model: route.upstreamModel || body.model,
            output: [],
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
        ts: startTime,
        provider_id: route.provider.id,
        client_model: body.model,
        upstream_model: route.upstreamModel,
        endpoint: "/v1/responses",
        status_code: streamError ? 500 : 200,
        duration_ms: Date.now() - startTime,
        stream: 1,
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
        ...extractThreadInfo(body),
      });
    }
    return;
  }

  let nonStreamJson: any = null;
  let nonStreamAttempt: any = null;
  let nonStreamError: unknown = null;
  for (let attemptIndex = 0; attemptIndex < routes.length; attemptIndex++) {
    route = routes[attemptIndex];
    try {
      nonStreamAttempt = await makeAttempt(route);
      const response = await callOpenAICompat({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        contextOverflowMode: "friendly",
        modelInfo: nonStreamAttempt.resolvedModel
          ? { id: route.upstreamModel, contextWindow: nonStreamAttempt.resolvedModel.contextWindow }
          : { id: route.upstreamModel },
      }, { ...nonStreamAttempt.chatBody, stream: false } as any, ac.signal);
      nonStreamJson = await response.json();
      nonStreamError = null;
      break;
    } catch (err) {
      nonStreamError = err;
      const pending = attemptIndex < routes.length - 1 && shouldFallback(err, ac.signal.aborted);
      logAttemptFailure(route, body, "/v1/responses", startTime, false, err, pending);
      if (pending) {
        log.warn("fallback: " + route.provider.id + " failed, trying " + routes[attemptIndex + 1].provider.id + ":" + routes[attemptIndex + 1].upstreamModel);
        continue;
      }
      break;
    }
  }

  if (nonStreamJson == null) {
    const status = nonStreamError instanceof UpstreamError ? nonStreamError.status : 502;
    const code = nonStreamError instanceof UpstreamError ? nonStreamError.code : "upstream_unreachable";
    if (!res.headersSent) {
      sendJson(res, status, errorEnvelope(status, code, (nonStreamError as Error)?.message ?? "All provider attempts failed"));
    }
    return;
  }

  try {
    const translated = respToResponses(nonStreamJson, body, { model: route.upstreamModel });
    const userMsg = extractUserMessage(body.input);
    const asstResp = extractAssistantResponse((translated as any).output);
    insertLog({
      ts: startTime,
      provider_id: route.provider.id,
      client_model: body.model,
      upstream_model: route.upstreamModel,
      endpoint: "/v1/responses",
      status_code: 200,
      duration_ms: Date.now() - startTime,
      stream: 0,
      prompt_tokens: nonStreamJson?.usage?.prompt_tokens,
      completion_tokens: nonStreamJson?.usage?.completion_tokens,
      total_tokens: nonStreamJson?.usage?.total_tokens,
      user_message: userMsg,
      assistant_response: asstResp,
      request_body: JSON.stringify(body).substring(0, 2000000),
      response_body: JSON.stringify(nonStreamJson).substring(0, 2000000),
      ...extractThreadInfo(body),
    });
    sendJson(res, 200, translated);
  } catch (err) {
    const status = 500;
    insertLog({
      ts: startTime,
      provider_id: route.provider.id,
      client_model: body.model,
      upstream_model: route.upstreamModel,
      endpoint: "/v1/responses",
      status_code: status,
      duration_ms: Date.now() - startTime,
      stream: 0,
      error_code: "response_translation_error",
      error_snippet: (err as Error).message?.substring(0, 2000),
      request_body: JSON.stringify(body).substring(0, 2000000),
      ...extractThreadInfo(body),
    });
    if (!res.headersSent) sendJson(res, status, errorEnvelope(status, "response_translation_error", (err as Error).message));
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
  const apiKeys = loadApiKeys(cfg);
  const fallback = resolveFallbackSettings({ enabled: cfg.fallbackEnabled, providerId: cfg.fallbackProviderId, model: cfg.fallbackModel });
  const routing = resolveRoutingSettings({
    enabled: cfg.proxyControlsModel,
    providerId: cfg.primaryProviderId,
    model: cfg.primaryModel,
  });
  const baseRoutes = selectProviderCandidates(
    body,
    apiKeys,
    cfg.defaultProviderId,
    fallback.enabled ? fallback.providerId : undefined,
    fallback.enabled ? fallback.model : undefined,
    routing,
  );
  const visionFallback = resolveVisionFallbackSettings({
    enabled: cfg.visionFallbackEnabled,
    providerId: cfg.visionFallbackProviderId,
    model: cfg.visionFallbackModel,
  });
  const routes = applyVisionFallback(
    baseRoutes,
    apiKeys,
    visionFallback,
    chatRequestContainsImages(body),
  );
  if (!routes.length) {
    sendJson(res, 400, errorEnvelope(400, "invalid_model", "No provider found for model: " + body.model));
    return;
  }

  const startTime = Date.now();
  const ac = new AbortController();
  req.on("close", () => ac.abort());
  if (body.stream) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
  }
  const chatKeepalive = body.stream
    ? setInterval(() => { try { res.write(": keepalive\n\n"); } catch {} }, 15000)
    : null;
  if (chatKeepalive) res.on("close", () => clearInterval(chatKeepalive));

  let activeRoute = routes[0];
  if (activeRoute.visionFallback) {
    log.info(
      "image fallback applied: provider=" + activeRoute.provider.id +
      " model=" + activeRoute.upstreamModel +
      " client_model=" + body.model,
    );
  }
  let response: Response | undefined;
  for (let attemptIndex = 0; attemptIndex < routes.length; attemptIndex++) {
    activeRoute = routes[attemptIndex];
    try {
      const resolvedModel = activeRoute.provider.resolveModel(activeRoute.upstreamModel);
      const ctx: PreprocessCtx = {
        upstreamModel: activeRoute.upstreamModel,
        dataDir: cfg.dataDir,
        disableThinking: cfg.disableThinking,
        forceHighEffort: false,
        webSearchEnabled: cfg.webSearch,
        supportsImages: resolvedModel?.supportsImages ?? false,
      };
      const chatBody = activeRoute.provider.preprocessChat(body, ctx);
      chatBody.model = activeRoute.upstreamModel;
      const chatAutoCompact = resolveAutoCompact(cfg, resolvedModel?.contextWindow);
      if (chatAutoCompact.enabled && chatAutoCompact.atTokens != null && (chatBody as any).messages) {
        const callChatSummary = async (summaryReq: any) => {
          const summaryResponse = await callOpenAICompat(
            { baseUrl: activeRoute.baseUrl, apiKey: activeRoute.apiKey },
            { ...summaryReq, model: activeRoute.upstreamModel },
            new AbortController().signal,
          );
          const summaryJson = await summaryResponse.json() as any;
          return summaryJson.choices?.[0]?.message?.content ?? "";
        };
        await maybeCompactChat(chatBody as any, { atTokens: chatAutoCompact.atTokens, callChat: callChatSummary });
      }
      response = await callOpenAICompat(
        { baseUrl: activeRoute.baseUrl, apiKey: activeRoute.apiKey },
        chatBody as any,
        ac.signal,
      );
      break;
    } catch (err) {
      const pending = attemptIndex < routes.length - 1 && shouldFallback(err, ac.signal.aborted);
      logAttemptFailure(activeRoute, body, "/v1/chat/completions", startTime, !!body.stream, err, pending);
      if (pending) {
        log.warn("fallback: " + activeRoute.provider.id + " failed, trying " + routes[attemptIndex + 1].provider.id + ":" + routes[attemptIndex + 1].upstreamModel);
        continue;
      }
      break;
    }
  }

  if (!response) {
    if (chatKeepalive) clearInterval(chatKeepalive);
    if (!res.headersSent) {
      sendJson(res, 502, errorEnvelope(502, "upstream_unreachable", "All provider attempts failed"));
    } else {
      try { res.end(); } catch {}
    }
    return;
  }

  try {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream") && body.stream) {
      if (response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const bodyTimeoutAc = new AbortController();
        const bodyTimeoutId = setTimeout(() => bodyTimeoutAc.abort(), 120_000);
        const mergedSignal = AbortSignal.any([ac.signal, bodyTimeoutAc.signal]);
        let streamError: unknown = null;
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
          streamError = err;
          try { log.error("chat passthrough stream error: " + (err as Error).message); } catch {}
        } finally {
          clearTimeout(bodyTimeoutId);
          if (chatKeepalive) clearInterval(chatKeepalive);
          try { reader.cancel(); } catch {}
          try { res.end(); } catch {}
        }
        insertLog({
          ts: startTime,
          provider_id: activeRoute.provider.id,
          client_model: body.model,
          upstream_model: activeRoute.upstreamModel,
          endpoint: "/v1/chat/completions",
          status_code: streamError ? 500 : 200,
          duration_ms: Date.now() - startTime,
          stream: 1,
          error_code: streamError ? "stream_error" : undefined,
          error_snippet: streamError ? (streamError as Error).message?.substring(0, 2000) : undefined,
          request_body: JSON.stringify(body).substring(0, 2000000),
          ...extractThreadInfo(body),
        });
      } else {
        if (chatKeepalive) clearInterval(chatKeepalive);
        res.end();
        insertLog({
          ts: startTime,
          provider_id: activeRoute.provider.id,
          client_model: body.model,
          upstream_model: activeRoute.upstreamModel,
          endpoint: "/v1/chat/completions",
          status_code: 200,
          duration_ms: Date.now() - startTime,
          stream: 1,
          request_body: JSON.stringify(body).substring(0, 2000000),
          ...extractThreadInfo(body),
        });
      }
    } else {
      const json = await response.json();
      if (chatKeepalive) clearInterval(chatKeepalive);
      sendJson(res, 200, json);
      insertLog({
        ts: startTime,
        provider_id: activeRoute.provider.id,
        client_model: body.model,
        upstream_model: activeRoute.upstreamModel,
        endpoint: "/v1/chat/completions",
        status_code: 200,
        duration_ms: Date.now() - startTime,
        stream: 0,
        request_body: JSON.stringify(body).substring(0, 2000000),
        response_body: JSON.stringify(json).substring(0, 2000000),
        ...extractThreadInfo(body),
      });
    }
  } catch (err) {
    if (chatKeepalive) clearInterval(chatKeepalive);
    if (ac.signal.aborted) return;
    const status = err instanceof UpstreamError ? err.status : 500;
    insertLog({
      ts: startTime,
      provider_id: activeRoute.provider.id,
      client_model: body.model,
      upstream_model: activeRoute.upstreamModel,
      endpoint: "/v1/chat/completions",
      status_code: status,
      duration_ms: Date.now() - startTime,
      stream: body.stream ? 1 : 0,
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
    if (handleWebRequest(req, res, cfg.dataDir, cfg)) return;
    sendJson(res, 404, errorEnvelope(404, "not_found", "no route for " + method + " " + path));
  });
  server.listen(cfg.port, cfg.host);
  log.info("anyway2codex listening on http://" + cfg.host + ":" + cfg.port);
  const startupFallback = resolveFallbackSettings({ enabled: cfg.fallbackEnabled, providerId: cfg.fallbackProviderId, model: cfg.fallbackModel });
  if (startupFallback.enabled) {
    log.info("fallback enabled: " + startupFallback.providerId + ":" + startupFallback.model);
  }
  return server;
}

