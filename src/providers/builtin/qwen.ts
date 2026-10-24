import type { ModelInfo, PreprocessCtx, Provider } from "../types.js";
import { reqToChat, MIXED_MODE_REASONING_PLACEHOLDER } from "../../translate/reqToChat.js";
import type { ChatRequest, ResponsesRequest } from "../../translate/types.js";
import {
  QWEN_PAYG_BASE_URL,
  QWEN_TOKEN_PLAN_BASE_URL,
  detectQwenAccess,
  findQwenModel,
  qwenModelsForAccess,
  type QwenAccess,
  type QwenModelInfo,
} from "./qwenModels.js";
import { sanitizeAnthropicMessages } from "../../translate/anthropicSanitize.js";
import { log } from "../../util/log.js";

type QwenTarget = ModelInfo & QwenModelInfo;

// Anthropic Messages surface. The same gateway exposes it under /apps/anthropic,
// so the URL is derived from whichever compatible-mode base is configured; a known
// deployment can always be pinned with QWEN_ANTHROPIC_BASE_URL.
const QWEN_COMPAT_SUFFIX = "/compatible-mode/v1";
const QWEN_ANTHROPIC_SUFFIX = "/apps/anthropic";

export function qwenAnthropicBaseUrl(apiKey: string, baseUrl: string): string {
  const override = (process.env.QWEN_ANTHROPIC_BASE_URL ?? "").trim();
  if (override) return override.replace(/\/+$/, "");
  const tokenPlan = /token-plan/i.test(baseUrl) || apiKey.startsWith("sk-sp");
  const base = baseUrl.includes(QWEN_COMPAT_SUFFIX)
    ? baseUrl
    : tokenPlan ? QWEN_TOKEN_PLAN_BASE_URL : QWEN_PAYG_BASE_URL;
  return base.replace(QWEN_COMPAT_SUFFIX, "").replace(/\/+$/, "") + QWEN_ANTHROPIC_SUFFIX;
}

// Gateway-wide compat: strip fields the OpenAI-compatible endpoint rejects.
function stripIncompatible(chat: ChatRequest): void {
  if (Array.isArray(chat.tools)) {
    for (const tool of chat.tools) {
      if (tool.function?.strict === null) delete tool.function.strict;
    }
  }
  for (const message of chat.messages) {
    if (message.role === "assistant" && message.content === null) delete message.content;
    // The placeholder exists for MiMo mixed-mode; Qwen reads real reasoning and
    // would be fed invented "thinking", so drop it here instead.
    if (message.role === "assistant" && message.reasoning_content === MIXED_MODE_REASONING_PLACEHOLDER) {
      delete message.reasoning_content;
    }
  }
  const systems = chat.messages.filter((m) => m.role === "system");
  if (systems.length > 1) {
    const merged = systems
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .filter(Boolean)
      .join("\n\n");
    chat.messages = [
      ...(merged ? [{ role: "system" as const, content: merged }] : []),
      ...chat.messages.filter((m) => m.role !== "system"),
    ];
  }
  // "auto" is the gateway default and some hosted models reject the explicit value.
  if (chat.tool_choice === "auto") delete chat.tool_choice;
}

// The gateway rejects a forced tool_choice ("required" or a bound function object)
// whenever thinking is enabled, and every model reachable here thinks by default.
// Omitting the field falls back to the gateway default "auto", which still lets the
// model call tools, so the request survives instead of dying on a 400.
function dropForcedToolChoice(chat: ChatRequest, target: QwenTarget | null, reason: string): void {
  const choice = chat.tool_choice;
  const forced = choice === "required" || (typeof choice === "object" && choice !== null);
  if (!forced) return;
  const label = choice === "required" ? "required" : "function";
  delete chat.tool_choice;
  log.warn("qwen: dropped tool_choice=" + label + " for " + (target?.id ?? chat.model) + " (" + reason + ")");
}

// Family-aware thinking control. The Qwen gateway shares one Chat Completions
// surface, but each vendor family exposes different reasoning knobs:
//   hybrid  -> enable_thinking true/false both honoured
//   always  -> thinking cannot be turned off (glm-5.3 400s on false)
//   none    -> model exposes no switch at all (MiniMax-M2.5, auto)
export function normalizeQwenBody(chat: ChatRequest, target: QwenTarget | null): void {
  stripIncompatible(chat);

  const control = target?.thinkingControl ?? "enable_thinking";
  const thinkingMode = target?.thinkingMode ?? "hybrid";

  if (control === "none") {
    delete chat.thinking;
    delete chat.enable_thinking;
    delete chat.reasoning_effort;
    delete chat.thinking_budget;
    dropForcedToolChoice(chat, target, "always-reasoning model exposes no thinking switch");
    return;
  }

  const requestedOff = chat.thinking?.type === "disabled";
  delete chat.thinking;
  delete chat.thinking_budget;

  if (thinkingMode === "always") {
    chat.enable_thinking = true;
  } else {
    chat.enable_thinking = !requestedOff;
  }

  if (chat.enable_thinking !== false) {
    dropForcedToolChoice(chat, target, "thinking mode rejects forced tool_choice");
  }

  const effort = chat.reasoning_effort;
  if (!effort) return;
  const map = target?.effortMap;
  if (!map) {
    // This family exposes no effort tiers; keep thinking state only.
    delete chat.reasoning_effort;
    return;
  }
  if (requestedOff && thinkingMode !== "always") {
    delete chat.reasoning_effort;
    return;
  }
  chat.reasoning_effort = map[effort] ?? map.high ?? map.max;
}

function targetFor(ctx: PreprocessCtx): QwenTarget | null {
  return findQwenModel(ctx.upstreamModel || "");
}

export const qwen: Provider = {
  id: "qwen",
  shortcut: "qwen",
  displayName: "Tongyi Qwen (Alibaba)",
  defaultBaseUrl: QWEN_PAYG_BASE_URL,
  baseUrlEnv: "QWEN_BASE_URL",
  envKeys: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"],
  defaultModel: "qwen3.8-max",
  builtinModels: qwenModelsForAccess(null),
  docsUrl: "https://platform.qianwenai.com/docs",

  detectFlags(apiKey, baseUrl) {
    return { access: detectQwenAccess({ baseUrl, apiKey }) };
  },
  inferBaseUrlFromKey(apiKey) {
    if (apiKey.startsWith("sk-sp")) return QWEN_TOKEN_PLAN_BASE_URL;
    if (apiKey.startsWith("sk-")) return QWEN_PAYG_BASE_URL;
    return null;
  },
  detectAccess(runtime) {
    return detectQwenAccess(runtime) as QwenAccess | null;
  },
  listModels(runtime) {
    return qwenModelsForAccess(detectQwenAccess(runtime)).filter((m) => m.hidden !== true);
  },
  resolveModel(clientModel) {
    return findQwenModel(clientModel);
  },
  preprocessResponses(req, ctx) {
    const chat = reqToChat(req, {
      forceParallelToolCalls: false,
      enableWebSearch: false,
      imageDropDir: ctx.dataDir,
      supportsImages: ctx.supportsImages,
      disableThinking: ctx.disableThinking,
      forceHighEffort: ctx.forceHighEffort,
      upstreamModel: ctx.upstreamModel,
    });
    normalizeQwenBody(chat, targetFor(ctx));
    return chat;
  },
  preprocessChat(req, ctx) {
    const out: ChatRequest = { ...req, messages: req.messages.slice() };
    if (ctx.disableThinking) out.thinking = { type: "disabled" };
    normalizeQwenBody(out, targetFor(ctx));
    return out;
  },
  supportsAnthropic: true,
  // These families are reachable through the Qwen gateway's Anthropic endpoint. The
  // prefixes decide routing only: the model id the client asked for is forwarded
  // unchanged, and anything this credential cannot buy fails upstream instead of
  // being quietly swapped for a model that can.
  // The deepseek-* family is deliberately absent: DeepSeek serves it directly, and two
  // providers claiming one prefix would make routing depend on iteration order.
  anthropicModelPrefixes: ["qwen", "glm", "kimi", "minimax", "auto"],
  resolveAnthropicBaseUrl: qwenAnthropicBaseUrl,
  preprocessMessages(req) {
    // image / document blocks nested in messages are rejected by this gateway, so
    // they become labelled text blocks and every drop is reported to the log.
    return sanitizeAnthropicMessages(req);
  },
  isTerminalError({ status, snippet }) {
    if (status !== 400) return false;
    return /model not exist|unsupported model|AccessDenied/i.test(snippet ?? "");
  },
  enhanceError({ status, snippet }) {
    const text = snippet || "";
    if (status === 403 && /AccessDenied\.Unpurchased|Access to model denied/i.test(text)) {
      return {
        code: "model_not_purchased",
        message:
          "该模型不在当前千问凭据的计费范围内：个人版 Token Plan 只含 qwen3.8-max/flash、qwen3.7-max/plus、qwen3.6-flash、glm-5.3/5.2、deepseek-v4 系列与 auto；kimi / MiniMax 需团队版 Token Plan 或按量付费 sk-ws Key。请在面板切换模型或改用按量付费凭据。",
      };
    }
    if (status === 404 && /model not found|does not exist/i.test(text)) {
      return {
        code: "model_not_found",
        message: "千问侧不存在该模型 ID。Token Plan 与按量付费清单不同，请用面板中的模型列表确认。",
      };
    }
    if (status === 400 && /reasoning_effort/i.test(text)) {
      return {
        code: "unsupported_reasoning_effort",
        message: "该模型不支持当前推理档位：Qwen 用 low/medium/xhigh，GLM/DeepSeek 用 high/max，glm-5.3 与 kimi-k3 用 low/high/max。",
      };
    }
    if (status === 400 && /enable_thinking/i.test(text)) {
      return {
        code: "thinking_cannot_disable",
        message: "该模型始终开启思考（glm-5.3 / kimi-k2.7-code / MiniMax-M2.5），无法传 enable_thinking=false。",
      };
    }
    if (status === 400 && /model not exist|unsupported model/i.test(text)) {
      return {
        code: "unsupported_model",
        message: "Qwen rejected this model id: " + text.slice(0, 200) +
          ". The proxy forwarded the id the client asked for; nothing was substituted.",
      };
    }
    return null;
  },
};